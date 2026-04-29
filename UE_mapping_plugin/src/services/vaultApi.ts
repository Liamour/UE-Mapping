import { parseFrontmatter, stripFrontmatter, extractNotes, normalizeFrontmatter, type VaultFrontmatter } from '../utils/frontmatter';
import {
  isBridgeAvailable,
  bridgeListVault,
  bridgeReadVaultFile,
  bridgeWriteVaultNotes,
  bridgeWriteVaultFile,
  bridgeDeleteVaultFile,
  isVaultDeleteAvailable,
} from './bridgeApi';

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

// ---- Apply UE asset rename to vault ----------------------------------------
// When the AssetRegistry stale listener observes a rename, the TopBar
// dropdown offers an "Apply rename" button that calls this — moves the
// vault .md to a new filename and updates `title` + `asset_path` in
// frontmatter, preserving body and NOTES.

export interface ApplyRenameResult {
  new_relative_path: string;
  previous_asset_path: string;
}

export async function applyVaultRename(
  projectRoot: string,
  oldRelativePath: string,
  newName: string,
  newAssetPath: string,
): Promise<ApplyRenameResult> {
  // Bridge-mode rename: read the old file, rewrite frontmatter (title +
  // asset_path), write to the new path, then delete the old file via the
  // bridge.  Falls back to the HTTP backend if the bridge isn't available
  // OR if the bridge lacks DeleteVaultFile (older plugin binary) — the HTTP
  // path still works once the user starts the Python backend.
  if (isBridgeAvailable() && isVaultDeleteAvailable()) {
    return await bridgeRenameVaultFile(projectRoot, oldRelativePath, newName, newAssetPath);
  }
  const url = `${API_BASE}/api/v1/vault/apply-rename`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_root: projectRoot,
        old_relative_path: oldRelativePath,
        new_name: newName,
        new_asset_path: newAssetPath,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`apply-rename: backend unreachable (${msg}). Start the Python backend or rebuild the C++ plugin so the bridge can do this offline.`);
  }
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* ignore */ }
    if (r.status === 404 && detail === 'Not Found') {
      throw new Error('apply-rename: backend route missing — restart Python backend with the latest main.py');
    }
    throw new Error(`apply-rename ${detail}`);
  }
  return (await r.json()) as ApplyRenameResult;
}

// Bridge-side rename: pure JS, runs entirely in the editor.  No backend
// required.  We read the file, rewrite the title/asset_path/previous_asset_path
// fields in its frontmatter (preserving everything else verbatim including
// NOTES), write it under the new filename, then delete the old file.
async function bridgeRenameVaultFile(
  projectRoot: string,
  oldRelativePath: string,
  newName: string,
  newAssetPath: string,
): Promise<ApplyRenameResult> {
  const file = await bridgeReadVaultFile(projectRoot, oldRelativePath);
  const oldRaw = file.content;
  if (!oldRaw.startsWith('---\n')) {
    throw new Error(`apply-rename: ${oldRelativePath} missing YAML frontmatter`);
  }
  const fmEnd = oldRaw.indexOf('\n---\n', 4);
  if (fmEnd === -1) throw new Error(`apply-rename: ${oldRelativePath} frontmatter not closed`);
  const fmText = oldRaw.slice(4, fmEnd);
  const body = oldRaw.slice(fmEnd + 5);

  // Hand-rolled minimal YAML rewrite — replace `title:` and `asset_path:`
  // values, preserving every other line.  Adds previous_asset_path if the
  // path actually changed.  Avoids pulling in a YAML serializer library.
  const lines = fmText.split('\n');
  let titleSet = false;
  let assetSet = false;
  let previousAssetPath = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^title\s*:/.test(line)) {
      lines[i] = `title: ${yamlScalar(newName)}`;
      titleSet = true;
    } else if (/^asset_path\s*:/.test(line)) {
      const match = line.match(/^asset_path\s*:\s*(.*)$/);
      if (match) {
        const existing = match[1].trim();
        previousAssetPath = unquote(existing);
      }
      lines[i] = `asset_path: ${yamlScalar(newAssetPath)}`;
      assetSet = true;
    }
  }
  if (!titleSet) lines.unshift(`title: ${yamlScalar(newName)}`);
  if (!assetSet) lines.unshift(`asset_path: ${yamlScalar(newAssetPath)}`);
  if (previousAssetPath && previousAssetPath !== newAssetPath) {
    // Replace existing previous_asset_path or append a new one.
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^previous_asset_path\s*:/.test(lines[i])) {
        lines[i] = `previous_asset_path: ${yamlScalar(previousAssetPath)}`;
        updated = true;
        break;
      }
    }
    if (!updated) lines.push(`previous_asset_path: ${yamlScalar(previousAssetPath)}`);
  }
  const newContent = `---\n${lines.join('\n')}\n---\n${body}`;

  const slashIdx = oldRelativePath.lastIndexOf('/');
  const dir = slashIdx >= 0 ? oldRelativePath.slice(0, slashIdx + 1) : '';
  const newRelativePath = `${dir}${sanitiseFilename(newName)}.md`;

  // Write under the new path first so a half-failure (write OK, delete fail)
  // leaves the user with the new file rather than nothing at all.
  await bridgeWriteVaultFile(projectRoot, newRelativePath, newContent);
  if (newRelativePath !== oldRelativePath) {
    await bridgeDeleteVaultFile(projectRoot, oldRelativePath);
  }
  return {
    new_relative_path: newRelativePath,
    previous_asset_path: previousAssetPath,
  };
}

