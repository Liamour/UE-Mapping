// Project-scan orchestration logic, extracted so both the Settings panel
// (ScanOrchestrator) and the L1 view's "Run project scan" button can share
// the same multi-stage state machine.
//
// Pipeline:
//   L2 stage (optional, default on):
//     1. Bridge: list blueprint assets in /Game/
//     2. Bridge: deep-scan each (concurrency-limited) → CRC32 fingerprint
//     3. POST /api/v1/scan/batch                          → backend LLM pass
//     4. Poll /api/v1/scan/status/{task_id}               → live progress
//   L1 stage (optional, default on; requires L2 data in vault):
//     5. POST /api/v1/scan/l1                             → project clustering
//     6. Poll /api/v1/scan/status/{task_id}               → single-node status

import {
  bridgeListBlueprintAssets,
  bridgeRequestDeepScan,
  bridgeGetReflectionAssetSummary,
  isReflectionSummaryAvailable,
  type BridgeAssetEntry,
  type BridgeAssetSummary,
  type BridgeDeepScanResult,
} from './bridgeApi';
import {
  postScanBatch,
  postL1Scan,
  pollScanUntilDone,
  BackendUnreachableError,
  BackendDegradedError,
  type ScanStatus,
  type ProviderConfigPayload,
} from './scanApi';
import { buildScanNodeFromBridge } from './scanPayload';

const DEEP_SCAN_CONCURRENCY = 8;

export interface ScanFailure {
  asset_path: string;
  reason: string;
}

export type ProjectScanPhase =
  | { kind: 'idle' }
  | { kind: 'listing' }
  | { kind: 'fingerprinting'; done: number; total: number; failures: ScanFailure[] }
  // A2 reflection enrichment — runs between fingerprinting and L2 submit
  // when the C++ bridge exposes getreflectionassetsummary.  Pulls UFUNCTION
  // flags + UPROPERTY metadata + class-level deps for each asset so the
  // LLM scan has authoritative structural context (and stops hallucinating
  // function names / property types).  Skipped silently on older plugin.
  | { kind: 'enriching'; done: number; total: number; failures: ScanFailure[] }
  | { kind: 'l2-submitting' }
  | { kind: 'l2-scanning'; status: ScanStatus; failures: ScanFailure[] }
  | { kind: 'l1-submitting' }
  | { kind: 'l1-scanning'; status: ScanStatus; failures: ScanFailure[] }
  | {
      kind: 'done';
      l2Status: ScanStatus | null;
      l1Status: ScanStatus | null;
      submitted: number;
      skippedLocal: number;
      failures: ScanFailure[];
    }
  | { kind: 'error'; message: string; failures: ScanFailure[] };

export interface ProjectScanOptions {
  projectRoot: string;
  providerConfig: ProviderConfigPayload;
  scope: { l2: boolean; l1: boolean };
  signal: AbortSignal;
  onPhase: (phase: ProjectScanPhase) => void;
  // When set, the L1 stage runs in single-system mode (one LLM call scoped
  // to that system tag) instead of batch-over-all-systems.  The Lv1 page
  // button passes this through with its current systemId so the user can
  // refresh just one system without spending tokens on the others.  Has no
  // effect on the L2 stage — batch L2 either runs (per scope.l2) or doesn't.
  systemId?: string;
}

