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
    set({ projectRoot: root, files: [], manifest: {}, fileCache: {}, lastLoadedAt: null });
  },

  loading: false,
  error: null,
  lastLoadedAt: null,

  files: [],
  manifest: {},
  fileCache: {},

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

  invalidateFile: (relativePath) => {
    set((s) => {
      const next = { ...s.fileCache };
      delete next[relativePath];
      return { fileCache: next };
    });
  },
}));
