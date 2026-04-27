import React from 'react';
import { useTabsStore } from '../../store/useTabsStore';
import { useT } from '../../utils/i18n';

export const Tabs: React.FC = () => {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);

  return (
    <div className="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}
          onClick={() => setActive(tab.id)}
        >
          <span className="tab-icon">{tabIcon(tab.location.level)}</span>
          <span className="tab-title" title={tab.title}>{tab.title}</span>
          {tabs.length > 1 && (
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title={t({ en: 'Close', zh: '关闭' })}
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
