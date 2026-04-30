// Stale-asset sync engine.  Single source of truth for "what does Apply do
// for each event type", shared by the per-row buttons in TopBar, the bulk
// Apply-all flow, and the auto-sync poller wired into staleSync.ts.
//
// Action map:
//   added    → syncSingleAsset (mint skeleton .md from C++ AST)
//   updated  → syncSingleAsset (overwrite skeleton, preserves NOTES)
//   renamed  → applyVaultRename (move .md + update frontmatter)
//   removed  → deleteVaultFile  (drop the .md)
//
// All four bottom out at vaultApi/frameworkScan helpers, which in turn pick
// bridge or HTTP automatically.  No backend is required when the C++ plugin
// has been rebuilt with DeleteVaultFile bound.

import { applyVaultRename, deleteVaultFile } from './vaultApi';
import { syncSingleAsset } from './frameworkScan';
import { runLlmAnalysisForAsset, isLlmAnalysisAvailable } from './llmSync';
import { useStaleStore, type StaleEntry } from '../store/useStaleStore';
import {
  useSyncSettingsStore,
  PRIORITY,
  compareByPriority,
  type StaleEventType,
} from '../store/useSyncSettingsStore';
import { useVaultStore } from '../store/useVaultStore';

export interface SyncOutcome {
  entry: StaleEntry;
  ok: boolean;
  action: 'created' | 'updated' | 'renamed' | 'deleted' | 'dismissed' | 'skipped';
  message?: string;
  llmRan?: boolean;
}

export interface BatchSyncOptions {
  withLlm?: boolean;                 // honoured only if isLlmAnalysisAvailable()
  filter?: (e: StaleEntry) => boolean;
  onProgress?: (done: number, total: number, last: SyncOutcome) => void;
}

export interface BatchSyncReport {
  total: number;
  succeeded: number;
  failed: number;
  outcomes: SyncOutcome[];
}

// ---- Single-event apply -------------------------------------------------
// Returns the SyncOutcome and (on success) also clears the corresponding
// stale entry from the store + bumps lastSyncedAt.  Errors are caught here
// so callers don't have to wrap in try/catch.

