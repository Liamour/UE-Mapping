import React, { useMemo, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useStaleStore, type StaleEntry } from '../../store/useStaleStore';
import { applyVaultRename } from '../../services/vaultApi';
import { useT } from '../../utils/i18n';

// TopBar — back button + AICartographer title + stale-asset badge (left),
// search trigger (center), project root + refresh + right-pane toggle (right).
//
// The stale badge sits in topbar-left, on purpose: the original right-side
// placement was too far from the user's gaze line to draw attention.
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
  const staleCount = staleByPath.size;
  const [staleOpen, setStaleOpen] = useState(false);
  const [applying, setApplying] = useState<Set<string>>(new Set());
  const [applyError, setApplyError] = useState<string | null>(null);

  const canGoBack = (activeTab?.history.length ?? 0) > 0;

  // Title → relative_path index built from vault file list.  We use this
  // (not manifest.entries — which the current backend doesn't populate
  // with asset_path) to match each stale event back to its vault note.
  // Asset paths end in `/Game/.../X.X` and our file titles are `X`.
  const nameToRelative = useMemo(() => {
    const idx = new Map<string, string>();
    for (const f of files) idx.set(f.title, f.relative_path);
    return idx;
  }, [files]);

  const findRelativeFor = (entry: StaleEntry): string | undefined => {
    // For renames, the vault note still lives under the OLD title until
    // the user applies the rename — try previousPath first.
    if (entry.type === 'renamed' && entry.previousPath) {
      const oldName = assetName(entry.previousPath);
      const rel = nameToRelative.get(oldName);
      if (rel) return rel;
    }
    return nameToRelative.get(assetName(entry.path));
  };

  // Sort by recency so latest changes surface first.
  const staleEntries = useMemo(
    () => Array.from(staleByPath.values()).sort((a, b) => b.timestampSec - a.timestampSec),
    [staleByPath],
  );

  const renameableEntries = useMemo(
    () => staleEntries.filter((e) => e.type === 'renamed' && !!e.previousPath && !!findRelativeFor(e)),
    [staleEntries, nameToRelative],
  );

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

  // Apply a single rename: move the vault .md file to match the new asset
  // name + update its frontmatter.  On success: clear the stale entry and
  // refresh the vault index so the new file shows up in side panel.
  const onApplyRename = async (entry: StaleEntry): Promise<boolean> => {
    if (!projectRoot) return false;
    if (entry.type !== 'renamed' || !entry.previousPath) return false;
    const oldRel = findRelativeFor(entry);
    if (!oldRel) {
      setApplyError(t({
        en: `Vault note for ${assetName(entry.previousPath)} not found`,
        zh: `找不到 ${assetName(entry.previousPath)} 的 vault 笔记`,
      }));
      return false;
    }
    const newName = assetName(entry.path);
    setApplying((s) => new Set(s).add(entry.path));
    try {
      await applyVaultRename(projectRoot, oldRel, newName, entry.path);
      removeRename(entry.path, entry.previousPath);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setApplyError(msg);
      return false;
    } finally {
      setApplying((s) => {
        const next = new Set(s);
        next.delete(entry.path);
        return next;
      });
    }
  };

  const onApplyAll = async () => {
    setApplyError(null);
    let any = false;
    for (const e of renameableEntries) {
      const ok = await onApplyRename(e);
      if (ok) any = true;
    }
    if (any) await loadIndex();      // refresh vault sidebar once at the end
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
                en: 'Click to see which assets changed and apply / rescan',
                zh: '点击查看哪些资产变更了，可一键应用或重扫',
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
                    minWidth: 420,
                    maxWidth: 560,
                    maxHeight: 500,
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
                    {renameableEntries.length > 1 && (
                      <button
                        onClick={onApplyAll}
                        disabled={applying.size > 0}
                        style={{
                          padding: '4px 10px',
                          background: '#dc2626',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 6,
                          fontSize: 'var(--fs-xs)',
                          fontWeight: 700,
                          cursor: applying.size > 0 ? 'wait' : 'pointer',
                          opacity: applying.size > 0 ? 0.6 : 1,
                        }}
                        title={t({
                          en: 'Apply all detected renames to vault notes (preserves NOTES section)',
                          zh: '把所有检测到的重命名应用到 vault 笔记（保留 NOTES 段）',
                        })}
                      >
                        {applying.size > 0
                          ? t({ en: 'Applying…', zh: '应用中…' })
                          : t({ en: `Apply all ${renameableEntries.length} renames`, zh: `一键应用 ${renameableEntries.length} 处重命名` })}
                      </button>
                    )}
                  </div>
                  {applyError && (
                    <div
                      style={{
                        padding: '8px 14px',
                        background: 'rgba(220, 38, 38, 0.08)',
                        color: '#b91c1c',
                        fontSize: 'var(--fs-xs)',
                        borderBottom: '1px solid rgba(0,0,0,0.05)',
                      }}
                    >
                      {applyError}
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
                    <Chip color={typeColor('renamed')} label={t({ en: 'renamed', zh: '重命名' })} /> {t({ en: 'X → Y in editor', zh: '编辑器中改名' })} ·{' '}
                    <Chip color={typeColor('removed')} label={t({ en: 'deleted', zh: '已删除' })} /> {t({ en: 'asset gone', zh: '资产已删除' })} ·{' '}
                    <Chip color={typeColor('added')} label={t({ en: 'added', zh: '新增' })} /> {t({ en: 'new asset, no vault note yet', zh: '新资产，暂无笔记' })} ·{' '}
                    <Chip color={typeColor('updated')} label={t({ en: 'updated', zh: '已修改' })} /> {t({ en: 'asset re-saved', zh: '资产已重新保存' })}
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {staleEntries.map((e) => {
                      const rel = findRelativeFor(e);
                      const navigable = !!rel;
                      const isApplying = applying.has(e.path);
                      const newName = assetName(e.path);
                      const oldName = e.previousPath ? assetName(e.previousPath) : '';
                      return (
                        <li
                          key={e.path + ':' + (e.previousPath ?? '')}
                          style={{
                            padding: '10px 14px',
                            borderBottom: '1px solid rgba(0,0,0,0.05)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            opacity: navigable || e.type === 'added' ? 1 : 0.7,
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
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <Chip color={typeColor(e.type)} label={typeLabel(e.type, t)} />
                            {e.type === 'renamed' && navigable && (
                              <button
                                onClick={async () => {
                                  const ok = await onApplyRename(e);
                                  if (ok) await loadIndex();
                                }}
                                disabled={isApplying}
                                style={{
                                  padding: '4px 10px',
                                  background: isApplying ? '#94a3b8' : '#dc2626',
                                  color: '#fff',
                                  border: 'none',
                                  borderRadius: 6,
                                  fontSize: 'var(--fs-xs)',
                                  fontWeight: 700,
                                  cursor: isApplying ? 'wait' : 'pointer',
                                  whiteSpace: 'nowrap',
                                }}
                                title={t({
                                  en: `Rename vault note ${oldName}.md → ${newName}.md and update its frontmatter (preserves NOTES section)`,
                                  zh: `把 vault 笔记 ${oldName}.md 改名为 ${newName}.md 并更新 frontmatter（保留 NOTES 段）`,
                                })}
                              >
                                {isApplying ? t({ en: '…', zh: '…' }) : t({ en: 'Apply', zh: '应用变更' })}
                              </button>
                            )}
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
