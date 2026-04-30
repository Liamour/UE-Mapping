import React, { useMemo, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useStaleStore, type StaleEntry } from '../../store/useStaleStore';
import {
  useSyncSettingsStore,
  PRIORITY,
  compareByPriority,
  type StaleEventType,
} from '../../store/useSyncSettingsStore';
import { applyOne, applyAll, tallyStale, type SyncOutcome } from '../../services/syncEngine';
import { isLlmAnalysisAvailable } from '../../services/llmSync';
import { useT } from '../../utils/i18n';

// TopBar — back button + title + stale-asset badge (left), search trigger
// (center), project root + refresh + right-pane toggle (right).
//
// Stale dropdown UX:
//   • Badge tinted by the HIGHEST-priority bucket present (red → orange →
//     green → grey).  Compact corner counts per bucket so users see the
//     distribution without opening the dropdown.
//   • Rows sorted by priority asc, then timestamp desc.
//   • Each row's Apply button verb + colour matches its event type so
//     "what will the click do" reads at a glance.
//   • One-click "Apply all" → confirm modal listing per-bucket counts and
//     an LLM-analysis checkbox (currently disabled until RAG+LLM lands).

type ActionStatus = 'idle' | 'busy' | 'ok' | 'error';
interface ActionState { status: ActionStatus; message?: string; }

