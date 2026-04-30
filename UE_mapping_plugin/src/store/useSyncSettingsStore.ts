import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Persisted user preferences for the stale-asset sync flow.
//
// - autoSyncEnabled       : master toggle for auto-applying detected changes
//                          on each 30s poll.  Off by default — user opts in.
// - autoSyncCategories    : per-event-type fine-grained control.  `removed`
//                          defaults to false to protect against accidental
//                          asset deletes wiping a vault note before the user
//                          can react.
// - autoLlmAfterSync      : fire LLM analysis on added/updated nodes after a
//                          successful sync.  Stub-only until the RAG+LLM
//                          pipeline lands; the toggle persists state so the
//                          first user gesture isn't lost.
// - confirmBeforeApplyAll : show the "5 changes will apply" modal before the
//                          one-click "Apply all" runs.  On by default.
// - lastSyncedAt          : ms timestamp of the last successful sync run,
//                          surfaced in Settings as a sanity check.

export type StaleEventType = 'added' | 'updated' | 'renamed' | 'removed';

export interface SyncCategoryFlags {
  added: boolean;
  updated: boolean;
  renamed: boolean;
  removed: boolean;
}

interface SyncSettingsState {
  autoSyncEnabled: boolean;
  autoSyncCategories: SyncCategoryFlags;
  autoLlmAfterSync: boolean;
  confirmBeforeApplyAll: boolean;
  lastSyncedAt: number | null;

  setAutoSyncEnabled: (v: boolean) => void;
  toggleCategory: (cat: StaleEventType) => void;
  setAutoLlmAfterSync: (v: boolean) => void;
  setConfirmBeforeApplyAll: (v: boolean) => void;
  setLastSyncedAt: (ts: number) => void;
}

const DEFAULT_CATEGORIES: SyncCategoryFlags = {
  added: true,
  updated: true,
  renamed: true,
  removed: false,            // explicit opt-in — protects against bad UE deletes
};

export const useSyncSettingsStore = create<SyncSettingsState>()(
  persist(
    (set) => ({
      autoSyncEnabled: false,
      autoSyncCategories: DEFAULT_CATEGORIES,
      autoLlmAfterSync: false,
      confirmBeforeApplyAll: true,
      lastSyncedAt: null,

      setAutoSyncEnabled: (v) => set({ autoSyncEnabled: v }),
      toggleCategory: (cat) => set((s) => ({
        autoSyncCategories: { ...s.autoSyncCategories, [cat]: !s.autoSyncCategories[cat] },
      })),
      setAutoLlmAfterSync: (v) => set({ autoLlmAfterSync: v }),
      setConfirmBeforeApplyAll: (v) => set({ confirmBeforeApplyAll: v }),
      setLastSyncedAt: (ts) => set({ lastSyncedAt: ts }),
    }),
    { name: 'aicartographer.sync.settings' },
  ),
);

// ---- Priority + color tokens (single source of truth) ---------------------
// Used by the TopBar dropdown, the badge, the confirm modal, and the
// Settings auto-sync panel.  Centralised so changing the palette doesn't
// require touching N files.

export const PRIORITY_ORDER: StaleEventType[] = ['added', 'updated', 'renamed', 'removed'];

export interface PriorityToken {
  label: { en: string; zh: string };
  color: string;       // primary hex for badge / button bg
  fg: string;          // foreground text color
  rank: number;        // 0 = highest priority (added), 3 = lowest (removed)
}

export const PRIORITY: Record<StaleEventType, PriorityToken> = {
  added:   { label: { en: 'added',    zh: '新增' },     color: '#dc2626', fg: '#fff', rank: 0 },
  updated: { label: { en: 'updated',  zh: '已修改' },   color: '#f59e0b', fg: '#fff', rank: 1 },
  renamed: { label: { en: 'renamed',  zh: '重命名' },   color: '#16a34a', fg: '#fff', rank: 2 },
  removed: { label: { en: 'deleted',  zh: '已删除' },   color: '#64748b', fg: '#fff', rank: 3 },
};

// Comparator: lowest rank first (added → updated → renamed → removed),
// then most-recent-first by timestamp inside each rank bucket.
export function compareByPriority<T extends { type: StaleEventType; timestampSec: number }>(a: T, b: T): number {
  const dr = PRIORITY[a.type].rank - PRIORITY[b.type].rank;
  if (dr !== 0) return dr;
  return b.timestampSec - a.timestampSec;
}
