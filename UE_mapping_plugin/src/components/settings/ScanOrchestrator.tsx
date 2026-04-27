// "Scan project" wizard surfaced inside SettingsModal.
//
// Flow:
//   1. ListBlueprintAssets via C++ bridge        → N assets in /Game/
//   2. RequestDeepScan each (concurrency-limited) → CRC32 fingerprint per asset
//   3. Filter against vault manifest               → skip assets whose ast_hash already matches
//   4. POST /api/v1/scan/batch                     → backend kicks LLM pipeline
//   5. Poll /api/v1/scan/status/{id} every 1.5s   → live progress
//   6. loadIndex()                                  → refresh vault store
//
// Visible only when the deep-scan UFUNCTIONs are bound (i.e. the C++ plugin
// has been rebuilt past the old broadcast-only RequestDeepScan signature).
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  bridgeListBlueprintAssets,
  bridgeRequestDeepScan,
  isDeepScanAvailable,
  type BridgeAssetEntry,
  type BridgeDeepScanResult,
} from '../../services/bridgeApi';
import {
  postScanBatch,
  pollScanUntilDone,
  BackendUnreachableError,
  BackendDegradedError,
  type ScanBatchNode,
  type ScanStatus,
} from '../../services/scanApi';
import { useVaultStore } from '../../store/useVaultStore';

const DEEP_SCAN_CONCURRENCY = 8;

type Phase =
  | { kind: 'idle' }
  | { kind: 'listing' }
  | { kind: 'fingerprinting'; done: number; total: number; failures: ScanFailure[] }
  | { kind: 'submitting' }
  | { kind: 'scanning'; status: ScanStatus; failures: ScanFailure[] }
  | { kind: 'done'; status: ScanStatus; submitted: number; skippedLocal: number; failures: ScanFailure[] }
  | { kind: 'error'; message: string; failures: ScanFailure[] };

interface ScanFailure {
  asset_path: string;
  reason: string;
}

