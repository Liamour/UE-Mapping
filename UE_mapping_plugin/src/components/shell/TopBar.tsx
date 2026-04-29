import React, { useMemo, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useStaleStore, type StaleEntry } from '../../store/useStaleStore';
import { applyVaultRename, deleteVaultFile } from '../../services/vaultApi';
import { useT } from '../../utils/i18n';

// TopBar — back button + AICartographer title + stale-asset badge (left),
// search trigger (center), project root + refresh + right-pane toggle (right).
//
// The stale badge sits in topbar-left, on purpose: the original right-side
// placement was too far from the user's gaze line to draw attention.
//
// Per-event Apply semantics:
//   renamed → rename .md (preserves NOTES) + update frontmatter
//   removed → delete the .md outright (asset is gone, the note is moot)
//   added   → no .md exists yet; user dismisses and runs Framework scan
//             from Settings to mint a skeleton.  We don't auto-scan because
//             the user might be batching multiple new assets.
//   updated → no .md change required at this layer; user dismisses, then
//             reruns Framework scan or per-node Deep reasoning later.

type ActionStatus = 'idle' | 'busy' | 'ok' | 'error';
interface ActionState {
  status: ActionStatus;
  message?: string;
}

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
  const removeRename = useStaleStore((s) => s.removeRename);
  const removePath = useStaleStore((s) => s.removePath);
  const clearAllStale = useStaleStore((s) => s.clearAll);
  const staleCount = staleByPath.size;
  const [staleOpen, setStaleOpen] = useState(false);
  const [actions, setActions] = useState<Map<string, ActionState>>(new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const canGoBack = (activeTab?.history.length ?? 0) > 0;

  const setEntryAction = (key: string, state: ActionState) => {
    setActions((prev) => {
      const next = new Map(prev);
      next.set(key, state);
      return next;
    });
  };

  // Title → relative_path index built from vault file list.  We use this
  // (not manifest.entries — which the current backend doesn't populate
  // with asset_path) to match each stale event back to its vault note.
  // Asset paths end in `/Game/.../X.X` and our file titles are `X`.
  const nameToRelative = useMemo(() => {
    const idx = new Map<string, string>();
    for (const f of files) idx.set(f.title, f.relative_path);
    return idx;
  }, [files]);

  // For renames, the vault note still lives under the OLD title until the
  // user applies the rename.  For all other events the note (if any) is
  // keyed by the current path.  Returns undefined when no .md exists, in
  // which case the row's Apply button is hidden.
  const findRelativeFor = (entry: StaleEntry): string | undefined => {
    if (entry.type === 'renamed' && entry.previousPath) {
      const oldName = assetName(entry.previousPath);
      return nameToRelative.get(oldName);
    }
    return nameToRelative.get(assetName(entry.path));
  };

  // Sort by recency so latest changes surface first.
  const staleEntries = useMemo(
    () => Array.from(staleByPath.values()).sort((a, b) => b.timestampSec - a.timestampSec),
    [staleByPath],
  );

  const entryKey = (e: StaleEntry) => `${e.path}::${e.previousPath ?? ''}`;

  // Counts of each kind of "actionable" entry — drives the Apply All summary.
  const actionable = useMemo(() => {
    let renames = 0, deletes = 0, dismissable = 0;
    for (const e of staleEntries) {
      if (e.type === 'renamed' && e.previousPath && findRelativeFor(e)) renames++;
      else if (e.type === 'removed' && findRelativeFor(e)) deletes++;
      else if (e.type === 'added' || e.type === 'updated') dismissable++;
      // removed-but-no-vault-note also dismissable
      else if (e.type === 'removed' && !findRelativeFor(e)) dismissable++;
    }
    return { renames, deletes, dismissable, total: staleEntries.length };
  }, [staleEntries, nameToRelative]);

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

  // ---- Per-event apply handlers --------------------------------------------

  // Apply a single rename: move the vault .md to match the new asset name,
  // update its frontmatter (preserving body + NOTES).  Returns true on
  // success so the caller can refresh the vault index.
  const onApplyRename = async (entry: StaleEntry): Promise<boolean> => {
    if (!projectRoot) return false;
    if (entry.type !== 'renamed' || !entry.previousPath) return false;
    const oldRel = findRelativeFor(entry);
    const key = entryKey(entry);
    if (!oldRel) {
      setEntryAction(key, {
        status: 'error',
        message: t({
          en: `No vault note found for ${assetName(entry.previousPath)}`,
          zh: `找不到 ${assetName(entry.previousPath)} 的 vault 笔记`,
        }),
      });
      return false;
    }
    const newName = assetName(entry.path);
    setEntryAction(key, { status: 'busy' });
    try {
      await applyVaultRename(projectRoot, oldRel, newName, entry.path);
      removeRename(entry.path, entry.previousPath);
      setEntryAction(key, { status: 'ok' });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEntryAction(key, { status: 'error', message: msg });
      return false;
    }
  };

  // Apply a single delete: remove the vault .md entirely.
  const onApplyDelete = async (entry: StaleEntry): Promise<boolean> => {
    if (!projectRoot) return false;
    if (entry.type !== 'removed') return false;
    const rel = findRelativeFor(entry);
    const key = entryKey(entry);
    if (!rel) {
      // No vault note to delete — just dismiss the badge.
      removePath(entry.path);
      setEntryAction(key, { status: 'ok' });
      return true;
    }
    setEntryAction(key, { status: 'busy' });
    try {
      await deleteVaultFile(projectRoot, rel);
      removePath(entry.path);
      setEntryAction(key, { status: 'ok' });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEntryAction(key, { status: 'error', message: msg });
      return false;
    }
  };

  // Dismiss: remove the entry from the badge without touching the vault.
  // For added/updated this is the primary action (the user enriches via
  // Framework scan or Deep reasoning later).  For removed-without-note it
  // is the only sensible action.
  const onDismiss = (entry: StaleEntry) => {
    if (entry.type === 'renamed' && entry.previousPath) {
      removeRename(entry.path, entry.previousPath);
    } else {
      removePath(entry.path);
    }
  };

  // ---- Bulk Apply All -------------------------------------------------------
  // Walks every entry and applies the type-appropriate action: rename →
  // applyRename, remove → deleteVault, added/updated → dismiss.  Errors are
  // collected per-entry so a single failure doesn't abort the rest.
  const onApplyAll = async () => {
    if (!projectRoot) return;
    setBulkBusy(true);
    setBulkError(null);
    let touched = false;
    let errors = 0;
    // Snapshot the entries — we mutate the store as we go.
    const snapshot = staleEntries.slice();
    for (const e of snapshot) {
      let ok = false;
      if (e.type === 'renamed' && e.previousPath && findRelativeFor(e)) {
        ok = await onApplyRename(e);
      } else if (e.type === 'removed') {
        ok = await onApplyDelete(e);
      } else {
        // added / updated → dismiss
        onDismiss(e);
        ok = true;
      }
      if (ok) touched = true;
      else errors++;
    }
    if (touched) {
      try { await loadIndex(); } catch { /* sidebar refresh non-fatal */ }
    }
    if (errors > 0) {
      setBulkError(t({
        en: `${errors} change(s) failed — see per-row messages`,
        zh: `${errors} 处变更未能应用 — 见每行错误`,
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
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: 16,
                fontSize: 'var(--fs-sm)',
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(220, 38, 38, 0.4)',
                letterSpacing: '0.01em',
              }}
              title={t({
                en: 'Click to see which assets changed and apply / dismiss',
                zh: '点击查看哪些资产变更了，可逐项应用或一键应用',
              })}
            >
              ⚠ {staleCount} {t({
                en: staleCount === 1 ? 'asset changed' : 'assets changed',
                zh: '处变更',
              })}
              <span style={{ marginLeft: 4, opacity: 0.85, fontSize: 'var(--fs-xs)' }}>▾</span>
            </button>
            {staleOpen && (
              <>
                <div
                  onClick={() => setStaleOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    left: 0,
                    minWidth: 460,
                    maxWidth: 620,
                    maxHeight: 540,
                    overflowY: 'auto',
                    background: 'var(--color-surface, #fff)',
                    border: '1px solid var(--color-border, rgba(0,0,0,0.12))',
                    borderRadius: 8,
                    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
                    zIndex: 1001,
                  }}
                >
                  <div
                    style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid rgba(0,0,0,0.08)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 'var(--fs-xs)',
                        fontWeight: 700,
                        color: 'var(--color-text-muted, #666)',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {t({
                        en: `${staleCount} change(s) since last scan`,
                        zh: `自上次扫描以来 ${staleCount} 处变更`,
                      })}
                    </span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        onClick={onApplyAll}
                        disabled={bulkBusy}
                        style={{
                          padding: '4px 10px',
                          background: '#dc2626',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 6,
                          fontSize: 'var(--fs-xs)',
                          fontWeight: 700,
                          cursor: bulkBusy ? 'wait' : 'pointer',
                          opacity: bulkBusy ? 0.6 : 1,
                        }}
                        title={t({
                          en: 'Rename matched .md, delete .md for removed assets, dismiss the rest. Refreshes the file tree at the end.',
                          zh: '一键应用：重命名匹配的 .md、删除已移除资产对应的 .md、其余项忽略。完成后刷新文件树。',
                        })}
                      >
                        {bulkBusy
                          ? t({ en: 'Applying…', zh: '应用中…' })
                          : t({
                              en: `Apply all (${actionable.renames + actionable.deletes} ops · ${actionable.dismissable} dismiss)`,
                              zh: `一键应用全部（${actionable.renames + actionable.deletes} 项操作 · ${actionable.dismissable} 项忽略）`,
                            })}
                      </button>
                      <button
                        onClick={() => { clearAllStale(); setActions(new Map()); setBulkError(null); }}
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
                        title={t({
                          en: 'Clear the badge without touching any vault file',
                          zh: '仅清除徽标，不修改任何 vault 文件',
                        })}
                      >
                        {t({ en: 'Dismiss all', zh: '全部忽略' })}
                      </button>
                    </div>
                  </div>
                  {bulkError && (
                    <div
                      style={{
                        padding: '8px 14px',
                        background: 'rgba(220, 38, 38, 0.08)',
                        color: '#b91c1c',
                        fontSize: 'var(--fs-xs)',
                        borderBottom: '1px solid rgba(0,0,0,0.05)',
                      }}
                    >
                      {bulkError}
                    </div>
                  )}
                  <div
                    style={{
                      padding: '8px 14px',
                      background: 'rgba(0,0,0,0.025)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--color-text-muted, #666)',
                      borderBottom: '1px solid rgba(0,0,0,0.05)',
                      lineHeight: 1.5,
                    }}
                  >
                    {t({
                      en: 'Type chips: ',
                      zh: '类型说明：',
                    })}
                    <Chip color={typeColor('renamed')} label={t({ en: 'renamed', zh: '重命名' })} /> {t({ en: 'X → Y', zh: '编辑器中改名' })} ·{' '}
                    <Chip color={typeColor('removed')} label={t({ en: 'deleted', zh: '已删除' })} /> {t({ en: 'asset gone — Apply removes the .md', zh: '资产已删除 — 应用即删除对应 .md' })} ·{' '}
                    <Chip color={typeColor('added')} label={t({ en: 'added', zh: '新增' })} /> {t({ en: 'no .md yet — Dismiss then run Framework scan', zh: '暂无 .md — 忽略后到设置运行框架扫描' })} ·{' '}
                    <Chip color={typeColor('updated')} label={t({ en: 'updated', zh: '已修改' })} /> {t({ en: 'asset re-saved — rescan to refresh', zh: '资产已重新保存 — 重新扫描以刷新' })}
                  </div>
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
                          }}
                        >
                          <div
                            onClick={() => navigable && onStaleItemClick(e)}
                            style={{
                              minWidth: 0,
                              flex: 1,
                              cursor: navigable ? 'pointer' : 'default',
                            }}
                            onMouseEnter={(ev) => {
                              if (navigable) (ev.currentTarget as HTMLElement).style.color = '#dc2626';
                            }}
                            onMouseLeave={(ev) => {
                              (ev.currentTarget as HTMLElement).style.color = '';
                            }}
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
                            <div
                              style={{
                                fontSize: 'var(--fs-xs)',
                                color: 'var(--color-text-muted, #888)',
                                marginTop: 2,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {e.path}
                            </div>
                            {action?.status === 'error' && action.message && (
                              <div
                                style={{
                                  marginTop: 4,
                                  fontSize: 'var(--fs-xs)',
                                  color: '#b91c1c',
                                  whiteSpace: 'normal',
                                }}
                              >
                                {action.message}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <Chip color={typeColor(e.type)} label={typeLabel(e.type, t)} />
                            <ApplyButton
                              entry={e}
                              navigable={navigable}
                              busy={action?.status === 'busy'}
                              done={action?.status === 'ok'}
                              t={t}
                              onApply={async () => {
                                if (e.type === 'renamed') {
                                  const ok = await onApplyRename(e);
                                  if (ok) await loadIndex();
                                } else if (e.type === 'removed') {
                                  const ok = await onApplyDelete(e);
                                  if (ok) await loadIndex();
                                } else {
                                  onDismiss(e);
                                }
                              }}
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
            ? t({
                en: `Last loaded ${new Date(lastLoadedAt).toLocaleTimeString()}`,
                zh: `上次加载于 ${new Date(lastLoadedAt).toLocaleTimeString()}`,
              })
            : t({ en: 'Refresh vault', zh: '刷新 vault' })}
        >↻</button>
        <button
          className="iconbtn"
          title={t({ en: 'Toggle right pane', zh: '切换右侧面板' })}
          onClick={toggleRight}
        >▤</button>
      </div>
    </div>
  );
};

const ApplyButton: React.FC<{
  entry: StaleEntry;
  navigable: boolean;
  busy: boolean;
  done: boolean;
  t: ReturnType<typeof useT>;
  onApply: () => void | Promise<void>;
}> = ({ entry, navigable, busy, done, t, onApply }) => {
  // Different verbs / colors per event type so the user immediately sees
  // *what* the click will do.  Renames need a vault note to act on; deletes
  // and dismisses always work.
  let label: string;
  let title: string;
  let bg: string;
  let disabled = busy || done;

  if (done) {
    label = t({ en: '✓ done', zh: '✓ 已应用' });
    title = t({ en: 'Already applied', zh: '已经应用' });
    bg = '#16a34a';
  } else if (entry.type === 'renamed') {
    label = busy ? t({ en: '…', zh: '…' }) : t({ en: 'Apply rename', zh: '应用重命名' });
    title = t({
      en: 'Rename the .md to match the new asset name and update its frontmatter (preserves NOTES)',
      zh: '把 .md 改名为新资产名并更新 frontmatter（保留 NOTES 段）',
    });
    bg = busy ? '#94a3b8' : '#dc2626';
    if (!navigable) disabled = true;
  } else if (entry.type === 'removed') {
    label = busy
      ? t({ en: '…', zh: '…' })
      : navigable
        ? t({ en: 'Delete .md', zh: '删除 .md' })
        : t({ en: 'Dismiss', zh: '忽略' });
    title = navigable
      ? t({ en: 'Asset is gone — also remove its vault .md file', zh: '资产已删除 — 同步删除对应 .md 文件' })
      : t({ en: 'No vault note to delete; remove the badge', zh: '没有对应笔记可删；仅清除徽标' });
    bg = busy ? '#94a3b8' : navigable ? '#7f1d1d' : '#475569';
  } else {
    // added / updated — primary action is dismiss.  User runs Framework
    // scan from Settings to mint / refresh the .md.
    label = t({ en: 'Dismiss', zh: '忽略' });
    title = t({
      en: entry.type === 'added'
        ? 'New asset — dismiss this badge, then run "Scan project structure" in Settings to create its skeleton .md'
        : 'Asset re-saved — dismiss this badge, then run "Scan project structure" or per-node Deep reasoning to refresh',
      zh: entry.type === 'added'
        ? '新资产 — 先忽略此徽标，到设置中运行"扫描项目结构"以生成骨架 .md'
        : '资产已重新保存 — 先忽略此徽标，到设置中运行"扫描项目结构"或节点级 Deep reasoning 刷新',
    });
    bg = '#475569';
  }

  return (
    <button
      onClick={() => { void onApply(); }}
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

const Chip: React.FC<{ color: { bg: string; fg: string }; label: string }> = ({ color, label }) => (
  <span
    style={{
      display: 'inline-block',
      padding: '3px 9px',
      borderRadius: 10,
      fontSize: 'var(--fs-xs)',
      fontWeight: 700,
      background: color.bg,
      color: color.fg,
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

// Extract a human-readable name from a UE asset path: turn
// "/Game/Path/BP_Foo.BP_Foo" into "BP_Foo".
function assetName(path: string): string {
  const last = path.split('/').pop() ?? path;
  const base = last.split('.')[0] ?? last;
  return base || path;
}

function typeLabel(type: StaleEntry['type'], t: ReturnType<typeof useT>): string {
  switch (type) {
    case 'renamed': return t({ en: 'renamed', zh: '重命名' });
    case 'removed': return t({ en: 'deleted', zh: '已删除' });
    case 'added':   return t({ en: 'added',   zh: '新增' });
    case 'updated': return t({ en: 'updated', zh: '已修改' });
  }
}

// Color the type chip distinctly so the user can scan the list and pick
// the destructive ones (red for delete) at a glance.
function typeColor(type: StaleEntry['type']): { bg: string; fg: string } {
  switch (type) {
    case 'removed': return { bg: '#7f1d1d', fg: '#fff' };
    case 'renamed': return { bg: '#a16207', fg: '#fff' };
    case 'added':   return { bg: '#166534', fg: '#fff' };
    case 'updated': return { bg: '#1e40af', fg: '#fff' };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - n + 1);
}
