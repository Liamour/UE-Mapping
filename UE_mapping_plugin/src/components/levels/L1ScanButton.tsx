// "Run project scan" button surfaced inside the L1 views (both force-graph
// and markdown modes).  All state lives in useScanStore so the button keeps
// its progress / running / done indicators across tab switches and component
// remounts — without that, a user clicking through systems mid-scan would see
// the button reset to idle and might re-fire the same backend job.

import React, { useCallback } from 'react';
import { isDeepScanAvailable } from '../../services/bridgeApi';
import { type ProjectScanPhase } from '../../services/projectScan';
import { useVaultStore } from '../../store/useVaultStore';
import { useLLMStore } from '../../store/useLLMStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useScanStore } from '../../store/useScanStore';
import { useT, useLang } from '../../utils/i18n';

export const L1ScanButton: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const getProviderConfig = useLLMStore((s) => s.getProviderConfig);
  const llmReady = useLLMStore((s) => s.isReady());
  const llmProvider = useLLMStore((s) => s.provider);
  const navigate = useTabsStore((s) => s.navigateActive);

  const phase = useScanStore((s) => s.phase);
  const isRunning = useScanStore((s) => s.isRunning);
  const startScan = useScanStore((s) => s.start);
  const cancelScan = useScanStore((s) => s.cancel);

  // Bridge required for L2 (AST fingerprinting) but NOT for L1 (which reads
  // vault metadata via the backend HTTP API). When running in the Web UI dev
  // mode the bridge is absent — degrade to L1-only so the user can still
  // cluster a vault that already has L2 markdown written.
  const bridgeAvailable = isDeepScanAvailable();
  const scope = bridgeAvailable ? { l2: true, l1: true } : { l2: false, l1: true };
  const canRun = !!projectRoot && llmReady && !isRunning;

  const start = useCallback(async () => {
    if (!projectRoot) return;
    const providerConfig = getProviderConfig();
    if (!providerConfig) {
      // Surface this through the store too so the error persists across remounts.
      useScanStore.setState({
        phase: {
          kind: 'error',
          message: t({
            en: `${llmProvider} is not configured. Open Settings → LLM provider to add credentials.`,
            zh: `${llmProvider} 未配置。请打开 设置 → LLM 服务商 添加凭据。`,
          }),
          failures: [],
        },
      });
      return;
    }
    await startScan({
      projectRoot,
      providerConfig,
      scope,
      // Cache invalidation + index reload run inside useScanStore.start before
      // this hook fires — by the time we navigate, the overview file is fresh.
      onDone: async (final) => {
        if (final.l1Status?.status === 'COMPLETED') {
          navigate(
            { level: 'lv1', systemId: '_overview' },
            lang === 'zh' ? '项目总览' : 'Project Overview',
          );
        }
      },
    });
  }, [projectRoot, scope, getProviderConfig, llmProvider, navigate, startScan, t, lang]);

  const statusLine = renderStatus(phase, lang);
  const errorLine =
    phase.kind === 'error' ? phase.message :
    phase.kind === 'done' && phase.failures.length > 0
      ? t({
          en: `${phase.failures.length} failure(s) — see Settings → Run LLM analysis for details.`,
          zh: `${phase.failures.length} 个失败 — 详情见 设置 → 运行 LLM 分析。`,
        })
      : null;

  return (
    <div className="l1-scan-button">
      <button
        className="btn-primary"
        onClick={start}
        disabled={!canRun}
        title={
          !projectRoot
            ? t({ en: 'Set a project root in Settings first', zh: '请先在设置中配置项目根目录' })
            : !llmReady
            ? t({ en: `Configure ${llmProvider} in Settings first`, zh: `请先在设置中配置 ${llmProvider}` })
            : isRunning
            ? t({ en: 'A scan is already in progress', zh: '已有扫描在进行中' })
            : bridgeAvailable
            ? t({ en: 'Run L2 (per-blueprint) and L1 (project clustering) analysis', zh: '运行 L2（单蓝图）和 L1（项目聚类）分析' })
            : t({
                en: 'Bridge unavailable in Web UI — running L1 clustering only (L2 metadata must already exist in vault)',
                zh: 'Web UI 中桥接不可用 — 只运行 L1 聚类（vault 中必须已有 L2 元数据）',
              })
        }
      >
        {isRunning
          ? t({ en: 'Scanning…', zh: '扫描中…' })
          : bridgeAvailable
          ? t({ en: 'Run project scan', zh: '运行项目扫描' })
          : t({ en: 'Run L1 clustering', zh: '运行 L1 聚类' })}
      </button>
      {isRunning && <button className="btn-text" onClick={cancelScan}>{t({ en: 'Cancel', zh: '取消' })}</button>}
      {statusLine && (
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{statusLine}</span>
      )}
      {errorLine && (
        <span className="l1-scan-error" style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-risk-warning, #b07a3a)' }}>
          {errorLine}
        </span>
      )}
    </div>
  );
};

function renderStatus(phase: ProjectScanPhase, lang: 'en' | 'zh'): string | null {
  const zh = lang === 'zh';
  switch (phase.kind) {
    case 'idle': return null;
    case 'listing': return zh ? '正在列出蓝图…' : 'Listing blueprints…';
    case 'fingerprinting':
      return zh
        ? `AST 指纹生成中：${phase.done}/${phase.total}`
        : `Fingerprinting AST: ${phase.done}/${phase.total}`;
    case 'l2-submitting': return zh ? '正在提交 L2 批量任务…' : 'Submitting L2 batch…';
    case 'l2-scanning': {
      const s = phase.status;
      const finished = s.completed_nodes + s.failed_nodes + s.skipped_nodes;
      return zh
        ? `L2 ${finished}/${s.total_nodes}（完成 ${s.completed_nodes} · 跳过 ${s.skipped_nodes}）`
        : `L2 ${finished}/${s.total_nodes} (${s.completed_nodes} done · ${s.skipped_nodes} skipped)`;
    }
    case 'l1-submitting': return zh ? '正在提交 L1 聚类…' : 'Submitting L1 clustering…';
    case 'l1-scanning':
      return zh
        ? `L1 正在聚类 ${phase.status.total_nodes} 个蓝图（LLM，约 30–90 秒）…`
        : `L1 clustering ${phase.status.total_nodes} blueprints (LLM, ~30–90s)…`;
    case 'done': {
      const l1ok = phase.l1Status?.status === 'COMPLETED';
      const l2 = phase.l2Status;
      const l2bits = l2 && l2.total_nodes > 0
        ? (zh
            ? `更新 ${l2.completed_nodes} · 跳过 ${l2.skipped_nodes}`
            : `${l2.completed_nodes} updated · ${l2.skipped_nodes} skipped`)
        : (zh ? 'vault 已是最新' : 'vault up to date');
      if (l1ok) {
        return zh ? `完成 · ${l2bits} · L1 总览已写入` : `Done · ${l2bits} · L1 overview written`;
      }
      return zh ? `完成 · ${l2bits}` : `Done · ${l2bits}`;
    }
    case 'error': return null;
  }
}
