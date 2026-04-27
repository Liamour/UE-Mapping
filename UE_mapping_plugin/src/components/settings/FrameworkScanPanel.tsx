// Phase 1 framework scan UI — surfaces inside SettingsModal next to the
// (older) LLM-driven ScanOrchestrator.  This one is pure AST: it lists every
// Blueprint, fingerprints them via the C++ bridge, and writes skeleton .md
// files into the vault. No backend, no Redis, no LLM key required.
//
// After this runs, the LeftPane and Lv1 force graph immediately show the
// project structure.  Users can then run the LLM scan (category-filtered) or
// per-node "Deep reasoning" to enrich specific entries.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { isDeepScanAvailable, isVaultFileWriteAvailable } from '../../services/bridgeApi';
import { runFrameworkScan, type FrameworkScanProgress, type FrameworkScanFailure } from '../../services/frameworkScan';
import { useVaultStore } from '../../store/useVaultStore';
import { useT } from '../../utils/i18n';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: FrameworkScanProgress }
  | { kind: 'done'; total: number; written: number; failures: FrameworkScanFailure[] }
  | { kind: 'error'; message: string; failures: FrameworkScanFailure[] };

export const FrameworkScanPanel: React.FC = () => {
  const t = useT();
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const available = useMemo(
    () => isDeepScanAvailable() && isVaultFileWriteAvailable(),
    [],
  );
  const canRun =
    available && !!projectRoot &&
    (phase.kind === 'idle' || phase.kind === 'done' || phase.kind === 'error');

  const start = useCallback(async () => {
    if (!projectRoot) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase({ kind: 'running', progress: { phase: 'listing', done: 0, total: 0 } });
    try {
      const result = await runFrameworkScan(projectRoot, {
        signal: abort.signal,
        onProgress: (progress) => setPhase({ kind: 'running', progress }),
      });
      try { await loadIndex(); } catch (e) { console.warn('[framework-scan] loadIndex failed', e); }
      setPhase({
        kind: 'done',
        total: result.total,
        written: result.written,
        failures: result.failures,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'error', message: formatError(e), failures: [] });
    } finally {
      abortRef.current = null;
    }
  }, [projectRoot, loadIndex]);

  const cancel = () => abortRef.current?.abort();

  if (!available) return null;

  return (
    <div className="scan-orchestrator">
      <div className="scan-orchestrator-actions">
        <button
          className="btn-primary"
          onClick={start}
          disabled={!canRun}
          title={t({
            en: "Walk /Game/, extract every BP's AST, and write skeleton .md files. No LLM, no backend required.",
            zh: '遍历 /Game/，提取每个蓝图的 AST，写入骨架 .md 文件。无需 LLM，无需后端。',
          })}
        >
          {t({ en: 'Scan project structure', zh: '扫描项目结构' })}
        </button>
        {phase.kind === 'running' && (
          <button className="btn-text" onClick={cancel}>{t({ en: 'Cancel', zh: '取消' })}</button>
        )}
      </div>
      <PhaseView phase={phase} />
    </div>
  );
};

const PhaseView: React.FC<{ phase: Phase }> = ({ phase }) => {
  const t = useT();
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'running': {
      const p = phase.progress;
      const label = p.phase === 'listing'
        ? t({ en: 'Listing Blueprints from /Game/…', zh: '正在列出 /Game/ 下的蓝图…' })
        : p.phase === 'fingerprinting'
        ? t({ en: `Extracting AST: ${p.done} / ${p.total}`, zh: `提取 AST：${p.done} / ${p.total}` })
        : p.phase === 'writing'
        ? t({ en: `Writing skeleton .md: ${p.done} / ${p.total}`, zh: `写入骨架 .md：${p.done} / ${p.total}` })
        : t({ en: 'Done.', zh: '完成。' });
      const pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
      return (
        <div className="settings-status">
          <div>{label}</div>
          {p.phase !== 'listing' && <ProgressBar pct={pct} />}
        </div>
      );
    }
    case 'done':
      return (
        <div className="settings-status">
          <div>
            {t({
              en: `Wrote ${phase.written} skeleton file(s) from ${phase.total} Blueprint(s).`,
              zh: `已从 ${phase.total} 个蓝图写入 ${phase.written} 个骨架文件。`,
            })}
            {phase.failures.length > 0 && t({
              en: ` · ${phase.failures.length} failed.`,
              zh: ` · ${phase.failures.length} 个失败。`,
            })}
          </div>
          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {t({
              en: 'Open the file tree or the L1 graph to navigate. Run "Deep reasoning" on a node to enrich it with LLM analysis.',
              zh: '打开文件树或 L1 力向图开始浏览。在某个节点上点击 "Deep reasoning" 即可用 LLM 进一步丰富它。',
            })}
          </div>
          <FailureList failures={phase.failures} />
        </div>
      );
    case 'error':
      return (
        <div className="settings-status settings-status-error">
          <div>{phase.message}</div>
          <FailureList failures={phase.failures} />
        </div>
      );
  }
};

const ProgressBar: React.FC<{ pct: number }> = ({ pct }) => (
  <div className="scan-progress">
    <div className="scan-progress-fill" style={{ width: `${pct}%` }} />
  </div>
);

const FailureList: React.FC<{ failures: FrameworkScanFailure[] }> = ({ failures }) => {
  const t = useT();
  if (failures.length === 0) return null;
  return (
    <details className="scan-failures">
      <summary>{t({ en: `${failures.length} failure(s)`, zh: `${failures.length} 个失败` })}</summary>
      <ul>
        {failures.map((f) => (
          <li key={f.asset_path}>
            <code>{f.asset_path}</code> — {f.reason}
          </li>
        ))}
      </ul>
    </details>
  );
};

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