export async function applyOne(
  entry: StaleEntry,
  opts: { withLlm?: boolean } = {},
): Promise<SyncOutcome> {
  const projectRoot = useVaultStore.getState().projectRoot;
  if (!projectRoot) {
    return { entry, ok: false, action: 'skipped', message: 'No project root' };
  }

  const stale = useStaleStore.getState();
  const lookupRel = (e: StaleEntry): string | undefined => {
    const files = useVaultStore.getState().files;
    const targetName = e.type === 'renamed' && e.previousPath
      ? assetName(e.previousPath)
      : assetName(e.path);
    return files.find((f) => f.title === targetName)?.relative_path;
  };

  // Track every relative_path we touched so we can invalidate the vault
  // file cache at the end — otherwise the Lv2 tab keeps rendering the
  // pre-rescan snapshot (e.g. function the user just deleted still listed
  // under exports_functions:).
  const touchedRels: string[] = [];

  let outcome: SyncOutcome;
  try {
    if (entry.type === 'added' || entry.type === 'updated') {
      const { relativePath } = await syncSingleAsset(projectRoot, entry.path);
      touchedRels.push(relativePath);
      stale.removePath(entry.path);
      outcome = {
        entry,
        ok: true,
        action: entry.type === 'added' ? 'created' : 'updated',
        message: relativePath,
      };
    } else if (entry.type === 'renamed') {
      if (!entry.previousPath) {
        return { entry, ok: false, action: 'skipped', message: 'rename event missing previousPath' };
      }
      const oldRel = lookupRel(entry);
      if (!oldRel) {
        return {
          entry, ok: false, action: 'skipped',
          message: `No vault note for ${assetName(entry.previousPath)}`,
        };
      }
      const newName = assetName(entry.path);
      await applyVaultRename(projectRoot, oldRel, newName, entry.path);
      touchedRels.push(oldRel);
      // After the .md is in its new location with updated frontmatter,
      // re-fingerprint the asset so its function/component/edge tables
      // reflect the current Blueprint state.  Two reasons:
      //   (a) a true rename usually leaves AST untouched but cheap to
      //       refresh — keeps ast_hash and scan_at honest;
      //   (b) HEURISTIC renames (where we paired add+remove because UE
      //       didn't fire OnAssetRenamed) can have completely different
      //       content under the same folder; we MUST rescan or the .md
      //       carries the old asset's data under the new asset's name.
      try {
        const { relativePath: postRel } = await syncSingleAsset(projectRoot, entry.path);
        touchedRels.push(postRel);
      } catch (rescanErr) {
        // Don't let a rescan failure invalidate the rename — the rename
        // already succeeded.  Surface the warning in the outcome message
        // so the user can retry the rescan manually if they care.
        const msg = rescanErr instanceof Error ? rescanErr.message : String(rescanErr);
        // eslint-disable-next-line no-console
        console.warn('[syncEngine] post-rename rescan failed:', msg);
      }
      stale.removeRename(entry.path, entry.previousPath);
      outcome = { entry, ok: true, action: 'renamed' };
    } else if (entry.type === 'removed') {
      const rel = lookupRel(entry);
      if (!rel) {
        // No .md to delete; just dismiss.
        stale.removePath(entry.path);
        outcome = { entry, ok: true, action: 'dismissed' };
      } else {
        await deleteVaultFile(projectRoot, rel);
        touchedRels.push(rel);
        stale.removePath(entry.path);
        outcome = { entry, ok: true, action: 'deleted' };
      }
    } else {
      outcome = { entry, ok: false, action: 'skipped', message: `unknown event type ${(entry as StaleEntry).type}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { entry, ok: false, action: 'skipped', message: msg };
  }

  // Invalidate the per-file cache for every touched .md so the Lv2 tab
  // re-fetches fresh content on next render.  Without this, the UI keeps
  // showing pre-rescan frontmatter (deleted function still in
  // exports_functions, stale ast_hash, etc).
  if (touchedRels.length > 0) {
    const invalidate = useVaultStore.getState().invalidateFile;
    for (const rel of touchedRels) invalidate(rel);
  }

  // Optional LLM enrichment for added/updated.  Currently a stub — see
  // services/llmSync.ts.  Toggle is honoured only when capability is live;
  // otherwise we silently skip so the user's preference doesn't get lost.
  if (
    outcome.ok &&
    opts.withLlm &&
    isLlmAnalysisAvailable() &&
    (entry.type === 'added' || entry.type === 'updated')
  ) {
    const r = await runLlmAnalysisForAsset(projectRoot, entry.path);
    outcome.llmRan = r.ok;
    if (!r.ok && r.reason) outcome.message = `${outcome.message ?? ''} · LLM: ${r.reason}`.trim();
  }

  if (outcome.ok) {
    useSyncSettingsStore.getState().setLastSyncedAt(Date.now());
  }
  return outcome;
}

// ---- Bulk apply ----------------------------------------------------------
// Drives the "Apply all" button.  Sorts by priority (added → updated →
// renamed → removed) and walks them sequentially so a single transient
// failure doesn't avalanche.  Refreshes the vault index ONCE at the end
// for sidebar redraw.

export async function applyAll(opts: BatchSyncOptions = {}): Promise<BatchSyncReport> {
  const stale = useStaleStore.getState();
  const all = Array.from(stale.staleByPath.values());
  const filtered = opts.filter ? all.filter(opts.filter) : all;
  const sorted = filtered.slice().sort(compareByPriority);

  const outcomes: SyncOutcome[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const e of sorted) {
    const o = await applyOne(e, { withLlm: opts.withLlm });
    outcomes.push(o);
    if (o.ok) succeeded++;
    else failed++;
    opts.onProgress?.(outcomes.length, sorted.length, o);
  }

  if (succeeded > 0) {
    try { await useVaultStore.getState().loadIndex(); } catch { /* sidebar refresh non-fatal */ }
  }

  return { total: sorted.length, succeeded, failed, outcomes };
}

// ---- Auto-sync hook (called from staleSync.ts after each poll) ------------
// Honours the persisted preferences.  When autoSyncEnabled is on, applies
// every entry whose type is included in autoSyncCategories.  The user's
// removed-default-off setting protects against accidental UE deletes.

export async function maybeAutoApply(): Promise<BatchSyncReport | null> {
  const settings = useSyncSettingsStore.getState();
  if (!settings.autoSyncEnabled) return null;
  const cats = settings.autoSyncCategories;
  const enabledTypes = new Set<StaleEventType>(
    (Object.entries(cats) as [StaleEventType, boolean][])
      .filter(([, on]) => on)
      .map(([k]) => k),
  );
  if (enabledTypes.size === 0) return null;
  return applyAll({
    withLlm: settings.autoLlmAfterSync,
    filter: (e) => enabledTypes.has(e.type),
  });
}

// ---- Tally helper for the badge / confirm modal --------------------------
// Returns counts of each event type currently in the stale store.  Drives
// the badge angle-corner (🔴2 🟠1 🟢3 ⚫1) and the confirm-before-apply-all
// summary.  Cheap — runs in O(N) where N is the (small) stale set size.

export interface StaleTally {
  added: number;
  updated: number;
  renamed: number;
  removed: number;
  total: number;
  highestPriority: StaleEventType | null;
}

export function tallyStale(): StaleTally {
  const map = useStaleStore.getState().staleByPath;
  const t: StaleTally = { added: 0, updated: 0, renamed: 0, removed: 0, total: 0, highestPriority: null };
  for (const e of map.values()) {
    t[e.type]++;
    t.total++;
  }
  // Pick the highest-priority bucket that's non-empty.
  for (const k of ['added', 'updated', 'renamed', 'removed'] as StaleEventType[]) {
    if (t[k] > 0) { t.highestPriority = k; break; }
  }
  return t;
}

export function priorityFor(type: StaleEventType) { return PRIORITY[type]; }

function assetName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.split('.')[0] ?? last;
}
