import { create } from 'zustand';

// Drill-down levels:
//   lv0 = Project overview (card wall, no specific selection)
//   lv1 = System view (force graph of all nodes within a system tag)
//   lv2 = Blueprint focus (single vault file)
//   lv3 = Function flow (single function within a BP — on-demand scan)
//   lv4 = Cross-BP call trace (concentric BFS view from a root BP — A3,
//         HANDOFF §19.3 / §21.5; rendered by Lv4CallTrace, scoped via
//         relativePath of the root vault note)
export type LevelKind = 'lv0' | 'lv1' | 'lv2' | 'lv3' | 'lv4';

export interface TabLocation {
  level: LevelKind;
  systemId?: string;          // for lv1 — system axis value, e.g. "combat"
  relativePath?: string;      // for lv2 / lv3 / lv4 — vault file path of the focused/root BP
  functionId?: string;        // for lv3 — function name within a BP
}

export interface Tab {
  id: string;
  title: string;
  location: TabLocation;
  history: TabLocation[];     // back-stack for breadcrumb / back navigation
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;

  openTab: (location: TabLocation, title: string) => string; // returns tab id
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  navigateActive: (location: TabLocation, title?: string) => void; // pushes history
  goBackActive: () => void;
  renameTab: (id: string, title: string) => void;
}

const PROJECT_TAB: Tab = {
  id: 'tab-root',
  title: 'Project',
  location: { level: 'lv0' },
  history: [],
};

let counter = 0;
const newId = () => `tab-${Date.now()}-${counter++}`;

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [PROJECT_TAB],
  activeId: PROJECT_TAB.id,

  openTab: (location, title) => {
    // dedupe: if a tab with the same location already exists, focus it
    const existing = get().tabs.find((t) => isSameLocation(t.location, location));
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    const id = newId();
    set((s) => ({
      tabs: [...s.tabs, { id, title, location, history: [] }],
      activeId: id,
    }));
    return id;
  },

  closeTab: (id) => {
    set((s) => {
      if (s.tabs.length === 1) return s;       // never close the last
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const nextTabs = s.tabs.filter((t) => t.id !== id);
      let nextActive = s.activeId;
      if (s.activeId === id) {
        nextActive = (nextTabs[idx] ?? nextTabs[idx - 1] ?? nextTabs[0]).id;
      }
      return { tabs: nextTabs, activeId: nextActive };
    });
  },

  setActive: (id) => set({ activeId: id }),

  navigateActive: (location, title) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      if (idx < 0) return s;
      const cur = s.tabs[idx];
      const next: Tab = {
        ...cur,
        location,
        title: title ?? cur.title,
        history: [...cur.history, cur.location],
      };
      const tabs = [...s.tabs];
      tabs[idx] = next;
      return { tabs };
    });
  },

  goBackActive: () => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      if (idx < 0) return s;
      const cur = s.tabs[idx];
      if (cur.history.length === 0) return s;
      const prev = cur.history[cur.history.length - 1];
      const next: Tab = {
        ...cur,
        location: prev,
        history: cur.history.slice(0, -1),
      };
      const tabs = [...s.tabs];
      tabs[idx] = next;
      return { tabs };
    });
  },

  renameTab: (id, title) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
  })),
}));

function isSameLocation(a: TabLocation, b: TabLocation): boolean {
  return a.level === b.level
    && a.systemId === b.systemId
    && a.relativePath === b.relativePath
    && a.functionId === b.functionId;
}
