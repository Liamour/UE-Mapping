import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useT } from '../../utils/i18n';

// TopBar after the ActivityBar refactor: hosts navigation (back), the search
// trigger (still useful here as a wide chip showing the Ctrl+K hint), the
// project-root indicator + vault refresh, and the right-pane toggle.
// Files toggle / Graph view / Settings live on the ActivityBar.
export const TopBar: React.FC = () => {
  const t = useT();
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const toggleRight = useUIStore((s) => s.toggleRightPane);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const lastLoadedAt = useVaultStore((s) => s.lastLoadedAt);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const goBack = useTabsStore((s) => s.goBackActive);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));

  const canGoBack = (activeTab?.history.length ?? 0) > 0;

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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - n + 1);
}