export const TopBar: React.FC = () => {
  const t = useT();
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const toggleRight = useUIStore((s) => s.toggleRightPane);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const lastLoadedAt = useVaultStore((s) => s.lastLoadedAt);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const files = useVaultStore((s) => s.files);
  const goBack = useTabsStore((s) => s.goBackActive);
  const navigateActive = useTabsStore((s) => s.navigateActive);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const staleByPath = useStaleStore((s) => s.staleByPath);
  const clearAllStale = useStaleStore((s) => s.clearAll);
  const confirmBeforeApplyAll = useSyncSettingsStore((s) => s.confirmBeforeApplyAll);
  const autoLlmAfterSync = useSyncSettingsStore((s) => s.autoLlmAfterSync);
  const setAutoLlmAfterSync = useSyncSettingsStore((s) => s.setAutoLlmAfterSync);

  const [staleOpen, setStaleOpen] = useState(false);
  const [actions, setActions] = useState<Map<string, ActionState>>(new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const canGoBack = (activeTab?.history.length ?? 0) > 0;

  const setEntryAction = (key: string, state: ActionState) => {
    setActions((prev) => {
      const next = new Map(prev);
      next.set(key, state);
      return next;
    });
  };

  // Title → relative_path index (used to show "no vault note" hints in rows).
  const nameToRelative = useMemo(() => {
    const idx = new Map<string, string>();
    for (const f of files) idx.set(f.title, f.relative_path);
    return idx;
  }, [files]);

  const findRelativeFor = (entry: StaleEntry): string | undefined => {
    if (entry.type === 'renamed' && entry.previousPath) {
      const oldName = assetName(entry.previousPath);
      return nameToRelative.get(oldName);
    }
    return nameToRelative.get(assetName(entry.path));
  };

  const staleEntries = useMemo(
    () => Array.from(staleByPath.values()).slice().sort(compareByPriority),
    [staleByPath],
  );

  const tally = useMemo(() => tallyStale(), [staleByPath]);
  const staleCount = staleEntries.length;
  const headerColor = tally.highestPriority ? PRIORITY[tally.highestPriority].color : '#dc2626';

  const entryKey = (e: StaleEntry) => `${e.path}::${e.previousPath ?? ''}`;

  const onStaleItemClick = (entry: StaleEntry) => {
    const rel = findRelativeFor(entry);
    if (rel) {
      const displayName = entry.type === 'renamed' && entry.previousPath
        ? assetName(entry.previousPath)
        : assetName(entry.path);
      navigateActive({ level: 'lv2', relativePath: rel }, displayName);
    }
    setStaleOpen(false);
  };

  // ---- Per-row apply -------------------------------------------------------
  // Delegates to the shared sync engine so this UI doesn't duplicate logic.
  // Translates the SyncOutcome into per-row UI state.
  const applyRow = async (entry: StaleEntry) => {
    const key = entryKey(entry);
    setEntryAction(key, { status: 'busy' });
    const outcome = await applyOne(entry, { withLlm: false });
    if (outcome.ok) {
      setEntryAction(key, { status: 'ok' });
      try { await loadIndex(); } catch { /* non-fatal */ }
    } else {
      setEntryAction(key, { status: 'error', message: outcome.message });
    }
  };

  // ---- Bulk Apply All ------------------------------------------------------
  // confirmBeforeApplyAll (persisted) decides whether we open the confirm
  // modal first or fire immediately.  The modal is also the only place the
  // user can opt into LLM analysis on a per-run basis.
  const onClickApplyAll = () => {
    if (staleEntries.length === 0) return;
    if (confirmBeforeApplyAll) setConfirmOpen(true);
    else void runApplyAll(autoLlmAfterSync);
  };

  const runApplyAll = async (withLlm: boolean) => {
    setConfirmOpen(false);
    setBulkBusy(true);
    setBulkError(null);
    const report = await applyAll({
      withLlm,
      onProgress: (_done, _total, last) => {
        const key = entryKey(last.entry);
        setEntryAction(key, last.ok
          ? { status: 'ok' }
          : { status: 'error', message: last.message });
      },
    });
    if (report.failed > 0) {
      setBulkError(t({
        en: `${report.failed} change(s) failed — see per-row messages`,
        zh: `${report.failed} 处变更未能应用 — 见每行错误`,
      }));
    }
    setBulkBusy(false);
  };

  return (
    <div className="topbar">
      <div className="topbar-left">
        <button
          className={`iconbtn ${!canGoBack ? 'iconbtn-disabled' : ''}`}
          title={t({ en: 'Go back', zh: '返回' })}
          onClick={goBack}
          disabled={!canGoBack}
        >←</button>
        <span className="topbar-app">AICartographer</span>
        {staleCount > 0 && (
          <div style={{ position: 'relative', marginLeft: 12 }}>
            <button
              onClick={() => setStaleOpen((o) => !o)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                background: headerColor,
                color: '#fff',
                border: 'none',
                borderRadius: 16,
                fontSize: 'var(--fs-sm)',
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: `0 2px 6px ${headerColor}66`,
                letterSpacing: '0.01em',
              }}
              title={t({
                en: 'Click to see which assets changed and apply / dismiss',
                zh: '点击查看哪些资产变更了，可逐项应用或一键应用',
              })}
            >
              ⚠ {staleCount} {t({
                en: staleCount === 1 ? 'change' : 'changes',
                zh: '处变更',
              })}
              <BadgeTallyChips tally={tally} />
              <span style={{ marginLeft: 4, opacity: 0.85, fontSize: 'var(--fs-xs)' }}>▾</span>
            </button>
            {staleOpen && (
              <>
                <div onClick={() => setStaleOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }} />
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    left: 0,
                    minWidth: 480,
                    maxWidth: 640,
                    maxHeight: 560,
                    overflowY: 'auto',
                    background: 'var(--color-surface, #fff)',
                    border: '1px solid var(--color-border, rgba(0,0,0,0.12))',
                    borderRadius: 8,
                    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
                    zIndex: 1001,
                  }}
                >
                  <DropdownHeader
                    tally={tally}
                    bulkBusy={bulkBusy}
                    onApplyAll={onClickApplyAll}
                    onDismissAll={() => { clearAllStale(); setActions(new Map()); setBulkError(null); }}
                    t={t}
                  />
                  {bulkError && (
                    <div style={{
                      padding: '8px 14px',
                      background: 'rgba(220, 38, 38, 0.08)',
                      color: '#b91c1c',
                      fontSize: 'var(--fs-xs)',
                      borderBottom: '1px solid rgba(0,0,0,0.05)',
                    }}>{bulkError}</div>
                  )}
                  <TypeLegend t={t} />
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {staleEntries.map((e) => {
                      const rel = findRelativeFor(e);
                      const navigable = !!rel;
                      const key = entryKey(e);
                      const action = actions.get(key);
                      const newName = assetName(e.path);
                      const oldName = e.previousPath ? assetName(e.previousPath) : '';
                      return (
                        <li
                          key={key}
                          style={{
                            padding: '10px 14px',
                            borderBottom: '1px solid rgba(0,0,0,0.05)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            opacity: action?.status === 'ok' ? 0.55 : 1,
                            // Left-edge stripe in the priority colour for
                            // at-a-glance type recognition without reading.
                            borderLeft: `4px solid ${PRIORITY[e.type].color}`,
                          }}
                        >
                          <div
                            onClick={() => navigable && onStaleItemClick(e)}
                            style={{ minWidth: 0, flex: 1, cursor: navigable ? 'pointer' : 'default' }}
                            onMouseEnter={(ev) => { if (navigable) (ev.currentTarget as HTMLElement).style.color = PRIORITY[e.type].color; }}
                            onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.color = ''; }}
                            title={navigable ? t({ en: 'Click to open this blueprint\'s vault note', zh: '点击打开该蓝图的 vault 笔记' }) : t({ en: 'No vault note for this asset yet', zh: '该资产暂无 vault 笔记' })}
                          >
                            <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
                              {e.type === 'renamed' && oldName ? (
                                <>
                                  <span>{oldName}</span>
                                  <span style={{ margin: '0 6px', color: 'var(--color-text-muted, #888)' }}>→</span>
                                  <span>{newName}</span>
                                </>
                              ) : (
                                <span>{newName}</span>
                              )}
                              {!navigable && e.type !== 'added' && (
                                <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', fontWeight: 400 }}>
                                  ({t({ en: 'no vault note', zh: '无对应笔记' })})
                                </span>
                              )}
                            </div>
                            <div style={{
                              fontSize: 'var(--fs-xs)',
                              color: 'var(--color-text-muted, #888)',
                              marginTop: 2,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}>{e.path}</div>
                            {action?.status === 'error' && action.message && (
                              <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: '#b91c1c', whiteSpace: 'normal' }}>
                                {action.message}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <PriorityChip type={e.type} t={t} />
                            <ApplyButton
                              entry={e}
                              navigable={navigable}
                              busy={action?.status === 'busy'}
                              done={action?.status === 'ok'}
                              t={t}
                              onApply={() => { void applyRow(e); }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="topbar-center">
        <button
          className="search-trigger"
          onClick={() => setSearchOpen(true)}
          title={t({ en: 'Quick switcher (Ctrl+K)', zh: '快速切换 (Ctrl+K)' })}
        >
          <span className="search-icon">⌕</span>
          <span className="search-hint">{t({ en: 'Search vault', zh: '搜索 vault' })}</span>
          <span className="search-kbd">Ctrl K</span>
        </button>
      </div>
      <div className="topbar-right">
        <span className="root-indicator" title={projectRoot || t({ en: 'No project root set', zh: '未设置项目根目录' })}>
          {projectRoot ? truncate(projectRoot, 32) : t({ en: 'No vault', zh: '未加载 vault' })}
        </span>
        <button
          className="iconbtn"
          onClick={() => loadIndex()}
          title={lastLoadedAt
            ? t({ en: `Last loaded ${new Date(lastLoadedAt).toLocaleTimeString()}`, zh: `上次加载于 ${new Date(lastLoadedAt).toLocaleTimeString()}` })
            : t({ en: 'Refresh vault', zh: '刷新 vault' })}
        >↻</button>
        <button className="iconbtn" title={t({ en: 'Toggle right pane', zh: '切换右侧面板' })} onClick={toggleRight}>▤</button>
      </div>

      {confirmOpen && (
        <ApplyAllConfirmModal
          tally={tally}
          autoLlm={autoLlmAfterSync}
          setAutoLlm={setAutoLlmAfterSync}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(withLlm) => { void runApplyAll(withLlm); }}
          t={t}
        />
      )}
    </div>
  );
};

// ---- Sub-components -------------------------------------------------------

const DropdownHeader: React.FC<{
  tally: ReturnType<typeof tallyStale>;
  bulkBusy: boolean;
  onApplyAll: () => void;
  onDismissAll: () => void;
  t: ReturnType<typeof useT>;
}> = ({ tally, bulkBusy, onApplyAll, onDismissAll, t }) => {
  const ops = tally.added + tally.updated + tally.renamed + tally.removed;
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: '1px solid rgba(0,0,0,0.08)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <span style={{
        fontSize: 'var(--fs-xs)',
        fontWeight: 700,
        color: 'var(--color-text-muted, #666)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        {t({
          en: `${tally.total} change(s) since last scan`,
          zh: `自上次扫描以来 ${tally.total} 处变更`,
        })}
      </span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          onClick={onApplyAll}
          disabled={bulkBusy || ops === 0}
          style={{
            padding: '4px 10px',
            background: bulkBusy ? '#94a3b8' : '#dc2626',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 'var(--fs-xs)',
            fontWeight: 700,
            cursor: bulkBusy ? 'wait' : 'pointer',
            opacity: bulkBusy ? 0.6 : 1,
          }}
          title={t({
            en: 'Apply every detected change in priority order: added → updated → renamed → removed',
            zh: '按优先级一次性应用：新增 → 已修改 → 重命名 → 已删除',
          })}
        >
          {bulkBusy
            ? t({ en: 'Applying…', zh: '应用中…' })
            : t({ en: `Apply all (${ops})`, zh: `一键应用全部（${ops} 项）` })}
        </button>
        <button
          onClick={onDismissAll}
          disabled={bulkBusy}
          style={{
            padding: '4px 10px',
            background: 'transparent',
            color: 'var(--color-text-muted, #666)',
            border: '1px solid rgba(0,0,0,0.15)',
            borderRadius: 6,
            fontSize: 'var(--fs-xs)',
            fontWeight: 600,
            cursor: bulkBusy ? 'wait' : 'pointer',
          }}
          title={t({ en: 'Clear the badge without touching any vault file', zh: '仅清除徽标，不修改任何 vault 文件' })}
        >
          {t({ en: 'Dismiss all', zh: '全部忽略' })}
        </button>
      </div>
    </div>
  );
};

