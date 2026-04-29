// Thin adapter over the UE CEF bridge (`window.aicartographerbridge`) that
// the C++ plugin binds via SWebBrowser::BindUObject. When the frontend runs
// inside the editor's CEF host, this lets us read/write vault files without a
// running Python backend. Outside the editor, isBridgeAvailable() returns
// false and callers fall back to the HTTP API.

// UE5's CEF binding lowercases UFUNCTION names, so although the C++ side
// declares e.g. `ListVaultFiles`, JS sees `listvaultfiles`. We type the
// JS-side shape with the actual lowercased names that CEF exposes.
interface AICartographerBridge {
  pingbridge?: () => Promise<string> | string;
  sendlogtoue?: (msg: string) => void;
  requestgraphdata?: () => Promise<string> | string;
  requestdeepscan?: (assetPath: string) => Promise<string> | string;
  listblueprintassets?: (projectRoot: string) => Promise<string> | string;

  listvaultfiles?: (projectRoot: string) => Promise<string> | string;
  readvaultfile?: (projectRoot: string, relativePath: string) => Promise<string> | string;
  writevaultnotes?: (projectRoot: string, relativePath: string, content: string) => Promise<string> | string;
  writevaultfile?: (projectRoot: string, relativePath: string, content: string) => Promise<string> | string;
  deletevaultfile?: (projectRoot: string, relativePath: string) => Promise<string> | string;

  readblueprintfunctionflow?: (assetPath: string, functionName: string) => Promise<string> | string;

  openineditor?: (assetPath: string, functionName: string) => Promise<string> | string;

  getstaleeventssince?: (sinceCounter: number) => Promise<string> | string;

  getreflectionassetsummary?: (assetPath: string) => Promise<string> | string;
}

declare global {
  interface Window {
    aicartographerbridge?: AICartographerBridge;
    AICartographerbridge?: AICartographerBridge;
    ue?: { interface?: Record<string, AICartographerBridge>; [k: string]: unknown };
  }
}

// Scan candidate locations where UE5's CEF integration might expose a
// BindUObject'd bridge. Different UE versions use different namespaces.
function findBridge(): { bridge: AICartographerBridge; path: string } | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as any;

  const candidates: Array<{ path: string; ref: unknown }> = [
    { path: 'window.aicartographerbridge', ref: w.aicartographerbridge },
    { path: 'window.AICartographerbridge', ref: w.AICartographerbridge },
    { path: 'window.AICartographerBridge', ref: w.AICartographerBridge },
    { path: 'window.ue?.aicartographerbridge', ref: w.ue?.aicartographerbridge },
    { path: 'window.ue?.interface?.aicartographerbridge', ref: w.ue?.interface?.aicartographerbridge },
    { path: 'window.ue?.AICartographerbridge', ref: w.ue?.AICartographerbridge },
    { path: 'window.ue?.interface?.AICartographerbridge', ref: w.ue?.interface?.AICartographerbridge },
  ];
  for (const c of candidates) {
    if (c.ref && typeof c.ref === 'object') {
      return { bridge: c.ref as AICartographerBridge, path: c.path };
    }
  }
  return undefined;
}

export function getBridge(): AICartographerBridge | undefined {
  return findBridge()?.bridge;
}

export function getBridgePath(): string | undefined {
  return findBridge()?.path;
}

// List window-level globals that look like UE-injected things (used for
// diagnostics in the Settings panel — helps locate where CEF binds objects).
export function getCandidateGlobals(): string[] {
  if (typeof window === 'undefined') return [];
  const w = window as any;
  const out: string[] = [];
  for (const k of Object.getOwnPropertyNames(w)) {
    // skip standard browser globals we know aren't from UE
    if (/^(window|document|location|navigator|history|screen|self|top|parent|frames|console)$/.test(k)) continue;
    if (/^(localStorage|sessionStorage|indexedDB|caches|crypto|performance|origin)$/.test(k)) continue;
    if (/^(setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|fetch|XMLHttpRequest|alert|confirm|prompt)$/.test(k)) continue;
    if (k.startsWith('webkit') || k.startsWith('chrome')) continue;
    const v = w[k];
    const t = typeof v;
    if (t === 'object' || t === 'function') out.push(`${k} : ${t}`);
  }
  return out.sort();
}