export async function runProjectScan(opts: ProjectScanOptions): Promise<ProjectScanPhase> {
  const { projectRoot, providerConfig, scope, signal, onPhase, systemId } = opts;
  const failures: ScanFailure[] = [];
  let l2Status: ScanStatus | null = null;
  let l1Status: ScanStatus | null = null;
  let submitted = 0;
  let skippedLocal = 0;

  try {
    // ── L2 stage ───────────────────────────────────────────────────────────
    if (scope.l2) {
      onPhase({ kind: 'listing' });
      const assets = await bridgeListBlueprintAssets(projectRoot);

      if (assets.length === 0) {
        // No assets at all — skip both stages and report empty done.
        const phase: ProjectScanPhase = {
          kind: 'done',
          l2Status: emptyStatus(),
          l1Status: null,
          submitted: 0,
          skippedLocal: 0,
          failures,
        };
        onPhase(phase);
        return phase;
      }

      onPhase({ kind: 'fingerprinting', done: 0, total: assets.length, failures });
      const fingerprints = await fingerprintAll(
        assets, failures,
        (done) => onPhase({ kind: 'fingerprinting', done, total: assets.length, failures: [...failures] }),
        signal,
      );

      // No category filter any more — the L1/L2 toggle replaces it.  Backend
      // dedups against scan-manifest.json so unchanged BPs short-circuit there.
      const fresh = fingerprints;
      submitted = fresh.length;

      if (fresh.length === 0) {
        // No assets needed re-scanning.  Still allow L1 to run if user opted in.
        l2Status = emptyStatus();
      } else {
        // Build a stable asset_path → asset name index so we emit edges with
        // the same `target = name` convention frameworkScan uses.  The L1
        // force graph and Lv2 view both look up edges via title-keyed maps,
        // so passing full /Game/Path/BP.BP through would break edge rendering.
        const assetPathToName: Record<string, string> = {};
        for (const r of fresh) assetPathToName[r.asset_path] = r.name;

        // ── A2 Reflection enrichment ────────────────────────────────────────
        // For each fingerprinted asset, also pull the Reflection-derived
        // summary (UFUNCTION flags / UPROPERTY metadata / class-level deps)
        // when the bridge exposes it.  We do this AFTER deepscan so a single
        // worker can fingerprint + enrich without serial bridge calls per
        // asset (more pleasant progress UX).  Failures are collected as
        // failures[] entries but never block the scan — the LLM just gets
        // less context for that asset.
        const reflectionByAsset = new Map<string, BridgeAssetSummary>();
        if (isReflectionSummaryAvailable()) {
          onPhase({ kind: 'enriching', done: 0, total: fresh.length, failures: [...failures] });
          await enrichWithReflection(
            fresh, reflectionByAsset, failures,
            (done) => onPhase({
              kind: 'enriching', done, total: fresh.length, failures: [...failures],
            }),
            signal,
          );
        }

        // Build payload through the shared helper.  Both batch and single-node
        // scan paths funnel through services/scanPayload.ts so they ship
        // identical ast_data shapes (exports / components / edges) — the LLM
        // and the vault writer see the same view of the AST regardless of
        // which entry point triggered the scan.  See §15.7 in HANDOFF.md.
        const payload = fresh.map((r) =>
          buildScanNodeFromBridge(
            r, deriveNodeId(r), assetPathToName,
            reflectionByAsset.get(r.asset_path) ?? null,
          ),
        );

        onPhase({ kind: 'l2-submitting' });
        const { task_id } = await postScanBatch({
          nodes: payload,
          project_root: projectRoot,
          provider_config: providerConfig,
        });

        const initialStatus: ScanStatus = {
          task_id, status: 'PENDING',
          total_nodes: payload.length,
          completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0,
          node_statuses: {},
        };
        onPhase({ kind: 'l2-scanning', status: initialStatus, failures });

        l2Status = await pollScanUntilDone(task_id, {
          intervalMs: 1500,
          signal,
          onProgress: (status) =>
            onPhase({ kind: 'l2-scanning', status, failures: [...failures] }),
        });

        for (const [nodeId, st] of Object.entries(l2Status.node_statuses ?? {})) {
          if (st === 'FAILED') {
            const sourceAsset = payload.find((p) => p.node_id === nodeId)?.asset_path ?? nodeId;
            // Pull the real exception text the backend persisted to Redis.
            // Falls back to the generic placeholder when the backend pre-dates
            // the node_errors field (older uvicorn build).
            const reason =
              l2Status.node_errors?.[nodeId] ?? 'backend marked node FAILED (no error text persisted — check uvicorn console)';
            failures.push({ asset_path: sourceAsset, reason });
          }
        }
      }
    }

    // ── L1 stage ───────────────────────────────────────────────────────────
    // Per Phase 2 refactor: backend `/scan/l1` dispatches on `systemId`.
    // Without it → batch (every discovered system, sequentially).  With it →
    // single-system.  Either way the polling schema is identical; total_nodes
    // becomes the system count for the progress bar.
    if (scope.l1) {
      onPhase({ kind: 'l1-submitting' });
      const { task_id } = await postL1Scan({
        project_root: projectRoot,
        provider_config: providerConfig,
        systemId,    // undefined ⇒ batch all systems
      });

      const initialL1: ScanStatus = {
        task_id, status: 'PENDING',
        // total_nodes is 0 for batch (set in worker once it discovers
        // systems) and 1 for single-system; the polling reconciles it.
        total_nodes: systemId ? 1 : 0,
        completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0,
        node_statuses: {},
      };
      onPhase({ kind: 'l1-scanning', status: initialL1, failures });

      l1Status = await pollScanUntilDone(task_id, {
        intervalMs: 2000,
        signal,
        onProgress: (status) =>
          onPhase({ kind: 'l1-scanning', status, failures: [...failures] }),
      });

      // Surface per-system failures via node_errors (single source of truth
      // since the diag commit added per-node error persistence).
      for (const [sid, st] of Object.entries(l1Status.node_statuses ?? {})) {
        if (st === 'FAILED') {
          const reason = l1Status.node_errors?.[sid]
            ?? 'backend marked system FAILED (no error text persisted — check uvicorn console)';
          failures.push({ asset_path: `<L1: ${sid}>`, reason });
        }
      }
      // Task-level error (provider init / no systems found / etc.) — only
      // surface when no per-system rows captured a real reason.
      if (l1Status.status === 'FAILED' && !Object.values(l1Status.node_statuses ?? {}).includes('FAILED')) {
        failures.push({
          asset_path: '<L1 batch>',
          reason: l1Status.error
            ?? 'backend L1 task FAILED (no error text persisted — check uvicorn console)',
        });
      }
    }

    const finalPhase: ProjectScanPhase = {
      kind: 'done',
      l2Status,
      l1Status,
      submitted,
      skippedLocal,
      failures,
    };
    onPhase(finalPhase);
    return finalPhase;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      const aborted: ProjectScanPhase = { kind: 'idle' };
      onPhase(aborted);
      return aborted;
    }
    const errPhase: ProjectScanPhase = {
      kind: 'error',
      message: formatError(e),
      failures,
    };
    onPhase(errPhase);
    return errPhase;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function emptyStatus(): ScanStatus {
  return {
    task_id: '', status: 'COMPLETED',
    total_nodes: 0, completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0,
    node_statuses: {},
  };
}

async function fingerprintAll(
  assets: BridgeAssetEntry[],
  failures: ScanFailure[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<BridgeDeepScanResult[]> {
  const results: BridgeDeepScanResult[] = [];
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < assets.length) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const idx = cursor++;
      const asset = assets[idx];
      try {
        const r = await bridgeRequestDeepScan(asset.asset_path);
        results.push(r);
      } catch (e) {
        failures.push({ asset_path: asset.asset_path, reason: formatError(e) });
      } finally {
        done++;
        onProgress(done);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(DEEP_SCAN_CONCURRENCY, assets.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ── A2 enrichment helper ─────────────────────────────────────────────────
// Walks the same asset list a second time, pulling reflection summaries
// in parallel (same concurrency cap as deepscan).  Mutates `out` in place.
// Failures land in `failures` but are non-fatal — the asset still goes
// through the LLM scan, just without flag tokens / properties context.
async function enrichWithReflection(
  fresh: BridgeDeepScanResult[],
  out: Map<string, BridgeAssetSummary>,
  failures: ScanFailure[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<void> {
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < fresh.length) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const idx = cursor++;
      const r = fresh[idx];
      try {
        const summary = await bridgeGetReflectionAssetSummary(r.asset_path);
        out.set(r.asset_path, summary);
      } catch (e) {
        // Reflection failures are non-fatal — log them but let the scan
        // proceed.  Common case: an asset that's a non-UClass (e.g.
        // a DataAsset before Phase B widens the bridge filter).  The LLM
        // just won't see properties / flags for that one.
        failures.push({
          asset_path: r.asset_path,
          reason: `reflection summary failed: ${formatError(e)}`,
        });
      } finally {
        done++;
        onProgress(done);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(DEEP_SCAN_CONCURRENCY, fresh.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

function deriveNodeId(r: BridgeDeepScanResult): string {
  if (r.name) return r.name;
  const tail = r.asset_path.split('/').pop() ?? r.asset_path;
  return tail.split('.').pop() || tail;
}

function formatError(e: unknown): string {
  if (e instanceof BackendUnreachableError) return e.message;
  if (e instanceof BackendDegradedError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// (Edge mapping + outbound assembly moved to services/scanPayload.ts so
// single-node Deep reasoning shares the exact same vocabulary.)
