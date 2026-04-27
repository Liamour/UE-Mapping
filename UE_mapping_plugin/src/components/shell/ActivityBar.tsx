// Obsidian-style left activity bar.  Lives at the very far left of the
// AppShell body, before the LeftPane.  Hosts mode-switching icons at the top
// and the settings entry at the bottom (matching Obsidian's UX so users with
// muscle memory feel at home).
//
// Icon roles:
//   Files     — toggle the LeftPane (file tree) visibility
//   Markdown  — switch global viewMode → 'markdown' (text reading)
//   Graph     — switch global viewMode → 'graph'   (force-graph exploration)
//   Search    — open the QuickSwitcher (also bound to Ctrl+K)
//   Settings (bottom) — open the SettingsModal
//
// Mode toggles update useUIStore.viewMode; AppShell dispatches L1/L2 to the
// markdown- or graph-flavored renderer based on this state, so flipping the
// mode mid-navigation re-renders the active tab without changing its level.

import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useT } from '../../utils/i18n';

export const ActivityBar: React.FC = () => {
  const t = useT();
  const leftVisible = useUIStore((s) => s.leftPaneVisible);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const viewMode = useUIStore((s) => s.viewMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setSearchOpen = useUIStore((s) => s.setSearchOpen);
  const toggleLeft = useUIStore((s) => s.toggleLeftPane);
  const setViewMode = useUIStore((s) => s.setViewMode);

  return (
    <nav className="activitybar" aria-label={t({ en: 'Primary navigation', zh: '主导航' })}>
      <div className="activitybar-group">
        <ActivityButton
          label={t({ en: 'Files', zh: '文件' })}
          active={leftVisible}
          onClick={toggleLeft}
        >
          <FilesIcon />
        </ActivityButton>
        <ActivityButton
          label={t({ en: 'Markdown reading mode', zh: 'Markdown 阅读模式' })}
          active={viewMode === 'markdown'}
          onClick={() => setViewMode('markdown')}
        >
          <MarkdownIcon />
        </ActivityButton>
        <ActivityButton
          label={t({ en: 'Force-graph exploration mode', zh: '力向图探索模式' })}
          active={viewMode === 'graph'}
          onClick={() => setViewMode('graph')}
        >
          <GraphIcon />
        </ActivityButton>
        <ActivityButton
          label={t({ en: 'Search (Ctrl+K)', zh: '搜索 (Ctrl+K)' })}
          active={false}
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
        </ActivityButton>
      </div>
      <div className="activitybar-group activitybar-bottom">
        <ActivityButton
          label={t({ en: 'Settings', zh: '设置' })}
          active={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
        </ActivityButton>
      </div>
    </nav>
  );
};

const ActivityButton: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, active, onClick, children }) => (
  <button
    className={`activitybar-btn ${active ? 'activitybar-btn-active' : ''}`}
    title={label}
    aria-label={label}
    onClick={onClick}
  >
    {children}
  </button>
);

// --- Inline SVGs --------------------------------------------------------
// Stroke-based 18x18 icons keep the bar visually consistent across DPI scales
// without dragging in an icon library. currentColor lets the active/idle
// styles drive the stroke.

const FilesIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-8l-2-2H5a2 2 0 0 0-2 2z" />
  </svg>
);

// Document with horizontal lines — reading/markdown mode.  Stylized so it's
// visually distinct from the folder icon above it.
const MarkdownIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="16" x2="16" y2="16" />
    <line x1="8" y1="19" x2="13" y2="19" />
  </svg>
);

const GraphIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <line x1="7.6" y1="7.5" x2="11" y2="15.7" />
    <line x1="16.4" y1="7.5" x2="13" y2="15.7" />
    <line x1="8.5" y1="6" x2="15.5" y2="6" />
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="6" />
    <line x1="15.5" y1="15.5" x2="20" y2="20" />
  </svg>
);

const SettingsIcon: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