export const ScanOrchestrator: React.FC = () => {
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const manifest = useVaultStore((s) => s.manifest);
  const loadIndex = useVaultStore((s) => s.loadIndex);

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const available = useMemo(() => isDeepScanAvailable(), []);
  const canRun = available && !!projectRoot && (phase.kind === 'idle' || phase.kind === 'done' || phase.kind === 'error');

  const start = useCallback(async () => {
    if (!projectRoot) return;
    const abort = new AbortController();
    abortRef.current = abort;
    const failures: ScanFailure[] = [];

    try {
      setPhase({ kind: 'listing' });
      const assets = await bridgeListBlueprintAssets(projectRoot);
      if (assets.length === 0) {
        setPhase({ kind: 'done', status: emptyStatus(), submitted: 0, skippedLocal: 0, failures });
        return;
      }

      setPhase({ kind: 'fingerprinting', done: 0, total: assets.length, failures });
      const fingerprints = await fingerprintAll(assets, failures, (done) => {
        setPhase({ kind: 'fingerprinting', done, total: assets.length, failures: [...failures] });
      }, abort.signal);

      // Local dedup: skip anything whose CRC matches the previous scan's hash.
      // The backend does its own dedup too, but trimming here avoids round-tripping
      // unchanged assets to Redis at all.
      const { fresh, skippedLocal } = dedupAgainstManifest(fingerprints, manifest);

      if (fresh.length === 0) {
        setPhase({
          kind: 'done',
          status: emptyStatus(),
          submitted: 0,
          skippedLocal,
          failures,
        });
        return;
      }

      setPhase({ kind: 'submitting' });
      const payload: ScanBatchNode[] = fresh.map((r) => ({
        node_id: deriveNodeId(r),
        asset_path: r.asset_path,
        title: r.name,
        node_type: r.node_type,
        parent_class: r.parent_class || undefined,
        // Encode the C++ fingerprint into ast_data so the backend's
        // compute_ast_hash() yields a stable per-Blueprint value.  We also
        // include the asset_path so the SHA1 input differs across nodes when
        // multiple BPs happen to share the same CRC.
        ast_data: { ast_hash: r.ast_hash, asset_path: r.asset_path },
        outbound_edges: [],
      }));

      const { task_id } = await postScanBatch({ nodes: payload, project_root: projectRoot });

      setPhase({
        kind: 'scanning',
        status: { task_id, status: 'PENDING', total_nodes: payload.length, completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0, node_statuses: {} },
        failures,
      });

      const finalStatus = await pollScanUntilDone(task_id, {
        intervalMs: 1500,
        signal: abort.signal,
        onProgress: (status) => {
          setPhase({ kind: 'scanning', status, failures: [...failures] });
        },
      });

      // Surface backend-side per-node FAILED entries
      for (const [nodeId, st] of Object.entries(finalStatus.node_statuses ?? {})) {
        if (st === 'FAILED') {
          const sourceAsset = payload.find((p) => p.node_id === nodeId)?.asset_path ?? nodeId;
          failures.push({ asset_path: sourceAsset, reason: 'backend marked node FAILED' });
        }
      }

      // Refresh vault so the new files appear in the left pane immediately.
      try { await loadIndex(); } catch (e) { console.warn('[scan] loadIndex failed', e); }

      setPhase({
        kind: 'done',
        status: finalStatus,
        submitted: payload.length,
        skippedLocal,
        failures,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setPhase({ kind: 'idle' });
        return;
      }
      const message = formatError(e);
      setPhase({ kind: 'error', message, failures });
    } finally {
      abortRef.current = null;
    }
  }, [projectRoot, manifest, loadIndex]);

  const cancel = () => {
    abortRef.current?.abort();
  };

  if (!available) return null;

  return (
    <div className="scan-orchestrator">
      <div className="scan-orchestrator-actions">
        <button
          className="btn-primary"
          onClick={start}
          disabled={!canRun}
          title={projectRoot ? 'Walk /Game/, fingerprint every Blueprint, then ship the diff to the backend LLM pipeline' : 'Set a project root first'}
        >
          Scan project
        </button>
        {(phase.kind === 'fingerprinting' || phase.kind === 'submitting' || phase.kind === 'scanning') && (
          <button className="btn-text" onClick={cancel}>Cancel</button>
        )}
      </div>
      <PhaseView phase={phase} />
    </div>
  );
};

// ---- Phase rendering ------------------------------------------------------

const PhaseView: React.FC<{ phase: Phase }> = ({ phase }) => {
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'listing':
      return <div className="settings-status">Listing Blueprints from /Game/…</div>;
    case 'fingerprinting': {
      const pct = phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100);
      return (
        <div className="settings-status">
          <div>Fingerprinting AST: {phase.done} / {phase.total}</div>
          <ProgressBar pct={pct} />
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'submitting':
      return <div className="settings-status">Submitting batch to backend…</div>;
    case 'scanning': {
      const total = phase.status.total_nodes || 1;
      const finished = phase.status.completed_nodes + phase.status.failed_nodes + phase.status.skipped_nodes;
      const pct = Math.round((finished / total) * 100);
      return (
        <div className="settings-status">
          <div>
            LLM scan: {finished} / {total}{' '}
            <span className="muted">
              ({phase.status.completed_nodes} done · {phase.status.skipped_nodes} skipped · {phase.status.failed_nodes} failed)
            </span>
          </div>
          <ProgressBar pct={pct} />
          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>task: <code>{phase.status.task_id}</code></div>
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'done': {
      const s = phase.status;
      const wrote = s.completed_nodes;
      const summary = phase.submitted === 0
        ? phase.skippedLocal > 0
          ? `Up to date — all ${phase.skippedLocal} Blueprint(s) match the previous scan hash.`
          : 'No Blueprint assets found in /Game/.'
        : `Wrote ${wrote} vault file(s) · ${s.skipped_nodes + phase.skippedLocal} skipped (unchanged) · ${s.failed_nodes} failed.`;
      return (
        <div className="settings-status">
          <div>{summary}</div>
          {phase.submitted > 0 && <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>final status: <code>{s.status}</code></div>}
          <FailureList failures={phase.failures} />
        </div>
      );
    }
    case 'error':
      return (
        <div className="settings-status settings-status-error">
          <div>{phase.message}</div>
          <FailureList failures={phase.failures} />
        </div>
      );
  }
};

const ProgressBar: React.FC<{ pct: number }> = ({ pct }) => (
  <div className="scan-progress">
    <div className="scan-progress-fill" style={{ width: `${pct}%` }} />
  </div>
);

const FailureList: React.FC<{ failures: ScanFailure[] }> = ({ failures }) => {
  if (failures.length === 0) return null;
  return (
    <details className="scan-failures">
      <summary>{failures.length} failure(s)</summary>
      <ul>
        {failures.map((f) => (
          <li key={f.asset_path}>
            <code>{f.asset_path}</code> — {f.reason}
          </li>
        ))}
      </ul>
    </details>
  );
};

// ---- Helpers --------------------------------------------------------------

function emptyStatus(): ScanStatus {
  return { task_id: '', status: 'COMPLETED', total_nodes: 0, completed_nodes: 0, failed_nodes: 0, skipped_nodes: 0, node_statuses: {} };
}

// Pool-based concurrency limiter — fires DEEP_SCAN_CONCURRENCY requests at
// once and starts the next as each finishes.  Failures are recorded but do
// not abort the pool.
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

  const workers = Array.from({ length: Math.min(DEEP_SCAN_CONCURRENCY, assets.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function dedupAgainstManifest(
  fingerprints: BridgeDeepScanResult[],
  manifest: Record<string, { ast_hash?: string }>,
): { fresh: BridgeDeepScanResult[]; skippedLocal: number } {
  // The backend's manifest indexes by node_id (the asset name in our case).
  // We only skip when both sides have a hash AND they match — anything
  // missing from the manifest must be sent so the backend can scan it fresh.
  let skippedLocal = 0;
  const fresh: BridgeDeepScanResult[] = [];
  for (const r of fingerprints) {
    const nodeId = deriveNodeId(r);
    const known = manifest[nodeId]?.ast_hash;
    // The manifest stores the SHA1-of-ast_data hash, not the raw CRC32.
    // Since we wrap the CRC into ast_data and let the backend hash that, we
    // can't trivially compare here — so for now defer dedup to the backend
    // and keep `fresh` = all results.  Track the manifest lookup just so
    // future enhancements can compare a stored CRC tag if we add one.
    void known;
    fresh.push(r);
  }
  return { fresh, skippedLocal };
}

function deriveNodeId(r: BridgeDeepScanResult): string {
  // The vault writer's NodeRecord uses node_id verbatim as the file stem.
  // Use the asset name (last segment of CleanPath after the dot) so we get
  // stable, human-readable filenames like BP_PlayerCharacter.md.
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
