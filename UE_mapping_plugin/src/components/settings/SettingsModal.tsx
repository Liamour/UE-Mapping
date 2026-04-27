import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { rebuildBacklinks, checkBackendHealth } from '../../services/vaultApi';
import { getBridgeStatus, getCandidateGlobals, isBridgeAvailable, isDeepScanAvailable, isVaultFileWriteAvailable } from '../../services/bridgeApi';
import { rebuildSystemMOCs } from '../../services/mocGenerator';
import { ScanOrchestrator } from './ScanOrchestrator';

export const SettingsModal: React.FC = () => {
  const open = useUIStore((s) => s.settingsOpen);
  const close = () => useUIStore.getState().setSettingsOpen(false);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const setProjectRoot = useVaultStore((s) => s.setProjectRoot);
  const loadIndex = useVaultStore((s) => s.loadIndex);

  const [draft, setDraft] = useState(projectRoot);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Backend-only ops (Ping, Rebuild backlinks) are hidden when the C++ bridge
  // is providing vault FS — those features still need the Python backend.
  const onBridge = isBridgeAvailable();

  React.useEffect(() => {
    if (open) {
      setDraft(projectRoot);
      setStatus(null);
    }
  }, [open, projectRoot]);

  if (!open) return null;

  const onSave = async () => {
    setBusy(true);
    setStatus(null);
    setProjectRoot(draft.trim());
    try {
      await loadIndex();
      setStatus('Vault loaded.');
    } catch (e) {
      setStatus(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onRebuild = async () => {
    if (!projectRoot) return;
    setBusy(true);
    setStatus(null);
    try {
      await rebuildBacklinks(projectRoot);
      await loadIndex();
      setStatus('Backlinks rebuilt.');
    } catch (e) {
      setStatus(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onPing = async () => {
    setBusy(true);
    setStatus(null);
    const h = await checkBackendHealth();
    if (!h) setStatus('Backend unreachable on http://localhost:8000');
    else setStatus(`Backend ${h.version} — Redis: ${h.redis_available ? 'available' : 'offline'}`);
    setBusy(false);
  };

  const onRebuildMOCs = async () => {
    if (!projectRoot) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await rebuildSystemMOCs(projectRoot);
      const summary = result.systems.length === 0
        ? 'No system tags found — nothing to write.'
        : `Wrote ${result.systems.length} MOC(s): ${result.systems.map((s) => `${s.systemId} (${s.entryCount})`).join(', ')}`;
      setStatus(summary + (result.unassignedCount > 0 ? ` · ${result.unassignedCount} unassigned node(s) skipped.` : ''));
      await loadIndex();
    } catch (e) {
      setStatus(`MOC rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const mocAvailable = isVaultFileWriteAvailable();
  const scanAvailable = isDeepScanAvailable() && !!projectRoot;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="iconbtn" onClick={close}>×</button>
        </div>
        <div className="modal-body">
          <section className="settings-section">
            <h3>Project root</h3>
            <p className="muted">Absolute path to your UE project (the folder that contains <code>.aicartographer/vault</code>).</p>
            <input
              className="settings-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. D:/MyGame"
            />
            <div className="settings-actions">
              <button className="btn-primary" onClick={onSave} disabled={busy}>Save & load vault</button>
              {!onBridge && (
                <>
                  <button className="btn-text" onClick={onPing} disabled={busy}>Ping backend</button>
                  <button className="btn-text" onClick={onRebuild} disabled={busy || !projectRoot}>Rebuild backlinks</button>
                </>
              )}
              {mocAvailable && (
                <button
                  className="btn-text"
                  onClick={onRebuildMOCs}
                  disabled={busy || !projectRoot}
                  title="Aggregate every node by `system/X` tag into _systems/X.md"
                >Rebuild MOCs</button>
              )}
            </div>
            {onBridge && (
              <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 8 }}>
                Backend operations (ping, rebuild backlinks, LLM scan) hidden in bridge mode. Start the
                Python backend to access them — they will reappear automatically.
              </p>
            )}
            {status && <div className="settings-status">{status}</div>}
          </section>
          {scanAvailable && (
            <section className="settings-section">
              <h3>Project scan</h3>
              <p className="muted">
                Walks every Blueprint under <code>/Game/</code>, fingerprints its AST via the C++ bridge,
                then ships changed assets to the backend LLM pipeline. Requires <code>uvicorn</code> + Redis running.
              </p>
              <ScanOrchestrator />
            </section>
          )}
          <section className="settings-section">
            <h3>Vault transport</h3>
            <BridgeStatusLine />
          </section>
          <section className="settings-section">
            <h3>API key</h3>
            <p className="muted">
              Volcengine API key is configured server-side via <code>OPENAI_API_KEY</code>. Edit
              your backend <code>.env</code> and restart uvicorn — the frontend never holds the key.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};

const BridgeStatusLine: React.FC = () => {
  const status = getBridgeStatus();
  const globals = getCandidateGlobals();
  if (status.kind === 'ready') {
    return (
      <div>
        <p className="muted">
          Connected via UE editor bridge — vault file I/O runs through the C++ plugin (no Python backend required for read/write).
        </p>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          <code>{status.path}</code>
        </p>
        <details className="settings-debug">
          <summary>Bridge methods ({status.methods.length})</summary>
          <pre className="settings-debug-pre">{status.methods.join('\n')}</pre>
        </details>
      </div>
    );
  }
  if (status.kind === 'partial') {
    return (
      <div>
        <p className="muted">
          <strong>UE editor bridge present but vault FS methods are missing.</strong> The C++ plugin
          binary is out of date — Live Coding cannot register new <code>UFUNCTION</code>s. Close UE,
          rebuild the AICartographer module from VS / Rider, then relaunch the editor.
        </p>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          Found at: <code>{status.path}</code>
        </p>
        <details className="settings-debug">
          <summary>Bridge methods ({status.methods.length})</summary>
          <pre className="settings-debug-pre">{status.methods.join('\n') || '(none — binding may have failed)'}</pre>
        </details>
      </div>
    );
  }
  return (
    <div>
      <p className="muted">
        Bridge not found at any known path — using HTTP backend at localhost:8000.
      </p>
      <details className="settings-debug" open>
        <summary>Window globals visible to JS ({globals.length}) — paste this back so we can locate the bridge</summary>
        <pre className="settings-debug-pre">{globals.join('\n') || '(empty)'}</pre>
      </details>
    </div>
  );
};
