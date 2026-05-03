import { create } from 'zustand';
import {
  listVault,
  readVaultFile,
  type VaultListEntry,
  type VaultFile,
  type VaultManifestEntry,
} from '../services/vaultApi';

const PROJECT_ROOT_KEY = 'aicartographer.projectRoot';

interface VaultState {
  projectRoot: string;
  setProjectRoot: (root: string) => void;

  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;

  files: VaultListEntry[];
  manifest: Record<string, VaultManifestEntry>;
  fileCache: Record<string, VaultFile>;

  // Full-content indexing state — driven on-demand by QuickSwitcher so the
  // user gets body-text search without paying the upfront load on every page.
  // 'idle'  → never indexed in this session
  // 'loading' → bulk load in progress (loadedCount tracks progress)
  // 'ready' → every file in `files` is in `fileCache`
  contentIndex: {
    status: 'idle' | 'loading' | 'ready';
    loadedCount: number;
    totalCount: number;
  };
  indexAllContent: () => Promise<void>;

  loadIndex: () => Promise<void>;
  loadFile: (relativePath: string) => Promise<VaultFile | null>;
  invalidateFile: (relativePath: string) => void;
}

const initialRoot = (() => {
  try {
    return localStorage.getItem(PROJECT_ROOT_KEY) ?? '';
  } catch {
    return '';
  }
})();

export const useVaultStore = create<VaultState>((set, get) => ({
  projectRoot: initialRoot,
  setProjectRoot: (root) => {
    try { localStorage.setItem(PROJECT_ROOT_KEY, root); } catch { /* ignore */ }
    set({
      projectRoot: root, files: [], manifest: {}, fileCache: {}, lastLoadedAt: null,
      contentIndex: { status: 'idle', loadedCount: 0, totalCount: 0 },
    });
  },

  loading: false,
  error: null,
  lastLoadedAt: null,

  files: [],
  manifest: {},
  fileCache: {},
  contentIndex: { status: 'idle', loadedCount: 0, totalCount: 0 },

  loadIndex: async () => {
    const root = get().projectRoot;
    if (!root) {
      set({ error: 'No project root set' });
      return;
    }
    set({ loading: true, error: null });
    try {
      const resp = await listVault(root);
      set({
        files: resp.files,
        manifest: resp.manifest?.entries ?? {},
        loading: false,
        lastLoadedAt: Date.now(),
        // File list rotated — content index is stale.  Don't drop fileCache
        // (keeps already-opened files snappy) but mark indexing as not done
        // so the next QuickSwitcher open re-fills any newly added files.
        contentIndex: { status: 'idle', loadedCount: 0, totalCount: 0 },
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadFile: async (relativePath) => {
    const root = get().projectRoot;
    if (!root) return null;
    const cached = get().fileCache[relativePath];
    if (cached) return cached;
    try {
      const f = await readVaultFile(root, relativePath);
      set((s) => ({ fileCache: { ...s.fileCache, [relativePath]: f } }));
      return f;
    } catch (e) {
      console.error('[vault] loadFile failed', relativePath, e);
      return null;
    }
  },

  // Bulk-load every file in `files` into `fileCache` so QuickSwitcher can
  // search body content.  Idempotent — short-circuits if already 'ready' or
  // currently 'loading'.  Bounded concurrency keeps the bridge / HTTP queue
  // sane on big projects (8 in flight at a time → ~10 batches for Cropout's
  // 76 files, low single-digit seconds).  Failed reads are silently skipped
  // so one stale file can't block the whole index.
  indexAllContent: async () => {
    const state = get();
    if (state.contentIndex.status === 'loading') return;
    const root = state.projectRoot;
    if (!root) return;
    const all = state.files;
    if (all.length === 0) {
      set({ contentIndex: { status: 'ready', loadedCount: 0, totalCount: 0 } });
      return;
    }
    const missing = all.filter((f) => !state.fileCache[f.relative_path]);
    if (missing.length === 0) {
      set({ contentIndex: { status: 'ready', loadedCount: all.length, totalCount: all.length } });
      return;
    }

    set({ contentIndex: { status: 'loading', loadedCount: all.length - missing.length, totalCount: all.length } });

    const CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= missing.length) return;
        const f = missing[i];
        try {
          const file = await readVaultFile(root, f.relative_path);
          set((s) => ({
            fileCache: { ...s.fileCache, [f.relative_path]: file },
            contentIndex: {
              ...s.contentIndex,
              loadedCount: s.contentIndex.loadedCount + 1,
            },
          }));
        } catch (e) {
          // Skip — log once but don't bubble; one bad file shouldn't kill the
          // bulk index.  loadedCount intentionally NOT bumped so the user
          // sees an honest "loaded 75/76" instead of 76/76.
          console.warn('[vault] indexAllContent skipped', f.relative_path, e);
        }
      }
    });
    await Promise.all(workers);
    set((s) => ({
      contentIndex: { status: 'ready', loadedCount: s.contentIndex.loadedCount, totalCount: all.length },
    }));
  },

  invalidateFile: (relativePath) => {
    set((s) => {
      const next = { ...s.fileCache };
      delete next[relativePath];
      return { fileCache: next };
    });
  },
}));
