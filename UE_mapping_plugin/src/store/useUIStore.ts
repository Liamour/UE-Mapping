import { create } from 'zustand';

const VIEW_MODE_KEY = 'aicartographer.viewMode';

// Two parallel browsing modes that decide HOW the active tab is rendered when
// it lands on a level that has both a textual and a graphical representation:
//   - 'markdown' : reading mode. L1 = system intro .md, L2 = blueprint .md.
//   - 'graph'    : visual mode.   L1 = system force graph, L2 = blueprint
//                  internal force graph (events/functions/components + edges).
// L0 (card wall) and L3 (function flow) only have a single natural form so
// they ignore the mode.
export type ViewMode = 'markdown' | 'graph';

interface UIState {
  settingsOpen: boolean;
  searchOpen: boolean;
  rightPaneVisible: boolean;
  leftPaneVisible: boolean;
  viewMode: ViewMode;

  setSettingsOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  toggleRightPane: () => void;
  toggleLeftPane: () => void;
  setViewMode: (m: ViewMode) => void;
}

const initialViewMode: ViewMode = (() => {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'markdown' || v === 'graph') return v;
  } catch { /* ignore */ }
  return 'graph';
})();

export const useUIStore = create<UIState>((set) => ({
  settingsOpen: false,
  searchOpen: false,
  rightPaneVisible: true,
  leftPaneVisible: true,
  viewMode: initialViewMode,

  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSearchOpen: (v) => set({ searchOpen: v }),
  toggleRightPane: () => set((s) => ({ rightPaneVisible: !s.rightPaneVisible })),
  toggleLeftPane: () => set((s) => ({ leftPaneVisible: !s.leftPaneVisible })),
  setViewMode: (m) => {
    try { localStorage.setItem(VIEW_MODE_KEY, m); } catch { /* ignore */ }
    set({ viewMode: m });
  },
}));
