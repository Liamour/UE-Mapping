import React from 'react';
import { useTabsStore } from '../../store/useTabsStore';

export const Tabs: React.FC = () => {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeId ? 'tab-active' : ''}`}
          onClick={() => setActive(t.id)}
        >
          <span className="tab-icon">{tabIcon(t.location.level)}</span>
          <span className="tab-title" title={t.title}>{t.title}</span>
          {tabs.length > 1 && (
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              title="Close"
            >×</button>
          )}
        </div>
      ))}
    </div>
  );
};

function tabIcon(level: string): string {
  switch (level) {
    case 'lv0': return '◇';
    case 'lv1': return '◈';
    case 'lv2': return '▢';
    case 'lv3': return '▷';
    default: return '·';
  }
}
