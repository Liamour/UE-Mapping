// LLM scan wizard surfaced inside SettingsModal.  Pairs with the (cheaper,
// AST-only) FrameworkScanPanel — that one writes the .md scaffolding, this
// one enriches it with LLM-derived intent / tags / risk and (optionally) runs
// the L1 project clustering pass on top.
//
// The orchestration logic lives in services/projectScan.ts so the L1 view's
// "Run project scan" button can share the exact same state machine.
import React, { useCallback, useMemo, useState } from 'react';
import { isDeepScanAvailable } from '../../services/bridgeApi';
import { type ProjectScanPhase } from '../../services/projectScan';
import { useVaultStore } from '../../store/useVaultStore';
import { useLLMStore } from '../../store/useLLMStore';
import { useScanStore } from '../../store/useScanStore';
import { useT } from '../../utils/i18n';

type Scope = { l2: boolean; l1: boolean };

export const ScanOrchestrator: React.FC = () => {
  const t = useT();
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const getProviderConfig = useLLMStore((s) => s.getProviderConfig);
  const llmProvider = useLLMStore((s) => s.provider);
  const llmReady = useLLMStore((s) => s.isReady());

  // Scan state lives in useScanStore so this panel and the L1ScanButton both
  // see the same in-flight job — closing Settings mid-scan no longer "loses"
  // progress, and a second click can't fire a duplicate run.
  const phase = useScanStore((s) => s.phase);
  const isRunning = useScanStore((s) => s.isRunning);
  const startScan = useScanStore((s) => s.start);
  const cancelScan = useScanStore((s) => s.cancel);

  // Bridge is needed for L2 (AST extraction) but not for L1. Hidden from the
  // scope picker when missing — useful in the Web UI dev environment.
  const bridgeAvailable = useMemo(() => isDeepScanAvailable(), []);
  const [scope, setScope] = useState<Scope>({ l2: bridgeAvailable, l1: true });

  const canRun =
    !!projectRoot && llmReady && (scope.l2 || scope.l1) && !isRunning;

  const start = useCallback(async () => {
    if (!projectRoot) return;
    const providerConfig = getProviderConfig();
    if (!providerConfig) {
      useScanStore.setState({
        phase: {
          kind: 'error',
          message: t({
            en: `${llmProvider} is not configured. Open the LLM provider section above to add credentials.`,
            zh: `${llmProvider} 未配置。请展开上方 LLM 服务商区域添加凭据。`,
          }),
          failures: [],
        },
      });
      return;
    }
    // Cache invalidation + index reload happen inside useScanStore.start
    // on completion — Settings panel doesn't need a per-call hook.
    await startScan({ projectRoot, providerConfig, scope });
  }, [projectRoot, scope, getProviderConfig, llmProvider, startScan, t]);

  return (
    <div className="scan-orchestrator">
      <div className="scan-categories">
        <span className="scan-categories-label">{t({ en: 'Scope:', zh: '范围：' })}</span>
        <label
          className="scan-category-chk"
          title={bridgeAvailable ? '' : t({
            en: 'L2 requires the C++ plugin bridge — only available inside the UE editor host.',
            zh: 'L2 需要 C++ 插件桥接 — 仅在 UE 编辑器宿主中可用。',
          })}
        >
          <input
            type="checkbox"
            checked={scope.l2}
            onChange={() => setScope((s) => ({ ...s, l2: !s.l2 }))}
            disabled={isRunning || !bridgeAvailable}
          />
          {t({ en: 'L2 — per-blueprint analysis', zh: 'L2 — 单蓝图分析' })}
          {!bridgeAvailable && t({ en: ' (bridge unavailable)', zh: '（桥接不可用）' })}
        </label>
        <label className="scan-category-chk">
          <input
            type="checkbox"
            checked={scope.l1}
            onChange={() => setScope((s) => ({ ...s, l1: !s.l1 }))}
            disabled={isRunning}
          />
          {t({ en: 'L1 — project clustering', zh: 'L1 — 项目聚类' })}
        </label>
      </div>
      <div className="scan-orchestrator-actions">
        <button
          className="btn-primary"
          onClick={start}
          disabled={!canRun}
          title={
            !projectRoot
              ? t({ en: 'Set a project root first', zh: '请先设置项目根目录' })
              : !llmReady
              ? t({ en: `Configure ${llmProvider} above first`, zh: `请先在上方配置 ${llmProvider}` })
              : !scope.l2 && !scope.l1
              ? t({ en: 'Select at least one scope (L2 or L1)', zh: '请至少选择一个范围（L2 或 L1）' })
              : t({
                  en: 'Run the LLM analysis pipeline: L2 enriches per-blueprint markdown, L1 clusters the whole project into systems.',
                  zh: '运行 LLM 分析流水线：L2 丰富每个蓝图的 markdown，L1 将整个项目聚类为系统。',
                })
          }
        >
          {t({ en: 'Run LLM analysis', zh: '运行 LLM 分析' })}
        </button>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {llmReady
            ? t({ en: `via ${llmProvider}`, zh: `使用 ${llmProvider}` })
            : t({ en: `${llmProvider} not configured`, zh: `${llmProvider} 未配置` })}
        </span>
        {isRunning && <button className="btn-text" onClick={cancelScan}>{t({ en: 'Cancel', zh: '取消' })}</button>}
      </div>
      <PhaseView phase={phase} />
    </div>
  );
};

