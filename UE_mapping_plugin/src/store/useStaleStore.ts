import { create } from 'zustand';

// Per-asset stale record.  We keep the most recent event metadata per path
// so the TopBar dropdown can show "what changed and when" — not just a
// flat count.  `oldPath` carries the previous object path on a rename
// (so the dropdown row for /Game/X/BP_New can say "renamed from BP_Old"),
// and the orphan side of the rename gets its own entry where `oldPath`
// holds the new path so the user can find where it moved to.
export interface StaleEntry {
  path: string;
  type: 'renamed' | 'removed' | 'added' | 'updated';
  oldPath?: string;
  timestampSec: number;
}

interface StaleEvent {
  counter: number;
  type: 'renamed' | 'removed' | 'added' | 'updated';
  path: string;
  old_path?: string;
  timestamp_sec: number;
}

interface StaleState {
  // Every path with a pending stale flag.  Keyed by the canonical
  // /Game/Path/Asset.Asset string vault frontmatter stores under
  // `asset_path`.  Map (not Set) because we surface event metadata
  // to the TopBar dropdown.
  staleByPath: Map<string, StaleEntry>;
  // Highest event counter applied to the store.  Next poll passes this
  // back to the bridge so we only fetch new events.
  latestCounter: number;
  syncActive: boolean;
  lastError: string | null;

  applyEvents: (events: StaleEvent[], latestCounter: number) => void;
  clearAll: () => void;
  removePath: (assetPath: string) => void;
  isStale: (assetPath: string) => boolean;
  setSyncActive: (active: boolean) => void;
  setLastError: (err: string | null) => void;
}

export const useStaleStore = create<StaleState>((set, get) => ({
  staleByPath: new Map(),
  latestCounter: 0,
  syncActive: false,
  lastError: null,

  applyEvents: (events, latestCounter) => set((s) => {
    if (events.length === 0 && latestCounter <= s.latestCounter) return {};

    const next = new Map(s.staleByPath);
    for (const ev of events) {
      if (ev.type === 'renamed' && ev.old_path) {
        // Rename produces TWO logical stale rows the user cares about:
        //   - old_path: the orphaned vault note (no asset matches it now)
        //   - new_path: the asset that moved here (no vault note for this path)
        // Each row carries the OTHER side as its `oldPath` so the dropdown
        // can render "renamed from X" / "renamed to Y".
        next.set(ev.old_path, {
          path: ev.old_path,
          type: 'renamed',
          oldPath: ev.path,
          timestampSec: ev.timestamp_sec,
        });
        next.set(ev.path, {
          path: ev.path,
          type: 'renamed',
          oldPath: ev.old_path,
          timestampSec: ev.timestamp_sec,
        });
      } else {
        next.set(ev.path, {
          path: ev.path,
          type: ev.type,
          oldPath: ev.old_path,
          timestampSec: ev.timestamp_sec,
        });
      }
    }
    return {
      staleByPath: next,
      latestCounter: Math.max(s.latestCounter, latestCounter),
      lastError: null,
    };
  }),

  clearAll: () => set({ staleByPath: new Map(), lastError: null }),

  removePath: (assetPath) => set((s) => {
    if (!s.staleByPath.has(assetPath)) return {};
    const next = new Map(s.staleByPath);
    next.delete(assetPath);
    return { staleByPath: next };
  }),

  isStale: (assetPath) => {
    if (!assetPath) return false;
    return get().staleByPath.has(assetPath);
  },

  setSyncActive: (active) => set({ syncActive: active }),
  setLastError: (err) => set({ lastError: err }),
}));
