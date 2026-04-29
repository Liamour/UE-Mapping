import { parseFrontmatter, stripFrontmatter, extractNotes, normalizeFrontmatter, type VaultFrontmatter } from '../utils/frontmatter';
import { isBridgeAvailable, bridgeListVault, bridgeReadVaultFile, bridgeWriteVaultNotes } from './bridgeApi';

const API_BASE = 'http://localhost:8000';

export interface VaultListEntry {
  relative_path: string;
  title: string;
  subdir: string;
  size: number;
}

export interface VaultManifestEntry {
  ast_hash?: string;
  scan_at?: string;
  asset_path?: string;
  scan_model?: string;
}

export interface VaultListResponse {
  project_root: string;
  exists: boolean;
  files: VaultListEntry[];
  manifest?: { entries?: Record<string, VaultManifestEntry>; updated_at?: string };
}

export interface VaultFile {
  relative_path: string;
  raw: string;             // full file content
  body: string;            // content below frontmatter
  aiSection: string;       // body above NOTES heading
  notes: string;           // user notes section
  frontmatter: VaultFrontmatter;
}

export async function listVault(projectRoot: string): Promise<VaultListResponse> {
  if (isBridgeAvailable()) {
    return (await bridgeListVault(projectRoot)) as VaultListResponse;
  }
  const url = `${API_BASE}/api/v1/vault/list?project_root=${encodeURIComponent(projectRoot)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`vault/list HTTP ${r.status}`);
  return (await r.json()) as VaultListResponse;
}

export async function readVaultFile(projectRoot: string, relativePath: string): Promise<VaultFile> {
  let data: { content: string; frontmatter?: Record<string, unknown> };
  if (isBridgeAvailable()) {
    data = await bridgeReadVaultFile(projectRoot, relativePath);
  } else {
    const url = `${API_BASE}/api/v1/vault/read?project_root=${encodeURIComponent(projectRoot)}&relative_path=${encodeURIComponent(relativePath)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`vault/read HTTP ${r.status}`);
    data = await r.json();
  }
  const raw: string = data.content;
  const body = stripFrontmatter(raw);
  const { aiSection, notes } = extractNotes(body);
  // Backend may return parsed frontmatter; fall back to local parser if absent.
  // Normalize either way — backend emits the canonical nested schema, but
  // every frontend consumer expects the flattened shape.
  const fmRaw: VaultFrontmatter = (data.frontmatter && Object.keys(data.frontmatter).length > 0)
    ? (data.frontmatter as VaultFrontmatter)
    : parseFrontmatter(raw);
  const fm = normalizeFrontmatter(fmRaw);
  return { relative_path: relativePath, raw, body, aiSection, notes, frontmatter: fm };
}

export async function writeVaultNotes(projectRoot: string, relativePath: string, content: string): Promise<{ ok: true }> {
  if (isBridgeAvailable()) {
    return bridgeWriteVaultNotes(projectRoot, relativePath, content);
  }
  const url = `${API_BASE}/api/v1/vault/notes`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_root: projectRoot, relative_path: relativePath, content }),
  });
  if (!r.ok) throw new Error(`vault/notes HTTP ${r.status}`);
  return { ok: true };
}

export async function rebuildBacklinks(projectRoot: string, language?: 'en' | 'zh'): Promise<unknown> {
  const params = new URLSearchParams({ project_root: projectRoot });
  if (language) params.set('language', language);
  const url = `${API_BASE}/api/v1/vault/rebuild-backlinks?${params.toString()}`;
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`rebuild-backlinks HTTP ${r.status}`);
  return r.json();
}

export async function checkBackendHealth(): Promise<{ status: string; redis_available: boolean; version: string } | null> {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Vault export — bundle every node into one JSON document so users can
// hand the project graph to any external LLM (ChatGPT web / Claude.ai)
// without paying for API tokens.  Works in both bridge and HTTP modes:
// when bridge is available we walk listVault + readVaultFile locally,
// otherwise we hit the backend's /api/v1/vault/export endpoint.
// ─────────────────────────────────────────────────────────────────────────

export type VaultExportScope = 'all' | 'l1' | 'l2';

export interface VaultExportEntry {
  relative_path: string;
  frontmatter: VaultFrontmatter;
  body: string;
  size: number;
}

export interface VaultExport {
  project_root: string;
  scope: VaultExportScope;
  generated_at: string;
  manifest?: unknown;
  systems: VaultExportEntry[];
  blueprints: VaultExportEntry[];
  counts: { systems: number; blueprints: number };
}

export async function exportVault(
  projectRoot: string,
  scope: VaultExportScope = 'all',
  onProgress?: (done: number, total: number) => void,
): Promise<VaultExport> {
  // Bridge mode: aggregate locally to avoid requiring the Python backend.
  // HTTP mode: prefer the backend endpoint (single round-trip, faster on
  // large vaults) but fall back to local aggregation if the endpoint is
  // missing (older backend version) or unreachable.
  if (isBridgeAvailable()) {
    return await aggregateExportLocally(projectRoot, scope, onProgress);
  }
  try {
    const url = `${API_BASE}/api/v1/vault/export?project_root=${encodeURIComponent(projectRoot)}&scope=${scope}`;
    const r = await fetch(url);
    if (r.ok) return (await r.json()) as VaultExport;
    // Backend is up but endpoint missing/erroring — fall through to local.
  } catch {
    /* fall through */
  }
  return await aggregateExportLocally(projectRoot, scope, onProgress);
}

async function aggregateExportLocally(
  projectRoot: string,
  scope: VaultExportScope,
  onProgress?: (done: number, total: number) => void,
): Promise<VaultExport> {
  const list = await listVault(projectRoot);
  const candidates = list.files.filter((f) => {
    const top = f.relative_path.split('/')[0] ?? '';
    if (top === '_meta' || top === '_systems') return false;
    if (scope === 'l1') return top === 'Systems';
    if (scope === 'l2') return top !== 'Systems';
    return true;
  });

  const systems: VaultExportEntry[] = [];
  const blueprints: VaultExportEntry[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    onProgress?.(i, candidates.length);
    try {
      const file = await readVaultFile(projectRoot, f.relative_path);
      const entry: VaultExportEntry = {
        relative_path: f.relative_path,
        frontmatter: file.frontmatter,
        body: file.body,
        size: f.size,
      };
      const top = f.relative_path.split('/')[0] ?? '';
      if (top === 'Systems') systems.push(entry);
      else blueprints.push(entry);
    } catch (e) {
      // Skip individual file failures — partial exports are still useful.
      // eslint-disable-next-line no-console
      console.warn('[exportVault] skip', f.relative_path, e);
    }
  }
  onProgress?.(candidates.length, candidates.length);

  return {
    project_root: projectRoot,
    scope,
    generated_at: new Date().toISOString(),
    manifest: list.manifest,
    systems,
    blueprints,
    counts: { systems: systems.length, blueprints: blueprints.length },
  };
}

// Browser download helper — wraps a Blob in an invisible <a download> click
// so the user gets the OS save-as dialog (CEF inside UE supports this).
export function downloadJSON(filename: string, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download can start before we drop the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