const TypeLegend: React.FC<{ t: ReturnType<typeof useT> }> = ({ t }) => (
  <div style={{
    padding: '8px 14px',
    background: 'rgba(0,0,0,0.025)',
    fontSize: 'var(--fs-xs)',
    color: 'var(--color-text-muted, #666)',
    borderBottom: '1px solid rgba(0,0,0,0.05)',
    lineHeight: 1.6,
  }}>
    <PriorityChip type="added" t={t} /> P0 {t({ en: 'new asset — Apply mints skeleton .md', zh: '新资产 — 应用即生成骨架 .md' })} ·{' '}
    <PriorityChip type="updated" t={t} /> P1 {t({ en: 're-saved — Apply re-fingerprints', zh: '已重新保存 — 应用即重新提取 AST' })} ·{' '}
    <PriorityChip type="renamed" t={t} /> P2 {t({ en: 'X → Y rename', zh: '编辑器中改名' })} ·{' '}
    <PriorityChip type="removed" t={t} /> P3 {t({ en: 'asset gone — Apply removes the .md', zh: '资产已删除 — 应用即同步删除 .md' })}
  </div>
);

const PriorityChip: React.FC<{ type: StaleEventType; t: ReturnType<typeof useT> }> = ({ type, t }) => {
  const p = PRIORITY[type];
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 9px',
      borderRadius: 10,
      fontSize: 'var(--fs-xs)',
      fontWeight: 700,
      background: p.color,
      color: p.fg,
      whiteSpace: 'nowrap',
    }}>
      {t(p.label)}
    </span>
  );
};

