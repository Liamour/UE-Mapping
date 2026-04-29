import React, { useMemo, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useStaleStore, type StaleEntry } from '../../store/useStaleStore';
import { useT } from '../../utils/i18n';

// TopBar after the ActivityBar refactor: hosts navigation (back), the search
// trigger (still useful here as a wide chip showing the Ctrl+K hint), the
// project-root indicator + vault refresh, and the right-pane toggle.  Also
// hosts the stale-asset badge — moved to topbar-left so the user notices it
// without having to look at the far right corner.
export const TopBar: React.FC = () => {
  const t = useT();
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const toggleRight = useUIStore((s) => s.toggleRightPane);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const lastLoadedAt = useVaultStore((s) => s.lastLoadedAt);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const manifest = useVaultStore((s) => s.manifest);
  const goBack = useTabsStore((s) => s.goBackActive);
  const navigateActive = useTabsStore((s) => s.navigateActive);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const staleByPath = useStaleStore((s) => s.staleByPath);
  const staleCount = staleByPath.size;
  const [staleOpen, setStaleOpen] = useState(false);

  const canGoBack = (activeTab?.history.length ?? 0) > 0;

  // Build asset_path → relative_path index from the vault manifest so the
  // dropdown can navigate the user straight to the affected blueprint's Lv2.
  // Entries with no matching vault note (newly added assets, orphaned old
  // paths after rename) stay in the list but render as non-clickable.
  const assetToRelative = useMemo(() => {
    const idx = new Map<string, string>();
    for (const [relPath, entry] of Object.entries(manifest)) {
      if (entry?.asset_path) idx.set(entry.asset_path, relPath);
    }
    return idx;
  }, [manifest]);

  // Sort by recency so latest changes surface first.
  const staleEntries = useMemo(
    () => Array.from(staleByPath.values()).sort((a, b) => b.timestampSec - a.timestampSec),
    [staleByPath],
  );

  const onStaleItemClick = (entry: StaleEntry) => {
    const rel = assetToRelative.get(entry.path);
    if (rel) {
      navigateActive({ level: 'lv2', relativePath: rel }, assetName(entry.path));
    }
    setStaleOpen(false);
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
                en: 'Click to see which assets changed and jump to them',
                zh: '点击查看哪些资产变更了，可直接跳转',
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
                    minWidth: 380,
                    maxWidth: 520,
                    maxHeight: 420,
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
                      borderBottom: '1px solid var(--color-border, rgba(0,0,0,0.08))',
                      fontSize: 'var(--fs-xs)',
                      fontWeight: 700,
                      color: 'var(--color-text-muted, #666)',
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {t({
                      en: `${staleCount} asset(s) changed since last scan`,
                      zh: `自上次扫描以来 ${staleCount} 处变更`,
                    })}
                  </div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {staleEntries.map((e) => {
                      const rel = assetToRelative.get(e.path);
                      const navigable = !!rel;
                      return (
                        <li
                          key={e.path}
                          onClick={() => navigable && onStaleItemClick(e)}
                          style={{
                            padding: '10px 14px',
                            cursor: navigable ? 'pointer' : 'default',
                            borderBottom: '1px solid rgba(0,0,0,0.05)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            opacity: navigable ? 1 : 0.65,
                          }}
                          onMouseEnter={(ev) => {
                            if (navigable) (ev.currentTarget as HTMLElement).style.background = 'rgba(220, 38, 38, 0.06)';
                          }}
                          onMouseLeave={(ev) => {
                            (ev.currentTarget as HTMLElement).style.background = '';
                          }}
                          title={e.path + (e.oldPath ? ` (was ${e.oldPath})` : '')}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>
                              {assetName(e.path)}
                              {!navigable && (
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
                              {e.oldPath && e.type === 'renamed' && (
                                <span style={{ marginLeft: 6 }}>← {assetName(e.oldPath)}</span>
                              )}
                            </div>
                          </div>
                          <span
                            style={{
                              padding: '3px 9px',
                              borderRadius: 10,
                              fontSize: 'var(--fs-xs)',
                              fontWeight: 700,
                              background: typeColor(e.type).bg,
                              color: typeColor(e.type).fg,
                              flexShrink: 0,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {typeLabel(e.type, t)}
                          </span>
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
