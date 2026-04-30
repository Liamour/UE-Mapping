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

// One outbound edge sent to the backend's ASTNodePayload.outbound_edges.
// `target` is the asset name (e.g. "BP_Tree") so the frontend's title→path
// index can resolve it without a second lookup; `edge_type` follows the
// vault vocabulary (function_call | cast | spawn | listens_to | inheritance).
// `refs` carries human-readable call-site labels ("BeginPlay → DoStuff");
// `label` is reserved for a future short summary.
export interface ScanBatchEdge {
  target: string;
  edge_type: string;
  refs?: string[];
  label?: string;
}

// Matches backend's ASTNodePayload (see backend/main.py:190).  outbound_edges
// is populated by the orchestrator from the C++ deep-scan result so the LLM
// pass can reason about call/cast/spawn/inheritance topology and the vault
// writer can persist an `edges:` block in frontmatter.
export interface ScanBatchNode {
  node_id: string;
  asset_path: string;
  title: string;
  node_type: string;
  parent_class?: string;
  ast_data: Record<string, unknown> | null;
  outbound_edges: ScanBatchEdge[];
}

// Mirrors backend ProviderConfig.  api_key is the user's localStorage value;
// it travels with every request and is discarded server-side.
// `language` is the narrative output language for LLM-generated text — when
// "zh" the backend appends a directive to the system prompt asking for
// Simplified Chinese in intent / ANALYSIS body; tag values stay English.
export interface ProviderConfigPayload {
  provider: 'volcengine' | 'claude';
  api_key: string;
  endpoint?: string;
  model?: string;
  effort?: string;
  concurrency?: number;
  language?: 'en' | 'zh';
}

export interface ScanBatchRequest {
  nodes: ScanBatchNode[];
  project_root: string;
  provider_config: ProviderConfigPayload;
}

export interface ScanBatchResponse {
  task_id: string;
}

export interface SingleScanRequest {
  node: ScanBatchNode;
  project_root: string;
  provider_config: ProviderConfigPayload;
}

export interface SingleScanResponse {
  ok: true;
  vault_path?: string;
  ast_hash?: string;
  notes_review_needed?: boolean;
  intent: string | null;
  tags: string[];
  risk_level: string;
  parse_ok: boolean;
  analysis_markdown: string;
  tokens_in: number;
  tokens_out: number;
  thinking_tokens: number;
}

export interface TestConnectionResponse {
  ok: true;
  provider: string;
  model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  thinking_tokens: number;
  sample_text: string;
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

// ─────────────────────────────────────────────────────────────────────────
// Single-node scan (for "Deep reasoning" button) and connection test.
// Both endpoints accept provider_config in the body and are synchronous —
// the caller awaits the LLM round-trip directly, so we surface clean errors
// (HTTP status + detail) for the Settings panel to display.
// ─────────────────────────────────────────────────────────────────────────

export async function postSingleScan(req: SingleScanRequest): Promise<SingleScanResponse> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/v1/scan/single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (e) {
    throw new BackendUnreachableError(
      `Cannot reach backend at ${API_BASE} — start uvicorn with \`uvicorn main:app --reload\` from the backend/ directory.`,
    );
  }
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`scan/single HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as SingleScanResponse;
}

// ─────────────────────────────────────────────────────────────────────────
// L1 (project-level) clustering — runs after a successful L2 batch.  The
// backend reads existing per-blueprint frontmatter from the vault, so this
// request only carries project_root + provider_config.  Status reuses the
// same /scan/status/{task_id} schema as batch (total_nodes = blueprint count
// the L1 pass examined; a single COMPLETED/FAILED transition once the LLM
// returns and the overview file is written).
// ─────────────────────────────────────────────────────────────────────────

export interface L1ScanRequest {
  project_root: string;
  provider_config: ProviderConfigPayload;
}

export async function postL1Scan(req: L1ScanRequest): Promise<ScanBatchResponse> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/v1/scan/l1`, {
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
    throw new BackendDegradedError('Backend is up but Redis is unavailable — L1 scan cannot run.');
  }
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`scan/l1 HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as ScanBatchResponse;
}

export async function postTestConnection(config: ProviderConfigPayload): Promise<TestConnectionResponse> {
  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/v1/llm/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider_config: config }),
    });
  } catch (e) {
    throw new BackendUnreachableError(
      `Cannot reach backend at ${API_BASE} — start uvicorn first.`,
    );
  }
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`test-connection HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as TestConnectionResponse;
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-BP call trace (A3 — HANDOFF §19.3 + §21.5).  Drives the Lv4 view.
// Backend walks the vault, BFSes outbound edges from a root asset_path, and
// returns nodes (with their BFS layer_distance) + edges suitable for a
// concentric-ring force layout.  Bounded by max_depth + max_nodes so a hub
// BP can't explode the request — the response carries a `truncated` flag
// the UI surfaces honestly when limits cut the frontier short.
// ─────────────────────────────────────────────────────────────────────────

export type CallTraceEdgeType =
  | 'function_call'
  | 'interface_call'
  | 'cast'
  | 'spawn'
  | 'listens_to'
  | 'inheritance'
  | 'delegate'
  | string;            // forward-compat: backend may add new types

export interface CallTraceNode {
  asset_path: string;
  title: string;
  layer: number;       // BFS distance from root (root = 0)
  node_type: string;
  intent?: string | null;
  risk_level?: string;
  // Set when the BFS hit an asset that's referenced by an edge but doesn't
  // have its own .md in the vault yet (race against a partial scan).  The
  // UI renders these as ghost nodes so the call chain still reads.
  missing?: boolean;
}

export interface CallTraceEdge {
  source: string;       // asset_path
  target: string;       // asset_path
  edge_type: CallTraceEdgeType;
  refs: string[];       // human-readable call-site labels
}

export interface CallTraceResponse {
  root: string;
  max_depth: number;
  max_nodes: number;
  edge_types: CallTraceEdgeType[] | null;
  nodes: CallTraceNode[];
  edges: CallTraceEdge[];
  truncated: boolean;
}

export interface CallTraceQuery {
  projectRoot: string;
  rootAssetPath: string;
  maxDepth?: number;
  maxNodes?: number;
  edgeTypes?: CallTraceEdgeType[];   // omit / empty = all types
}

export async function getCallTrace(q: CallTraceQuery): Promise<CallTraceResponse> {
  const params = new URLSearchParams({
    project_root: q.projectRoot,
    root_asset_path: q.rootAssetPath,
  });
  if (q.maxDepth !== undefined) params.set('max_depth', String(q.maxDepth));
  if (q.maxNodes !== undefined) params.set('max_nodes', String(q.maxNodes));
  if (q.edgeTypes && q.edgeTypes.length > 0) {
    params.set('edge_types', q.edgeTypes.join(','));
  }

  let r: Response;
  try {
    r = await fetch(`${API_BASE}/api/v1/calltrace?${params.toString()}`);
  } catch {
    throw new BackendUnreachableError(
      `Cannot reach backend at ${API_BASE} — start uvicorn first.`,
    );
  }
  if (r.status === 404) {
    const detail = await safeReadDetail(r);
    throw new Error(detail ?? 'No vault note found for the requested asset.');
  }
  if (!r.ok) {
    const detail = await safeReadDetail(r);
    throw new Error(`calltrace HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await r.json()) as CallTraceResponse;
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