function yamlScalar(s: string): string {
  if (s === '') return '""';
  if (
    /[:#\[\]{}&*!|>'"%@`,?]/.test(s) ||
    s.startsWith('-') ||
    s.startsWith(' ') ||
    s.endsWith(' ')
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const q = trimmed[0];
    if (trimmed.endsWith(q)) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return trimmed;
}

function sanitiseFilename(name: string): string {
  // Mirror backend/vault_writer.py:_sanitise_filename — replace anything that
  // isn't a word char / hyphen / dot with underscore, strip leading/trailing
  // dots and underscores, and fall back to "untitled" if the result is empty.
  const cleaned = name.replace(/[^\w\-.]+/g, '_').replace(/^[._]+/, '').replace(/[._]+$/, '');
  return cleaned || 'untitled';
}

// ---- Delete a single vault note --------------------------------------------
// Used by the TopBar stale-asset dropdown Apply button on a `removed` event:
// the asset is gone from the editor, the user has confirmed, the .md goes too.
export interface DeleteVaultResult {
  ok: true;
  deleted_relative_path: string;
}

export async function deleteVaultFile(
  projectRoot: string,
  relativePath: string,
): Promise<DeleteVaultResult> {
  if (isVaultDeleteAvailable()) {
    return await bridgeDeleteVaultFile(projectRoot, relativePath);
  }
  const url = `${API_BASE}/api/v1/vault/delete-file`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_root: projectRoot, relative_path: relativePath }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`delete-file: backend unreachable (${msg}). Start the Python backend or rebuild the C++ plugin so the bridge can do this offline.`);
  }
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* ignore */ }
    if (r.status === 404 && detail === 'Not Found') {
      throw new Error('delete-file: backend route missing — restart Python backend with the latest main.py');
    }
    throw new Error(`delete-file ${detail}`);
  }
  return (await r.json()) as DeleteVaultResult;
}

// ---- find-by-asset ---------------------------------------------------------
// Look up an existing vault note by asset_path (regardless of which subdir
// it currently lives in).  framework-scan calls this before writing a fresh
// skeleton so it preserves a user's manual reorganisation.
export async function findVaultNoteByAsset(
  projectRoot: string,
  assetPath: string,
): Promise<string | null> {
  // No bridge equivalent — bridge mode falls back to listing + reading every
  // note locally (handled in frameworkScan.ts).  This HTTP path is the fast
  // path when the backend is reachable.
  const url = `${API_BASE}/api/v1/vault/find-by-asset?project_root=${encodeURIComponent(projectRoot)}&asset_path=${encodeURIComponent(assetPath)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.relative_path as string | null) ?? null;
  } catch {
    return null;
  }
}
