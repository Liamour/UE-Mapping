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
  type BridgeAssetEntry,
  type BridgeDeepScanResult,
} from './bridgeApi';
import {
  postScanBatch,
  postL1Scan,
  pollScanUntilDone,
  BackendUnreachableError,
  BackendDegradedError,
  type ScanBatchNode,
  type ScanBatchEdge,
  type ScanStatus,
  type ProviderConfigPayload,
} from './scanApi';

const DEEP_SCAN_CONCURRENCY = 8;

export interface ScanFailure {
  asset_path: string;
  reason: string;
}

export type ProjectScanPhase =
  | { kind: 'idle' }
  | { kind: 'listing' }
  | { kind: 'fingerprinting'; done: number; total: number; failures: ScanFailure[] }
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
}

export async function runProjectScan(opts: ProjectScanOptions): Promise<ProjectScanPhase> {
  const { projectRoot, providerConfig, scope, signal, onPhase } = opts;
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

        const payload: ScanBatchNode[] = fresh.map((r) => ({
          node_id: deriveNodeId(r),
          asset_path: r.asset_path,
          title: r.name,
          node_type: r.node_type,
          parent_class: r.parent_class || undefined,
          ast_data: { ast_hash: r.ast_hash, asset_path: r.asset_path },
          outbound_edges: buildOutboundEdges(r, assetPathToName),
        }));

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
            failures.push({ asset_path: sourceAsset, reason: 'backend marked node FAILED' });
          }
        }
      }
    }

    // ── L1 stage ───────────────────────────────────────────────────────────
    if (scope.l1) {
      onPhase({ kind: 'l1-submitting' });
      const { task_id } = await postL1Scan({
        project_root: projectRoot,
        provider_config: providerConfig,
      });

      const initialL1: ScanStatus = {
        task_id, status: 'PENDING',
        total_nodes: 1, completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0,
        node_statuses: {},
      };
      onPhase({ kind: 'l1-scanning', status: initialL1, failures });

      l1Status = await pollScanUntilDone(task_id, {
        intervalMs: 2000,
        signal,
        onProgress: (status) =>
          onPhase({ kind: 'l1-scanning', status, failures: [...failures] }),
      });

      if (l1Status.status === 'FAILED') {
        failures.push({
          asset_path: '<L1 clustering>',
          reason: 'backend L1 task FAILED — check uvicorn logs for parse/LLM errors',
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

// Convert C++ deep-scan edges into the backend's outbound_edges schema.
// Drops targets that aren't in the scanned set (engine classes, plugin
// content) since the L1/L2 graph can only render in-project links.  Dedups
// (target, edge_type) tuples and accumulates `from_function → target_function`
// labels so the LLM can see how often two BPs interact.
//
// Mirrors frameworkScan.ts mapEdgeKind so vault frontmatter has the same
// edge_type vocabulary regardless of which scan path wrote the file.
function buildOutboundEdges(
  r: BridgeDeepScanResult,
  assetPathToName: Record<string, string>,
): ScanBatchEdge[] {
  const out: ScanBatchEdge[] = [];
  for (const e of r.edges ?? []) {
    const targetName = assetPathToName[e.target_asset];
    if (!targetName) continue;
    const edgeType = mapEdgeKind(e.kind);
    const refLabel = e.target_function
      ? `${e.from_function} → ${e.target_function}`
      : e.from_function;
    const existing = out.find(
      (x) => x.target === targetName && x.edge_type === edgeType,
    );
    if (existing) {
      existing.refs ??= [];
      if (refLabel && !existing.refs.includes(refLabel)) existing.refs.push(refLabel);
    } else {
      out.push({
        target: targetName,
        edge_type: edgeType,
        refs: refLabel ? [refLabel] : [],
      });
    }
  }
  return out;
}

function mapEdgeKind(rawKind: string): string {
  switch (rawKind) {
    case 'call': return 'function_call';
    case 'cast': return 'cast';
    case 'spawn': return 'spawn';
    case 'delegate': return 'listens_to';
    case 'inherits': return 'inheritance';
    default: return rawKind;
  }
}