// Compact corner pill on the badge: 🔴2  🟠1  🟢3  ⚫1.  Only renders the
// non-zero buckets so a 1-event badge stays minimal.
const BadgeTallyChips: React.FC<{ tally: ReturnType<typeof tallyStale> }> = ({ tally }) => {
  const items: Array<{ type: StaleEventType; count: number }> = [];
  if (tally.added > 0) items.push({ type: 'added', count: tally.added });
  if (tally.updated > 0) items.push({ type: 'updated', count: tally.updated });
  if (tally.renamed > 0) items.push({ type: 'renamed', count: tally.renamed });
  if (tally.removed > 0) items.push({ type: 'removed', count: tally.removed });
  if (items.length <= 1) return null;     // single bucket — total in main label is enough
  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4 }}>
      {items.map((it) => (
        <span
          key={it.type}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: '0 5px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.22)',
            fontSize: 'var(--fs-xs)',
            fontWeight: 700,
          }}
          title={`${it.count} × ${PRIORITY[it.type].label.en}`}
        >
          <span style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: PRIORITY[it.type].color,
            border: '1px solid rgba(255,255,255,0.6)',
          }} />
          {it.count}
        </span>
      ))}
    </span>
  );
};

const ApplyButton: React.FC<{
  entry: StaleEntry;
  navigable: boolean;
  busy: boolean;
  done: boolean;
  t: ReturnType<typeof useT>;
  onApply: () => void;
}> = ({ entry, navigable, busy, done, t, onApply }) => {
  let label: string;
  let title: string;
  let bg: string;
  let disabled = busy || done;

  const p = PRIORITY[entry.type];

  if (done) {
    label = t({ en: '✓ done', zh: '✓ 已应用' });
    title = t({ en: 'Already applied', zh: '已经应用' });
    bg = '#16a34a';
  } else if (entry.type === 'added') {
    label = busy ? t({ en: '…', zh: '…' }) : t({ en: 'Scan & create', zh: '扫描并创建' });
    title = t({
      en: 'Run a single-asset framework scan and write a fresh skeleton .md',
      zh: '对该资产跑一次单节点框架扫描，并写入骨架 .md',
    });
    bg = busy ? '#94a3b8' : p.color;
  } else if (entry.type === 'updated') {
    label = busy ? t({ en: '…', zh: '…' }) : t({ en: 'Re-scan', zh: '重新扫描' });
    title = t({
      en: 'Re-fingerprint the asset and overwrite the skeleton .md (preserves NOTES)',
      zh: '重新提取该资产的 AST 指纹并覆盖骨架 .md（保留 NOTES 段）',
    });
    bg = busy ? '#94a3b8' : p.color;
  } else if (entry.type === 'renamed') {
    label = busy ? t({ en: '…', zh: '…' }) : t({ en: 'Apply rename', zh: '应用重命名' });
    title = t({
      en: 'Rename the .md to match the new asset name and update its frontmatter (preserves NOTES)',
      zh: '把 .md 改名为新资产名并更新 frontmatter（保留 NOTES 段）',
    });
    bg = busy ? '#94a3b8' : p.color;
    if (!navigable) disabled = true;
  } else {
    // removed
    label = busy ? t({ en: '…', zh: '…' }) : navigable ? t({ en: 'Delete .md', zh: '删除 .md' }) : t({ en: 'Dismiss', zh: '忽略' });
    title = navigable
      ? t({ en: 'Asset is gone — also remove its vault .md file', zh: '资产已删除 — 同步删除对应 .md 文件' })
      : t({ en: 'No vault note to delete; remove the badge', zh: '没有对应笔记可删；仅清除徽标' });
    bg = busy ? '#94a3b8' : navigable ? p.color : '#475569';
  }

  return (
    <button
      onClick={onApply}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        background: disabled && !done ? '#cbd5e1' : bg,
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        fontSize: 'var(--fs-xs)',
        fontWeight: 700,
        cursor: disabled ? (busy ? 'wait' : 'not-allowed') : 'pointer',
        whiteSpace: 'nowrap',
      }}
      title={title}
    >
      {label}
    </button>
  );
};

