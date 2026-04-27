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
