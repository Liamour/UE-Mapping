import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';

export const TopBar: React.FC = () => {
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const toggleLeft = useUIStore((s) => s.toggleLeftPane);
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
        <button className="iconbtn" title="Toggle left pane" onClick={toggleLeft}>☰</button>
        <button
          className={`iconbtn ${!canGoBack ? 'iconbtn-disabled' : ''}`}
          title="Go back"
          onClick={goBack}
          disabled={!canGoBack}
        >←</button>
        <span className="topbar-app">AICartographer</span>
      </div>
      <div className="topbar-center">
        <button
          className="search-trigger"
          onClick={() => setSearchOpen(true)}
          title="Quick switcher (Ctrl+K)"
        >
          <span className="search-icon">⌕</span>
          <span className="search-hint">Search vault</span>
          <span className="search-kbd">Ctrl K</span>
        </button>
      </div>
      <div className="topbar-right">
        <span className="root-indicator" title={projectRoot || 'No project root set'}>
          {projectRoot ? truncate(projectRoot, 32) : 'No vault'}
        </span>
        <button
          className="iconbtn"
          onClick={() => loadIndex()}
          title={lastLoadedAt ? `Last loaded ${new Date(lastLoadedAt).toLocaleTimeString()}` : 'Refresh vault'}
        >↻</button>
        <button className="iconbtn" title="Toggle right pane" onClick={toggleRight}>▤</button>
        <button className="iconbtn" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
      </div>
    </div>
  );
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - n + 1);
}
