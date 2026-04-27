import React, { useEffect, useState } from 'react';
import { askAI, type ChatTurn } from '../../services/chatApi';
import { checkBackendHealth } from '../../services/vaultApi';
import { isBridgeAvailable } from '../../services/bridgeApi';
import { useTabsStore } from '../../store/useTabsStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useT } from '../../utils/i18n';

type BackendStatus = 'checking' | 'online' | 'offline';

export const AIChat: React.FC = () => {
  const t = useT();
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
        text: t({
          en: `Error: ${e instanceof Error ? e.message : String(e)}`,
          zh: `错误：${e instanceof Error ? e.message : String(e)}`,
        }),
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
        <span>{t({ en: 'AI', zh: 'AI' })}</span>
        {contextFile && (
          <span className="muted aichat-context">
            {t({ en: 're:', zh: '关于：' })} {(contextFile.frontmatter.title as string) ?? activeTab?.title}
          </span>
        )}
      </div>
      <div className="aichat-log">
        {turns.length === 0 && backend === 'checking' && (
          <div className="aichat-empty muted">{t({ en: 'Checking backend…', zh: '正在检测后端…' })}</div>
        )}
        {turns.length === 0 && backend === 'online' && (
          <div className="aichat-empty muted">
            {t({
              en: 'Ask anything about the current node. Try: "What does this listen for?", "Where is the spawn pipeline?"',
              zh: '可以提任何关于当前节点的问题。例如："这个节点监听了什么？"、"spawn 流水线在哪里？"',
            })}
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className={`aichat-turn aichat-${turn.role}`}>
            <div className="aichat-turn-role">{turn.role === 'user' ? t({ en: 'You', zh: '你' }) : t({ en: 'AI', zh: 'AI' })}</div>
            <div className="aichat-turn-body">{turn.text}</div>
          </div>
        ))}
        {busy && (
          <div className="aichat-turn aichat-assistant">
            <div className="aichat-turn-role">{t({ en: 'AI', zh: 'AI' })}</div>
            <div className="aichat-turn-body muted">{t({ en: '…thinking', zh: '…思考中' })}</div>
          </div>
        )}
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
          placeholder={backend === 'checking'
            ? t({ en: 'Checking backend…', zh: '正在检测后端…' })
            : t({ en: 'Ask AI… (Ctrl+Enter to send)', zh: '提问 AI…（Ctrl+Enter 发送）' })}
          disabled={inputDisabled}
        />
        <button className="btn-primary" disabled={inputDisabled || !input.trim()} onClick={onSend}>
          {t({ en: 'Send', zh: '发送' })}
        </button>
      </div>
    </div>
  );
};

const BackendOfflineCard: React.FC<{ onRetry: () => void; bridgeMode: boolean }> = ({ onRetry, bridgeMode }) => {
  const t = useT();
  return (
    <div className="aichat aichat-offline">
      <div className="aichat-offline-card">
        <div className="aichat-offline-title">{t({ en: 'AI Chat needs the Python backend', zh: 'AI 对话需要 Python 后端' })}</div>
        <p className="muted">
          {bridgeMode
            ? t({
                en: 'Vault read/write is running through the UE editor bridge, but AI Chat still calls the LLM via the Python backend on http://localhost:8000.',
                zh: 'Vault 的读写已通过 UE 编辑器桥接运行，但 AI 对话仍需通过 http://localhost:8000 的 Python 后端调用 LLM。',
              })
            : t({
                en: 'Backend at http://localhost:8000 is not responding.',
                zh: 'http://localhost:8000 后端无响应。',
              })}
        </p>
        <p className="muted aichat-offline-hint" dangerouslySetInnerHTML={{
          __html: t({
            en: 'Start it with <code>uvicorn main:app --reload</code> in the <code>backend/</code> directory, then retry.',
            zh: '请在 <code>backend/</code> 目录下运行 <code>uvicorn main:app --reload</code> 启动后端后重试。',
          }),
        }} />
        <button className="btn-primary" onClick={onRetry}>{t({ en: 'Retry connection', zh: '重试连接' })}</button>
      </div>
    </div>
  );
};