export type BridgeStatus =
  | { kind: 'unavailable' }                     // window.aicartographerbridge missing entirely
  | { kind: 'partial'; methods: string[] }      // bridge bound, but vault FS methods missing — needs full C++ rebuild
  | { kind: 'ready'; methods: string[] };       // ListVaultFiles is callable

export function getBridgeStatus(): BridgeStatus & { path?: string } {
  const found = findBridge();
  if (!found) return { kind: 'unavailable' };
  const { bridge: b, path } = found;
  // Enumerate own keys *and* prototype keys; CEF tends to expose methods on
  // the prototype so a plain Object.keys returns nothing useful.
  const seen = new Set<string>();
  for (let proto: object | null = b; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k !== 'constructor') seen.add(k);
    }
  }
  const methods = Array.from(seen).sort();
  if (typeof b.listvaultfiles === 'function') {
    return { kind: 'ready', methods, path };
  }
  return { kind: 'partial', methods, path };
}

export function isBridgeAvailable(): boolean {
  return getBridgeStatus().kind === 'ready';
}

// CEF-bound UFUNCTIONs always return a Promise on the JS side. We accept
// either a string or a Promise<string> for resilience and parse it as JSON.
async function callBridgeJSON<T>(value: Promise<string> | string | undefined, methodName: string): Promise<T> {
  if (value === undefined) {
    throw new Error(`bridge method ${methodName} not bound`);
  }
  const raw = typeof (value as Promise<string>).then === 'function'
    ? await (value as Promise<string>)
    : (value as string);
  if (typeof raw !== 'string') {
    throw new Error(`bridge method ${methodName} returned non-string: ${typeof raw}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`bridge method ${methodName} returned invalid JSON`);
  }
  if (parsed && parsed.ok === false) {
    throw new Error(parsed.error ?? `${methodName} failed`);
  }
  return parsed as T;
}

export async function bridgeListVault(projectRoot: string): Promise<unknown> {
  const b = getBridge();
  if (!b?.listvaultfiles) throw new Error('listvaultfiles not bound');
  return callBridgeJSON(b.listvaultfiles(projectRoot), 'listvaultfiles');
}

export async function bridgeReadVaultFile(projectRoot: string, relativePath: string): Promise<{ relative_path: string; content: string; frontmatter: Record<string, unknown> }> {
  const b = getBridge();
  if (!b?.readvaultfile) throw new Error('readvaultfile not bound');
  return callBridgeJSON(b.readvaultfile(projectRoot, relativePath), 'readvaultfile');
}

export async function bridgeWriteVaultNotes(projectRoot: string, relativePath: string, content: string): Promise<{ ok: true }> {
  const b = getBridge();
  if (!b?.writevaultnotes) throw new Error('writevaultnotes not bound');
  return callBridgeJSON(b.writevaultnotes(projectRoot, relativePath, content), 'writevaultnotes');
}

export async function bridgeWriteVaultFile(projectRoot: string, relativePath: string, content: string): Promise<{ ok: true }> {
  const b = getBridge();
  if (!b?.writevaultfile) throw new Error('writevaultfile not bound (rebuild C++ plugin)');
  return callBridgeJSON(b.writevaultfile(projectRoot, relativePath, content), 'writevaultfile');
}

export interface BridgeFunctionFlowPin {
  pinId: string;
  pinName: string;
  direction: 'input' | 'output';
  type: string;
  isExec: boolean;
}

export interface BridgeFunctionFlowNode {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  target?: string;
  pins: BridgeFunctionFlowPin[];
}

export interface BridgeFunctionFlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  isExec: boolean;
}

export interface BridgeFunctionFlow {
  ok: true;
  function: string;
  graph_name: string;
  nodes: BridgeFunctionFlowNode[];
  edges: BridgeFunctionFlowEdge[];
}

export async function bridgeReadFunctionFlow(assetPath: string, functionName: string): Promise<BridgeFunctionFlow> {
  const b = getBridge();
  if (!b?.readblueprintfunctionflow) throw new Error('readblueprintfunctionflow not bound (rebuild C++ plugin)');
  return callBridgeJSON(b.readblueprintfunctionflow(assetPath, functionName), 'readblueprintfunctionflow');
}

export function isFunctionFlowAvailable(): boolean {
  const b = getBridge();
  return typeof b?.readblueprintfunctionflow === 'function';
}

export function isVaultFileWriteAvailable(): boolean {
  const b = getBridge();
  return typeof b?.writevaultfile === 'function';
}

// True only when the C++ plugin exposes DeleteVaultFile (added in the rename
// + delete pass).  Older binaries return false → vaultApi falls back to the
// HTTP backend for delete operations.
export function isVaultDeleteAvailable(): boolean {
  const b = getBridge();
  return typeof b?.deletevaultfile === 'function';
}

export async function bridgeDeleteVaultFile(
  projectRoot: string,
  relativePath: string,
): Promise<{ ok: true; deleted_relative_path: string }> {
  const b = getBridge();
  if (!b?.deletevaultfile) {
    throw new Error('deletevaultfile not bound (rebuild C++ plugin)');
  }
  return callBridgeJSON(b.deletevaultfile(projectRoot, relativePath), 'deletevaultfile');
}

// ---- Project-wide scan orchestration -------------------------------------
// One asset returned by ListBlueprintAssets.  parent_class is best-effort —
// if the AssetRegistry tag is missing the C++ side returns an empty string.
export interface BridgeAssetEntry {
  asset_path: string;
  name: string;
  parent_class: string;
}

// Function entry surfaced by RequestDeepScan — covers user functions, events,
// custom events, and dispatchers. `kind` distinguishes them so the UI can
// pick icons / behaviour per category.
export interface BridgeFunctionEntry {
  name: string;
  kind: 'function' | 'event' | 'custom_event' | 'dispatcher' | string;
}

// Component entry from the SCS hierarchy. `parent` is empty for root.
export interface BridgeComponentEntry {
  name: string;
  class: string;
  parent: string;
}

// One outbound edge from a Blueprint to another Blueprint asset. Engine-class
// targets (Actor, ActorComponent, etc.) are filtered out on the C++ side.
export interface BridgeBlueprintEdge {
  target_asset: string;
  target_function?: string;
  kind: 'call' | 'cast' | 'spawn' | 'delegate' | string;
  from_function: string;
}

// Result of a single RequestDeepScan call.  ast_hash is a CRC32 fingerprint
// the orchestrator can compare against the scan-manifest to skip unchanged
// assets before submitting the batch to the backend.  functions / components /
// edges drive the framework-scan force graph and skeleton .md writer — they
// are populated by the C++ extractor and require no LLM.
export interface BridgeDeepScanResult {
  asset_path: string;
  ast_hash: string;
  node_type: string;       // "Blueprint" | "Interface" | "Component"
  name: string;
  parent_class: string;
  functions?: BridgeFunctionEntry[];
  components?: BridgeComponentEntry[];
  edges?: BridgeBlueprintEdge[];
}

export async function bridgeListBlueprintAssets(projectRoot: string): Promise<BridgeAssetEntry[]> {
  const b = getBridge();
  if (!b?.listblueprintassets) throw new Error('listblueprintassets not bound (rebuild C++ plugin)');
  const result = await callBridgeJSON<{ ok: true; assets: BridgeAssetEntry[] }>(
    b.listblueprintassets(projectRoot),
    'listblueprintassets',
  );
  return result.assets ?? [];
}

export async function bridgeRequestDeepScan(assetPath: string): Promise<BridgeDeepScanResult> {
  const b = getBridge();
  if (!b?.requestdeepscan) throw new Error('requestdeepscan not bound (rebuild C++ plugin)');
  return callBridgeJSON<BridgeDeepScanResult>(b.requestdeepscan(assetPath), 'requestdeepscan');
}

export function isDeepScanAvailable(): boolean {
  const b = getBridge();
  return typeof b?.requestdeepscan === 'function' && typeof b?.listblueprintassets === 'function';
}

// ---- "Jump to UE editor" bridge --------------------------------------------
// Opens the Blueprint editor for `assetPath`.  When `functionName` is given,
// also opens that specific function graph in a tab (matches the L2/L3 view
// the user clicked from).  Requires a C++ rebuild — older plugin binaries
// won't have `openineditor` bound and this throws a helpful error.

export interface BridgeOpenInEditorResult {
  ok: true;
  asset_path: string;
  function?: string;
  focused_function?: boolean;
}

export async function bridgeOpenInEditor(
  assetPath: string,
  functionName: string = '',
): Promise<BridgeOpenInEditorResult> {
  const b = getBridge();
  if (!b?.openineditor) throw new Error('openineditor not bound (rebuild C++ plugin)');
  return callBridgeJSON<BridgeOpenInEditorResult>(
    b.openineditor(assetPath, functionName),
    'openineditor',
  );
}

export function isOpenInEditorAvailable(): boolean {
  const b = getBridge();
  return typeof b?.openineditor === 'function';
}

// ---- A1: AssetRegistry stale-asset listener (HANDOFF §19.3) ---------------
// The bridge tails AssetRegistry events (Renamed / Removed in the MVP) into
// a 1024-entry ring buffer.  The frontend polls every 30s with the highest
// counter it has seen and applies the new events to its in-memory stale set.
// If `since` falls below the buffer's oldest counter (events were dropped),
// the frontend should treat that as 'rescan everything' — the latest_counter
// returned still moves forward, so the next poll resyncs.

export interface BridgeStaleEvent {
  counter: number;
  type: 'renamed' | 'removed' | 'added' | 'updated';
  path: string;             // current object path (post-rename for 'renamed')
  old_path?: string;        // populated only for 'renamed'
  timestamp_sec: number;    // FPlatformTime::Seconds at push
}

export interface BridgeStaleEventsResult {
  ok: true;
  latest_counter: number;
  events: BridgeStaleEvent[];
}

export async function bridgeGetStaleEventsSince(sinceCounter: number = 0): Promise<BridgeStaleEventsResult> {
  const b = getBridge();
  if (!b?.getstaleeventssince) throw new Error('getstaleeventssince not bound (rebuild C++ plugin)');
  return callBridgeJSON<BridgeStaleEventsResult>(
    b.getstaleeventssince(sinceCounter),
    'getstaleeventssince',
  );
}

export function isStaleListenerAvailable(): boolean {
  const b = getBridge();
  return typeof b?.getstaleeventssince === 'function';
}

// ---- A2: Reflection-derived asset summary (HANDOFF §19.3) -----------------
// Replaces what the LLM used to fragilely extract from k2node dumps.  The
// bridge walks UClass + AssetRegistry so structural fields land 100% precise.
// MVP returns BP-only; DataAsset / WBP / Niagara extensions follow in Phase B.

export interface BridgeFunctionExport {
  name: string;
  flags: string[];           // BlueprintCallable / BlueprintEvent / BlueprintPure / Net / Static / ...
}

export interface BridgePropertyEntry {
  name: string;
  type: string;              // CPP type token, e.g. "int32", "TArray<UStaticMeshComponent*>"
  flags: string[];           // EditAnywhere / BlueprintReadOnly / BlueprintReadWrite / Replicated / ...
}

export interface BridgeAssetSummaryEdges {
  hard_refs: string[];       // package names under /Game/
  soft_refs: string[];
  interfaces: string[];      // implemented UClass pathnames
}

export interface BridgeAssetSummary {
  ok: true;
  asset_path: string;
  class_path: string;
  parent_class: string;
  ast_hash: string;
  scanned_at: string;        // ISO-8601 UTC
  exports: BridgeFunctionExport[];
  properties: BridgePropertyEntry[];
  components: BridgeComponentEntry[];
  edges: BridgeAssetSummaryEdges;
}

export async function bridgeGetReflectionAssetSummary(assetPath: string): Promise<BridgeAssetSummary> {
  const b = getBridge();
  if (!b?.getreflectionassetsummary) throw new Error('getreflectionassetsummary not bound (rebuild C++ plugin)');
  return callBridgeJSON<BridgeAssetSummary>(
    b.getreflectionassetsummary(assetPath),
    'getreflectionassetsummary',
  );
}

export function isReflectionSummaryAvailable(): boolean {
  const b = getBridge();
  return typeof b?.getreflectionassetsummary === 'function';
}