// ── Phase rendering ────────────────────────────────────────────────────────

const PhaseView: React.FC<{ phase: ProjectScanPhase }> = ({ phase }) => {
  const t = useT();
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'listing':
      return <div className="settings-status">{t({ en: 'Listing Blueprints from /Game/…', zh: '正在列出 /Game/ 下的蓝图…' })}</div>;
    case 'fingerprinting': {
      const pct = phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100);
      return (
        <div className="settings-status">
          <div>{t({ en: `Fingerprinting AST: ${phase.done} / ${phase.total}`, zh: `AST 指纹生成中：${phase.done} / ${phase.total}` })}</div>
          <ProgressBar pct={pct} />
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'l2-submitting':
      return <div className="settings-status">{t({ en: 'Submitting L2 batch to backend…', zh: '正在提交 L2 批量任务到后端…' })}</div>;
    case 'l2-scanning': {
      const total = phase.status.total_nodes || 1;
      const finished =
        phase.status.completed_nodes + phase.status.failed_nodes + phase.status.skipped_nodes;
      const pct = Math.round((finished / total) * 100);
      return (
        <div className="settings-status">
          <div>
            {t({ en: 'L2 per-blueprint:', zh: 'L2 单蓝图：' })} {finished} / {total}{' '}
            <span className="muted">
              ({phase.status.completed_nodes} {t({ en: 'done', zh: '完成' })} · {phase.status.skipped_nodes} {t({ en: 'skipped', zh: '跳过' })} · {phase.status.failed_nodes} {t({ en: 'failed', zh: '失败' })})
            </span>
          </div>
          <ProgressBar pct={pct} />
          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {t({ en: 'task:', zh: '任务：' })} <code>{phase.status.task_id}</code>
          </div>
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'l1-submitting':
      return <div className="settings-status">{t({ en: 'Submitting L1 clustering request…', zh: '正在提交 L1 聚类请求…' })}</div>;
    case 'l1-scanning': {
      const s = phase.status;
      const finished = s.completed_nodes + s.failed_nodes;
      // L1 is a single task; show indeterminate-ish progress.
      const pct = s.status === 'COMPLETED' ? 100 : finished > 0 ? 100 : 50;
      return (
        <div className="settings-status">
          <div>
            {t({
              en: `L1 clustering (${s.total_nodes} blueprint${s.total_nodes === 1 ? '' : 's'} → systems)…`,
              zh: `L1 聚类中（${s.total_nodes} 个蓝图 → 系统）…`,
            })}
          </div>
          <ProgressBar pct={pct} />
          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {t({ en: 'task:', zh: '任务：' })} <code>{s.task_id}</code>
          </div>
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'done': {
      const l2 = phase.l2Status;
      const l1 = phase.l1Status;
      const parts: string[] = [];
      if (l2) {
        if (phase.submitted === 0) {
          parts.push(t({ en: 'L2: nothing to scan (vault up to date).', zh: 'L2：无需扫描（vault 已是最新）。' }));
        } else {
          parts.push(t({
            en: `L2: wrote ${l2.completed_nodes} · ${l2.skipped_nodes} skipped · ${l2.failed_nodes} failed`,
            zh: `L2：写入 ${l2.completed_nodes} 个 · 跳过 ${l2.skipped_nodes} 个 · 失败 ${l2.failed_nodes} 个`,
          }));
        }
      }
      if (l1) {
        parts.push(
          l1.status === 'COMPLETED'
            ? t({ en: 'L1: project clustering complete.', zh: 'L1：项目聚类完成。' })
            : t({ en: `L1: ${l1.status.toLowerCase()}.`, zh: `L1：${l1.status.toLowerCase()}。` }),
        );
      }
      return (
        <div className="settings-status">
          {parts.map((p, i) => <div key={i}>{p}</div>)}
          <FailureList failures={phase.failures} />
        </div>
      );
    }
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

const FailureList: React.FC<{ failures: { asset_path: string; reason: string }[] }> = ({ failures }) => {
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
