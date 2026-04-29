import React, { useEffect } from 'react';
import { TopBar } from './TopBar';
import { Tabs } from './Tabs';
import { Breadcrumb } from './Breadcrumb';
import { LeftPane } from './LeftPane';
import { RightPane } from './RightPane';
import { ActivityBar } from './ActivityBar';
import { ErrorBoundary } from './ErrorBoundary';
import { SettingsModal } from '../settings/SettingsModal';
import { QuickSwitcher } from '../search/QuickSwitcher';
import { useTabsStore } from '../../store/useTabsStore';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { startStaleSync, stopStaleSync } from '../../services/staleSync';
import { Lv0CardWall } from '../levels/Lv0CardWall';
import { Lv1SystemGraph } from '../levels/Lv1SystemGraph';
import { Lv1SystemMarkdown } from '../levels/Lv1SystemMarkdown';
import { Lv2BlueprintFocus } from '../levels/Lv2BlueprintFocus';
import { Lv2BlueprintGraph } from '../levels/Lv2BlueprintGraph';
import { Lv3FunctionFlow } from '../levels/Lv3FunctionFlow';
import type { ViewMode } from '../../store/useUIStore';

export const AppShell: React.FC = () => {
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const leftVisible = useUIStore((s) => s.leftPaneVisible);
  const rightVisible = useUIStore((s) => s.rightPaneVisible);
  const viewMode = useUIStore((s) => s.viewMode);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const lastLoadedAt = useVaultStore((s) => s.lastLoadedAt);

  // Auto-load vault when project root is set and not loaded yet
  useEffect(() => {
    if (projectRoot && !lastLoadedAt) loadIndex();
  }, [projectRoot, lastLoadedAt, loadIndex]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  // Stale-asset polling lifecycle (HANDOFF §20.4 P1).  Hits the bridge
  // every 30s; no-ops gracefully when the bridge isn't bound.
  useEffect(() => {
    startStaleSync();
    return () => stopStaleSync();
  }, []);

  return (
    <div className="appshell">
      <TopBar />
      <Tabs />
      <Breadcrumb />
      <div className="appshell-body">
        <ActivityBar />
        {leftVisible && <LeftPane />}
        <main className="centerpane">
          <ErrorBoundary key={`${activeTab?.id ?? 'none'}-${viewMode}`}>
            {activeTab && renderLevel(activeTab.location, viewMode)}
          </ErrorBoundary>
        </main>
        {rightVisible && <RightPane />}
      </div>
      <SettingsModal />
      <QuickSwitcher />
    </div>
  );
};

function renderLevel(
  loc: ReturnType<typeof useTabsStore.getState>['tabs'][number]['location'],
  viewMode: ViewMode,
) {
  switch (loc.level) {
    case 'lv0': return <Lv0CardWall />;
    case 'lv1':
      if (!loc.systemId) return <Lv0CardWall />;
      // Markdown mode reads Systems/<id>.md; graph mode draws the d3-force
      // member layout.  Both are valid Lv1 representations.
      return viewMode === 'markdown'
        ? <Lv1SystemMarkdown systemId={loc.systemId} />
        : <Lv1SystemGraph systemId={loc.systemId} />;
    case 'lv2':
      if (!loc.relativePath) return <Lv0CardWall />;
      return viewMode === 'markdown'
        ? <Lv2BlueprintFocus relativePath={loc.relativePath} />
        : <Lv2BlueprintGraph relativePath={loc.relativePath} />;
    case 'lv3':
      if (!loc.relativePath || !loc.functionId) return <Lv0CardWall />;
      return <Lv3FunctionFlow relativePath={loc.relativePath} functionId={loc.functionId} />;
    default: return <Lv0CardWall />;
  }
}
