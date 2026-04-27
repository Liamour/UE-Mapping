import React, { useEffect, useState } from 'react';
import { askAI, type ChatTurn } from '../../services/chatApi';
import { checkBackendHealth } from '../../services/vaultApi';
import { isBridgeAvailable } from '../../services/bridgeApi';
import { useTabsStore } from '../../store/useTabsStore';
import { useVaultStore } from '../../store/useVaultStore';

type BackendStatus = 'checking' | 'online' | 'offline';

export const AIChat: React.FC = () => {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState<BackendStatus>('checking');
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const fileCache = useVaultStore((s) => s.fileCache);

  const contextFile = activeTab?.location.relativePath
    ? fileCache[activeTab.location.relativePath]
    : undefined;

  const probeBackend = async () => {
    setBackend('checking');
    const h = await checkBackendHealth();
    setBackend(h ? 'online' : 'offline');
  };

  useEffect(() => {
    probeBackend();
  }, []);

  const onSend = async () => {
    if (!input.trim() || busy) return;
    const q = input.trim();
    const userTurn: ChatTurn = { role: 'user', text: q, ts: Date.now() };
    setTurns((prev) => [...prev, userTurn]);
    setInput('');
    setBusy(true);
    try {
      const answer = await askAI({
        question: q,
        contextNodeTitle: (contextFile?.frontmatter.title as string) ?? activeTab?.title,
        contextSnippet: contextFile?.aiSection?.slice(0, 2000),
      });
      setTurns((prev) => [...prev, { role: 'assistant', text: answer, ts: Date.now() }]);
    } catch (e) {
      // A failed send is the strongest signal the backend has gone away — flip
      // the gate so the user sees the offline card instead of a raw error.
      setBackend('offline');
      setTurns((prev) => [...prev, {
        role: 'assistant',
        text: `Error: ${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now(),
      }]);
    } finally {
      setBusy(false);
    }
  };

  if (backend === 'offline') {
    return <BackendOfflineCard onRetry={probeBackend} bridgeMode={isBridgeAvailable()} />;
  }

  const inputDisabled = busy || backend === 'checking';

  return (
    <div className="aichat">
      <div className="aichat-header">
        <span>AI</span>
        {contextFile && (
          <span className="muted aichat-context">
            re: {(contextFile.frontmatter.title as string) ?? activeTab?.title}
          </span>
        )}
      </div>
      <div className="aichat-log">
        {turns.length === 0 && backend === 'checking' && (
          <div className="aichat-empty muted">Checking backend…</div>
        )}
        {turns.length === 0 && backend === 'online' && (
          <div className="aichat-empty muted">
            Ask anything about the current node. Try: <em>"What does this listen for?"</em>, <em>"Where is the spawn pipeline?"</em>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`aichat-turn aichat-${t.role}`}>
            <div className="aichat-turn-role">{t.role === 'user' ? 'You' : 'AI'}</div>
            <div className="aichat-turn-body">{t.text}</div>
          </div>
        ))}
        {busy && <div className="aichat-turn aichat-assistant"><div className="aichat-turn-role">AI</div><div className="aichat-turn-body muted">…thinking</div></div>}
      </div>
      <div className="aichat-input">
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={backend === 'checking' ? 'Checking backend…' : 'Ask AI… (Ctrl+Enter to send)'}
          disabled={inputDisabled}
        />
        <button className="btn-primary" disabled={inputDisabled || !input.trim()} onClick={onSend}>Send</button>
      </div>
    </div>
  );
};

const BackendOfflineCard: React.FC<{ onRetry: () => void; bridgeMode: boolean }> = ({ onRetry, bridgeMode }) => (
  <div className="aichat aichat-offline">
    <div className="aichat-offline-card">
      <div className="aichat-offline-title">AI Chat needs the Python backend</div>
      <p className="muted">
        {bridgeMode
          ? 'Vault read/write is running through the UE editor bridge, but AI Chat still calls the LLM via the Python backend on http://localhost:8000.'
          : 'Backend at http://localhost:8000 is not responding.'}
      </p>
      <p className="muted aichat-offline-hint">
        Start it with <code>uvicorn main:app --reload</code> in the <code>backend/</code> directory, then retry.
      </p>
      <button className="btn-primary" onClick={onRetry}>Retry connection</button>
    </div>
  </div>
);
