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
  requestdeepscan?: (nodeId: string, assetPath: string) => void;

  listvaultfiles?: (projectRoot: string) => Promise<string> | string;
  readvaultfile?: (projectRoot: string, relativePath: string) => Promise<string> | string;
  writevaultnotes?: (projectRoot: string, relativePath: string, content: string) => Promise<string> | string;
  writevaultfile?: (projectRoot: string, relativePath: string, content: string) => Promise<string> | string;

  readblueprintfunctionflow?: (assetPath: string, functionName: string) => Promise<string> | string;
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