// ---- Apply-all confirm modal --------------------------------------------
const ApplyAllConfirmModal: React.FC<{
  tally: ReturnType<typeof tallyStale>;
  autoLlm: boolean;
  setAutoLlm: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: (withLlm: boolean) => void;
  t: ReturnType<typeof useT>;
}> = ({ tally, autoLlm, setAutoLlm, onCancel, onConfirm, t }) => {
  const llmReady = isLlmAnalysisAvailable();
  const ops = tally.added + tally.updated + tally.renamed + tally.removed;

  const Row: React.FC<{ type: StaleEventType; count: number; verb: { en: string; zh: string } }> = ({ type, count, verb }) => {
    if (count === 0) return null;
    const p = PRIORITY[type];
    return (
      <li style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
        <span style={{ width: 12, height: 12, borderRadius: 6, background: p.color, flexShrink: 0 }} />
        <span style={{ minWidth: 90, fontWeight: 700 }}>{count} × {t(p.label)}</span>
        <span style={{ color: 'var(--color-text-muted, #666)' }}>→ {t(verb)}</span>
      </li>
    );
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 460, maxWidth: 560,
          background: 'var(--color-surface, #fff)',
          borderRadius: 10,
          boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
          padding: 22,
        }}
      >
        <div style={{ fontSize: 'var(--fs-md, 16px)', fontWeight: 700, marginBottom: 6 }}>
          {t({ en: `Apply ${ops} change(s)?`, zh: `即将应用 ${ops} 项变更` })}
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted, #666)', marginBottom: 12 }}>
          {t({
            en: 'Changes will be applied in priority order. NOTES sections are preserved across renames and re-scans.',
            zh: '将按优先级顺序应用。NOTES 段在重命名和重新扫描中均保留。',
          })}
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px 0' }}>
          <Row type="added" count={tally.added} verb={{ en: 'scan + create skeleton .md', zh: '扫描并创建骨架 .md' }} />
          <Row type="updated" count={tally.updated} verb={{ en: 're-scan + rewrite skeleton', zh: '重新扫描并重写骨架' }} />
          <Row type="renamed" count={tally.renamed} verb={{ en: 'rename .md + update frontmatter', zh: '重命名 .md 并更新 frontmatter' }} />
          <Row type="removed" count={tally.removed} verb={{ en: 'delete the .md', zh: '删除对应 .md' }} />
        </ul>

        <label
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: 10,
            background: llmReady ? 'rgba(220,38,38,0.05)' : 'rgba(0,0,0,0.04)',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 6,
            cursor: llmReady ? 'pointer' : 'not-allowed',
            opacity: llmReady ? 1 : 0.65,
          }}
          title={llmReady
            ? t({ en: 'Run LLM deep analysis on every added/updated node', zh: '对每个新增/已修改节点运行 LLM 深度分析' })
            : t({ en: 'RAG + LLM pipeline not yet wired — toggle is preserved for when it lands.', zh: 'RAG + LLM 流水线尚未上线 — 选择已保存，待上线后自动启用。' })}
        >
          <input
            type="checkbox"
            checked={autoLlm}
            onChange={(e) => setAutoLlm(e.target.checked)}
            disabled={!llmReady}
            style={{ marginTop: 2 }}
          />
          <span style={{ fontSize: 'var(--fs-sm)' }}>
            <span style={{ fontWeight: 600 }}>
              {t({ en: 'Also run LLM deep analysis', zh: '同时运行 LLM 深度分析' })}
            </span>
            <span style={{
              marginLeft: 8,
              padding: '1px 6px',
              borderRadius: 4,
              fontSize: 'var(--fs-xs)',
              fontWeight: 700,
              background: llmReady ? '#16a34a' : '#94a3b8',
              color: '#fff',
            }}>
              {llmReady ? t({ en: 'READY', zh: '可用' }) : t({ en: 'NOT YET', zh: '暂未启用' })}
            </span>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted, #666)', marginTop: 2 }}>
              {t({
                en: 'Refines the freshly-written .md with intent / risk / interactions.  Requires a configured LLM provider.',
                zh: '在新写入的 .md 上叠加 intent / risk / 交互分析。需要已配置 LLM provider。',
              })}
            </div>
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid rgba(0,0,0,0.15)',
              borderRadius: 6,
              fontSize: 'var(--fs-sm)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >{t({ en: 'Cancel', zh: '取消' })}</button>
          <button
            onClick={() => onConfirm(autoLlm && llmReady)}
            style={{
              padding: '6px 14px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 'var(--fs-sm)',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >{t({ en: 'Apply all', zh: '应用全部' })}</button>
        </div>
      </div>
    </div>
  );
};

// ---- Helpers --------------------------------------------------------------

function assetName(path: string): string {
  const last = path.split('/').pop() ?? path;
  const base = last.split('.')[0] ?? last;
  return base || path;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - n + 1);
}

// Re-export so consumers don't need a separate import — keeps TopBar self-
// contained for refactor friendliness.
export type { SyncOutcome };
