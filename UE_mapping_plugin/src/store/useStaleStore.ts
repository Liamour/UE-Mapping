import { create } from 'zustand';

// Per-asset stale record.  We surface the most recent event metadata per
// path so the TopBar dropdown can render rich info (renamed-from-X / type
// chip / timestamp) instead of a flat count.
//
// For renames, a SINGLE entry is stored — keyed by the new path (where
// the asset is now), with `previousPath` carrying the path the asset used
// to live at.  The TopBar display can then render "BP_Old → BP_New" in
// one row, and the "Apply rename" button knows both endpoints.  This
// matters for vault navigation: the existing vault note still lives at
// previousPath (the OLD title) until the user applies the rename.
export interface StaleEntry {
  path: string;             // current asset path (post-rename)
  type: 'renamed' | 'removed' | 'added' | 'updated';
  previousPath?: string;    // populated only for 'renamed'
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
  // All pending stale flags, keyed by the current asset path.  Map (not
  // Set) because dropdown UI surfaces event metadata.
  staleByPath: Map<string, StaleEntry>;
  // Highest event counter applied to the store; the next bridge poll
  // passes this back so we only fetch new events.
  latestCounter: number;
  syncActive: boolean;
  lastError: string | null;

  applyEvents: (events: StaleEvent[], latestCounter: number) => void;
  clearAll: () => void;
  removePath: (assetPath: string) => void;
  // For renames: accept the new path, but also clear the previousPath
  // entry if present (defensive — older builds wrote both halves).
  removeRename: (currentPath: string, previousPath?: string) => void;
  // True when assetPath is itself stale, OR when assetPath is the OLD
  // location of a renamed asset.  Lv2/Lv3 use this so a vault note still
  // sitting at its old asset_path lights up after the user renames in UE.
  isStale: (assetPath: string) => boolean;
  staleEntryFor: (assetPath: string) => StaleEntry | undefined;
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
        // ONE entry per rename, keyed by new path.  If the old path had
        // its own entry (e.g., an `updated` before this rename), drop it
        // — the new entry supersedes.
        next.delete(ev.old_path);
        next.set(ev.path, {
          path: ev.path,
          type: 'renamed',
          previousPath: ev.old_path,
          timestampSec: ev.timestamp_sec,
        });
      } else {
        next.set(ev.path, {
          path: ev.path,
          type: ev.type,
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

  removeRename: (currentPath, previousPath) => set((s) => {
    let touched = false;
    const next = new Map(s.staleByPath);
    if (next.delete(currentPath)) touched = true;
    if (previousPath && next.delete(previousPath)) touched = true;
    return touched ? { staleByPath: next } : {};
  }),

  isStale: (assetPath) => {
    if (!assetPath) return false;
    const map = get().staleByPath;
    if (map.has(assetPath)) return true;
    // Reverse lookup: this assetPath is the OLD location of a renamed
    // asset.  The vault note still sits here, so the Lv2/Lv3 view of it
    // should still flag stale.
    for (const e of map.values()) {
      if (e.type === 'renamed' && e.previousPath === assetPath) return true;
    }
    return false;
  },

  staleEntryFor: (assetPath) => {
    if (!assetPath) return undefined;
    const map = get().staleByPath;
    const direct = map.get(assetPath);
    if (direct) return direct;
    for (const e of map.values()) {
      if (e.type === 'renamed' && e.previousPath === assetPath) return e;
    }
    return undefined;
  },

  setSyncActive: (active) => set({ syncActive: active }),
  setLastError: (err) => set({ lastError: err }),
}));
