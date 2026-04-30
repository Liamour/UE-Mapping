// Cross-component scan state. Lifted out of L1ScanButton / ScanOrchestrator
// so a scan in progress survives tab/system switches and a remount-induced
// "the button looks idle again" doesn't trick the user into double-firing
// the same backend job.
//
// Single global scan at a time — `start()` rejects if isRunning.
//
// On successful completion the store also resets the vault file cache and
// re-pulls the index so every consumer (Project Overview cardwall, Lv1
// graphs, system markdown pages) sees the LLM-rewritten frontmatter without
// a manual "save & load vault" step.  Centralised here so callers don't have
// to remember which subset of files to invalidate.
import { create } from 'zustand';
import { runProjectScan, type ProjectScanPhase } from '../services/projectScan';
import type { ProviderConfigPayload } from '../services/scanApi';
import { useVaultStore } from './useVaultStore';

export interface ScanStartOptions {
  projectRoot: string;
  providerConfig: ProviderConfigPayload;
  scope: { l2: boolean; l1: boolean };
  // When set, the L1 stage runs scoped to a single system tag (one LLM
  // call) instead of batch-over-all-systems.  Used by the Lv1 page button so
  // a single-system refresh doesn't re-spend tokens on every other system.
  systemId?: string;
  // Caller hooks — fired once when the scan finishes successfully so the L1
  // button can navigate and Settings can refresh the index.
  onDone?: (phase: Extract<ProjectScanPhase, { kind: 'done' }>) => void;
}

interface ScanState {
  phase: ProjectScanPhase;
  abort: AbortController | null;
  isRunning: boolean;

  start: (opts: ScanStartOptions) => Promise<void>;
  cancel: () => void;
  // Dismiss a terminal phase (done/error) back to idle. Useful so the user can
  // clear a stale "Done · …" line before starting another scan.
  reset: () => void;
}

export const useScanStore = create<ScanState>((set, get) => ({
  phase: { kind: 'idle' },
  abort: null,
  isRunning: false,

  start: async (opts) => {
    if (get().isRunning) return; // hard guard against double-fire
    const abort = new AbortController();
    set({ abort, isRunning: true, phase: { kind: 'idle' } });

    const final = await runProjectScan({
      projectRoot: opts.projectRoot,
      providerConfig: opts.providerConfig,
      scope: opts.scope,
      systemId: opts.systemId,
      signal: abort.signal,
      onPhase: (phase) => set({ phase }),
    });

    set({ abort: null, isRunning: false });

    if (final.kind === 'done') {
      // Order matters: refresh the index *before* invalidating the per-file
      // cache, then swap the cache in a single setState so subscribers don't
      // observe an empty `fileCache` while `files` still references the old
      // list (which can render half-loaded state and trip components that
      // assume "files length > 0 ⇒ at least one entry has frontmatter").
      // Caller's onDone (e.g. navigate to _overview) fires last so it lands
      // on a fully-refreshed store.
      try {
        await useVaultStore.getState().loadIndex();
      } catch (e) {
        console.warn('[scan] post-scan loadIndex failed', e);
      }
      useVaultStore.setState({ fileCache: {} });
      opts.onDone?.(final);
    }
  },

  cancel: () => {
    get().abort?.abort();
  },

  reset: () => {
    if (get().isRunning) return;
    set({ phase: { kind: 'idle' } });
  },
}));
