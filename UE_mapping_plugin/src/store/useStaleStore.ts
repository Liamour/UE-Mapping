import { create } from 'zustand';

// In-memory record of asset paths that the AssetRegistry has flagged as
// changed since the last vault scan.  Populated by services/staleSync.ts
// every 30s; surfaced to the UI as a TopBar badge + per-asset Pill.
//
// Lifetime is the plugin tab itself — closing / reloading the WebUI clears
// the set.  Persisting `stale: true` into vault frontmatter (so the flag
// survives reload) is HANDOFF §20.4 P4 work.

interface StaleEvent {
  counter: number;
  type: 'renamed' | 'removed' | 'added' | 'updated';
  path: string;            // current object path (post-rename for 'renamed')
  old_path?: string;       // populated only for 'renamed'
  timestamp_sec: number;
}

interface StaleState {
  // Asset paths that are currently stale.  Keys match the canonical
  // `/Game/Path/Asset.Asset` shape vault frontmatter stores under `asset_path`.
  stalePaths: Set<string>;
  // Highest event counter applied to the store.  Next poll passes this back
  // to the bridge so we only fetch new events.
  latestCounter: number;
  // Whether the polling loop is active.  Owned by services/staleSync.ts;
  // UI components should not toggle it.
  syncActive: boolean;
  // Last error from the polling loop (network / JSON / bridge missing).
  // Cleared on the next successful poll.
  lastError: string | null;

  applyEvents: (events: StaleEvent[], latestCounter: number) => void;
  clearAll: () => void;
  removePath: (assetPath: string) => void;
  isStale: (assetPath: string) => boolean;
  setSyncActive: (active: boolean) => void;
  setLastError: (err: string | null) => void;
}

export const useStaleStore = create<StaleState>((set, get) => ({
  stalePaths: new Set(),
  latestCounter: 0,
  syncActive: false,
  lastError: null,

  applyEvents: (events, latestCounter) => set((s) => {
    // No-op: the bridge had nothing new and the counter didn't advance.
    if (events.length === 0 && latestCounter <= s.latestCounter) return {};

    const next = new Set(s.stalePaths);
    for (const ev of events) {
      if (ev.type === 'renamed') {
        // Mark BOTH ends as stale: the old path is now an orphaned vault note,
        // the new path is an asset with no vault note yet.  The user will
        // typically delete the orphan and rescan the new path.
        if (ev.old_path) next.add(ev.old_path);
        next.add(ev.path);
      } else {
        // removed / added / updated: the current path is the actionable one.
        next.add(ev.path);
      }
    }
    return {
      stalePaths: next,
      latestCounter: Math.max(s.latestCounter, latestCounter),
      lastError: null,
    };
  }),

  clearAll: () => set({ stalePaths: new Set(), lastError: null }),

  removePath: (assetPath) => set((s) => {
    if (!s.stalePaths.has(assetPath)) return {};
    const next = new Set(s.stalePaths);
    next.delete(assetPath);
    return { stalePaths: next };
  }),

  isStale: (assetPath) => {
    if (!assetPath) return false;
    return get().stalePaths.has(assetPath);
  },

  setSyncActive: (active) => set({ syncActive: active }),
  setLastError: (err) => set({ lastError: err }),
}));
