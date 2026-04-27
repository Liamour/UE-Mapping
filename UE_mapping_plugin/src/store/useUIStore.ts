import { create } from 'zustand';

interface UIState {
  settingsOpen: boolean;
  searchOpen: boolean;
  rightPaneVisible: boolean;
  leftPaneVisible: boolean;

  setSettingsOpen: (v: boolean) => void;
  setSearchOpen: (v: boolean) => void;
  toggleRightPane: () => void;
  toggleLeftPane: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  settingsOpen: false,
  searchOpen: false,
  rightPaneVisible: true,
  leftPaneVisible: true,

  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSearchOpen: (v) => set({ searchOpen: v }),
  toggleRightPane: () => set((s) => ({ rightPaneVisible: !s.rightPaneVisible })),
  toggleLeftPane: () => set((s) => ({ leftPaneVisible: !s.leftPaneVisible })),
}));
