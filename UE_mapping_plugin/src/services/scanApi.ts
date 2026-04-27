// HTTP client for the Python backend's batch scan pipeline.  Used by the
// ScanOrchestrator after it gathers AST fingerprints from the C++ bridge.
//
// Flow:
//   1. POST /api/v1/scan/batch   → returns { task_id }
//   2. Poll GET /api/v1/scan/status/{task_id} every ~1.5s until status leaves PENDING/PROCESSING
//
// All endpoints require Redis on the backend; the POST returns 503 if Redis
// is unavailable.  We surface that as a typed error so the UI can route the
// user to start uvicorn.

const API_BASE = 'http://localhost:8000';

// Matches backend's ASTNodePayload (see backend/main.py:86).  We keep the
// edge list empty here — the C++ deep-scan only returns hash+metadata, not
// the graph itself.  The backend's LLM will still have node_id/asset_path
// to anchor its analysis on, and ast_data carries our CRC32 so its
// compute_ast_hash() yields a stable per-Blueprint value for dedup.
export interface ScanBatchNode {
  node_id: string;
  asset_path: string;
  title: string;
  node_type: string;
  parent_class?: string;
  ast_data: Record<string, unknown> | null;
  outbound_edges: never[];
}

export interface ScanBatchRequest {
  nodes: ScanBatchNode[];
  project_root: string;
}

export interface ScanBatchResponse {
  task_id: string;
}

export interface ScanStatus {
  task_id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_FAIL' | 'FAILED' | string;
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
  skipped_nodes: number;
  node_statuses: Record<string, string>;
}

export class BackendUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnreachableError';
  }
}

export class BackendDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendDegradedError';
  }
}

export async function postScanBatch(req: ScanBatchRequest): Promise<ScanBatchResponse> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/v1/scan/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (e) {
    throw new BackendUnreachableError(
      `Cannot reach backend at ${API_BASE} — start uvicorn with \`uvicorn main:app --reload\` from the backend/ directory.`,
    );
  }
  if (r.status === 503) {
    throw new BackendDegradedError('Backend is up but Redis is unavailable — scan pipeline cannot run.');
  }
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`scan/batch HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as ScanBatchResponse;
}

export async function getScanStatus(taskId: string): Promise<ScanStatus> {
  const r = await fetch(`${API_BASE}/api/v1/scan/status/${encodeURIComponent(taskId)}`);
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`scan/status HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as ScanStatus;
}

// Wait for a scan task to leave PENDING/PROCESSING.  Calls onProgress with
// every poll so the UI can update its progress bar.  Caller can abort via
// the abort signal — we honour it between polls.
export async function pollScanUntilDone(
  taskId: string,
  opts: {
    intervalMs?: number;
    onProgress?: (status: ScanStatus) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ScanStatus> {
  const interval = opts.intervalMs ?? 1500;
  while (true) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await getScanStatus(taskId);
    opts.onProgress?.(status);
    if (status.status !== 'PENDING' && status.status !== 'PROCESSING') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function safeReadDetail(r: Response): Promise<string | undefined> {
  try {
    const j = await r.json();
    if (j && typeof j === 'object' && 'detail' in j) {
      const d = (j as { detail: unknown }).detail;
      return typeof d === 'string' ? d : JSON.stringify(d);
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}
