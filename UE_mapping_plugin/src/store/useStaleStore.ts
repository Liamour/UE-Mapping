import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  // True when the rename was inferred by pairing a removed+added pair
  // in the same parent dir (UE didn't fire OnAssetRenamed for some
  // reason — drag/drop in some content browser flows, save-as, etc).
  // The downstream apply path treats inferred renames the same as native
  // ones BUT also re-fingerprints the new asset afterwards so a true
  // content swap still ends up with correct AST in the .md.
  inferred?: boolean;
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
  // Called by staleSync.ts when the bridge's reported latest_counter
  // regresses (UE restarted, in-memory event buffer reset).  We keep the
  // staleByPath flags but reset our cursor so we re-pull anything new the
  // current UE session emits.
  resyncCounter: (newCounter: number) => void;
}

// ---- Heuristic add+remove → rename pairing -------------------------------
// Some UE rename flows (drag-drop reorganisation, save-as, content-browser
// move across plugins) fire OnAssetAdded + OnAssetRemoved instead of
// OnAssetRenamed.  We never see the rename signal, so the dropdown shows
// two rows ("X removed" + "Y added") for what the user thinks of as one
// rename.  Real-world example: BP_Village → BP_Villag in the same folder
// surfaced as both red P0 'added' and grey P3 'removed'.
//
// Rule: within each parent directory bucket, greedily pair every removed
// entry with the highest-similarity added entry whose name shares a long
// common prefix.  The threshold is conservative (≥50% of the longer name's
// length) so unrelated renames (BP_test next to BP_Village) don't get
// folded together.  Each added entry can be claimed by at most one
// removed entry; leftover added/removed rows stay surfaced individually
// so the user can resolve them manually.
//
// Why prefix-based and not Levenshtein:  user-driven typo and truncation
// renames almost always preserve a leading prefix.  Prefix length runs in
// O(min(a,b)) and is dirt cheap; we don't need a full edit-distance solver.
function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  if (i <= 0) return '';
  return path.slice(0, i);
}

function fileBase(path: string): string {
  // /Game/Foo/BP_X.BP_X → BP_X
  const last = path.split('/').pop() ?? path;
  return last.split('.')[0] ?? last;
}

function commonPrefixSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length);
}

const RENAME_PAIR_SIM_THRESHOLD = 0.5;

function inferRenamesByDir(map: Map<string, StaleEntry>): Map<string, StaleEntry> {
  const buckets = new Map<string, { removed: StaleEntry[]; added: StaleEntry[] }>();
  for (const e of map.values()) {
    if (e.type !== 'removed' && e.type !== 'added') continue;
    const parent = parentDir(e.path);
    if (!buckets.has(parent)) buckets.set(parent, { removed: [], added: [] });
    const b = buckets.get(parent)!;
    if (e.type === 'removed') b.removed.push(e);
    else b.added.push(e);
  }

  let mutated = false;
  const next = new Map(map);

  for (const [, b] of buckets) {
    if (b.removed.length === 0 || b.added.length === 0) continue;

    // Greedy best-match: for each removed entry, pick the most-similar
    // unclaimed added entry that meets the threshold.  Using insertion
    // order makes this deterministic across renders.
    const claimed = new Set<StaleEntry>();
    for (const r of b.removed) {
      const rName = fileBase(r.path);
      let best: { entry: StaleEntry; sim: number } | null = null;
      for (const a of b.added) {
        if (claimed.has(a)) continue;
        const sim = commonPrefixSimilarity(rName, fileBase(a.path));
        if (sim >= RENAME_PAIR_SIM_THRESHOLD && (!best || sim > best.sim)) {
          best = { entry: a, sim };
        }
      }
      if (best) {
        claimed.add(best.entry);
        next.delete(r.path);
        next.delete(best.entry.path);
        next.set(best.entry.path, {
          path: best.entry.path,
          type: 'renamed',
          previousPath: r.path,
          timestampSec: Math.max(r.timestampSec, best.entry.timestampSec),
          inferred: true,
        });
        mutated = true;
      }
    }
  }
  return mutated ? next : map;
}

// Custom storage so Map serialises as an array of [key, value] pairs.
// JSON.stringify(Map) yields {} otherwise — silently losing every entry.
const staleStorage = createJSONStorage<Partial<StaleState>>(() => localStorage, {
  replacer: (_key, value) => {
    if (value instanceof Map) {
      return { __type: 'StaleMap', entries: Array.from(value.entries()) } as unknown as object;
    }
    return value;
  },
  reviver: (_key, value) => {
    if (
      value &&
      typeof value === 'object' &&
      (value as { __type?: string }).__type === 'StaleMap' &&
      Array.isArray((value as { entries?: unknown }).entries)
    ) {
      return new Map((value as { entries: [string, StaleEntry][] }).entries);
    }
    return value;
  },
});

export const useStaleStore = create<StaleState>()(
  persist(
    (set, get) => ({
      staleByPath: new Map(),
      latestCounter: 0,
      syncActive: false,
      lastError: null,

      applyEvents: (events, latestCounter) => set((s) => {
        if (events.length === 0 && latestCounter <= s.latestCounter) return {};

        let next = new Map(s.staleByPath);

        // UE's AssetRegistry fires TWO events on a rename: OnAssetRenamed (the
        // primary) and OnAssetRemoved (redirector cleanup of the old path).
        // The pair shows up in our buffer as two independent records with
        // different keys (new path vs old path), which used to surface as two
        // rows in the dropdown — once as "renamed X→Y" and again as "X removed".
        //
        // We dedup in BOTH directions:
        //   (a) renamed arrives:  delete any existing entry keyed by old_path.
        //       Catches the "removed-then-renamed" event order.
        //   (b) removed arrives:  if any existing entry is a rename whose
        //       previousPath matches this removed path, swallow this event —
        //       it's the redirector cleanup, not a separate user action.
        //       Catches the "renamed-then-removed" event order.
        for (const ev of events) {
          if (ev.type === 'renamed' && ev.old_path) {
            next.delete(ev.old_path);
            next.set(ev.path, {
              path: ev.path,
              type: 'renamed',
              previousPath: ev.old_path,
              timestampSec: ev.timestamp_sec,
            });
            continue;
          }
          if (ev.type === 'removed') {
            // Is this the OLD path of a rename we already know about?  Skip.
            let suppressed = false;
            for (const e of next.values()) {
              if (e.type === 'renamed' && e.previousPath === ev.path) {
                suppressed = true;
                break;
              }
            }
            if (suppressed) continue;
          }
          next.set(ev.path, {
            path: ev.path,
            type: ev.type,
            timestampSec: ev.timestamp_sec,
          });
        }

        // Heuristic pass: pair leftover add+remove in same parent dir.
        next = inferRenamesByDir(next);

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

      // Called when the bridge's latest_counter is LOWER than ours — i.e.
      // UE restarted and reset its in-memory counter to 0.  Reset our
      // cursor so the next poll re-fetches anything that surfaces in the
      // new UE session, but keep staleByPath so the user's pending list
      // survives across editor restarts.
      resyncCounter: (newCounter) => set({ latestCounter: newCounter }),
    }),
    {
      name: 'aicartographer.stale.v1',
      storage: staleStorage,
      // Persist the durable state only.  syncActive / lastError are
      // session-local and shouldn't survive reload.
      partialize: (s) => ({
        staleByPath: s.staleByPath,
        latestCounter: s.latestCounter,
      }),
    },
  ),
);
