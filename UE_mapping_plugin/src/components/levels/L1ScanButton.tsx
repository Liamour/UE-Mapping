// Lv1 page button — "Analyze this system" (Phase 2 refactor).
//
// Pre-Phase-2 this was "Run project scan" (full L2 batch + project-wide L1
// clustering).  After the refactor the entry points decouple:
//   - Settings → "Run LLM analysis"  : batch L2 + batch L1
//   - Lv1 page button                 : single-system L1 only (this file)
//   - Lv2 page "Deep reasoning"       : single-BP L2 only
//
// This button therefore takes the active `systemId` and runs L1 scoped to it
// — no L2 step, one LLM call, one Systems/<id>.md updated.  Avoids burning
// tokens on every other system when the user just wants to refresh one.
//
// All scan state lives in useScanStore so progress survives tab switches and
// remounts (otherwise navigating between systems mid-scan would reset the
// button to idle and the user could re-fire the same backend job).
//
// Disabled when systemId is missing or "_overview" (the synthetic project
// overview view has no single system to scope to — use Settings for batch).

import React, { useCallback } from 'react';
import { useVaultStore } from '../../store/useVaultStore';
import { useLLMStore } from '../../store/useLLMStore';
import { useScanStore } from '../../store/useScanStore';
import { type ProjectScanPhase } from '../../services/projectScan';
import { useT, useLang } from '../../utils/i18n';

interface Props {
  systemId: string;
}

export const L1ScanButton: React.FC<Props> = ({ systemId }) => {
  const t = useT();
  const lang = useLang();
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const getProviderConfig = useLLMStore((s) => s.getProviderConfig);
  const llmReady = useLLMStore((s) => s.isReady());
  const llmProvider = useLLMStore((s) => s.provider);

  const phase = useScanStore((s) => s.phase);
  const isRunning = useScanStore((s) => s.isRunning);
  const startScan = useScanStore((s) => s.start);
  const cancelScan = useScanStore((s) => s.cancel);

  // Single-system L1 mode: skip L2 entirely (the user already has the per-BP
  // metadata; this button only refreshes the system-level narrative).
  const scope = { l2: false, l1: true };
  const isOverview = systemId === '_overview' || !systemId;
  const canRun = !!projectRoot && llmReady && !isRunning && !isOverview;

  const start = useCallback(async () => {
    if (!projectRoot || isOverview) return;
    const providerConfig = getProviderConfig();
    if (!providerConfig) {
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
      systemId,
      // No post-done navigation — we're already on the system's Lv1 page.
      // The store's loadIndex + cache invalidation refreshes the view in
      // place when the new Systems/<id>.md lands.
    });
  }, [projectRoot, scope, systemId, isOverview, getProviderConfig, llmProvider, startScan, t]);

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
            : isOverview
            ? t({
                en: 'Project overview has no single system — use Settings → Run LLM analysis to batch all systems.',
                zh: '项目总览没有单一系统可分析 — 请在 设置 → 运行 LLM 分析 中批量分析所有系统。',
              })
            : isRunning
            ? t({ en: 'A scan is already in progress', zh: '已有扫描在进行中' })
            : t({
                en: `Re-run L1 analysis for the "${systemId}" system (single LLM call, updates Systems/${systemId}.md).`,
                zh: `重新运行此系统（"${systemId}"）的 L1 分析（单次 LLM 调用，更新 Systems/${systemId}.md）。`,
              })
        }
      >
        {isRunning
          ? t({ en: 'Analysing…', zh: '分析中…' })
          : t({ en: 'Analyse this system', zh: '分析此系统' })}
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
    case 'l1-submitting': return zh ? '正在提交 L1 分析…' : 'Submitting L1 analysis…';
    case 'l1-scanning':
      // total_nodes = 1 in single-system mode; the per-system worker reports
      // immediate transitions from PROCESSING → COMPLETED so this phase is
      // brief.  Keep the message short.
      return zh
        ? `L1 分析中（约 30–60 秒）…`
        : `L1 analysing (~30–60s)…`;
    case 'done': {
      const l1 = phase.l1Status;
      const l2 = phase.l2Status;
      const l2bits = l2 && l2.total_nodes > 0
        ? (zh
            ? `更新 ${l2.completed_nodes} · 跳过 ${l2.skipped_nodes}`
            : `${l2.completed_nodes} updated · ${l2.skipped_nodes} skipped`)
        : null;  // L2 didn't run in single-system mode — don't claim "vault up to date"
      if (l1?.status === 'COMPLETED') {
        // Distinguish single-system vs batch by the number of nodes the
        // worker reported.  Single-system mode = 1; batch reports the
        // number of discovered system tags.  Misclaiming "this system L1
        // updated" after a batch run misled users on Cropout: the batch
        // skipped systems whose tags weren't in any BP frontmatter.
        const isSingleSystem = l1.total_nodes === 1;
        if (isSingleSystem) {
          return zh ? `完成 · 此系统的 L1 已更新` : `Done · this system's L1 written`;
        }
        return zh
          ? `完成 · 已分析 ${l1.completed_nodes} 个系统${l2bits ? ' · ' + l2bits : ''}`
          : `Done · ${l1.completed_nodes} system(s) analysed${l2bits ? ' · ' + l2bits : ''}`;
      }
      if (l1?.status === 'PARTIAL_FAIL') {
        return zh
          ? `部分完成 · 成功 ${l1.completed_nodes} · 失败 ${l1.failed_nodes}`
          : `Partial · ${l1.completed_nodes} ok · ${l1.failed_nodes} failed`;
      }
      // L1 did NOT complete (failed or cancelled).  l2bits may be null if
      // L2 was skipped; fall back to a generic "done" message in that case.
      if (l2bits) return zh ? `完成 · ${l2bits}` : `Done · ${l2bits}`;
      return zh ? `已结束（L1 未完成）` : `Done (L1 incomplete)`;
    }
    case 'error': return null;
  }
}
