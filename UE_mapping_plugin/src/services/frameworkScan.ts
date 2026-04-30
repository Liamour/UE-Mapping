// Phase 1 framework scan — pure AST, no LLM, no Python backend.
//
// Flow:
//   1. ListBlueprintAssets  via C++ bridge       → N assets in /Game/
//   2. RequestDeepScan each (concurrency 8)      → ast_hash + functions + components + edges
//   3. For each result, render skeleton .md      → write via bridgeWriteVaultFile
//   4. Caller can then call loadIndex() to surface the new files in the tree/graph
//
// Skeleton frontmatter mirrors the LLM-output schema (title / node_type /
// parent_class / ast_hash / exports_* / edges) so the existing Lv1SystemGraph
// and LeftPane consume it without modification. We add `analysis_state:
// skeleton` so the UI can later distinguish "AST-only" from "LLM-analyzed"
// notes and offer a per-node "Deep reasoning" button.
//
// System clustering is derived from the asset's first folder under /Game/
// (e.g. /Game/Combat/BP_Weapon → tag `system/combat`). Once an LLM scan
// rewrites the tags, that hand-derived bucket is replaced.
//
// User-authored content under `## [ NOTES ]` is preserved across re-scans —
// we read the existing file (if any), extract the notes block, and re-emit
// it verbatim below the AI section.

import {
  bridgeListBlueprintAssets,
  bridgeRequestDeepScan,
  bridgeWriteVaultFile,
  bridgeReadVaultFile,
  bridgeGetReflectionAssetSummary,
  isReflectionSummaryAvailable,
  type BridgeAssetEntry,
  type BridgeAssetSummary,
  type BridgeDeepScanResult,
} from './bridgeApi';
import { listVault, readVaultFile } from './vaultApi';
import { extractNotes, stripFrontmatter } from '../utils/frontmatter';

const FRAMEWORK_SCAN_CONCURRENCY = 8;

export interface FrameworkScanFailure {
  asset_path: string;
  reason: string;
}

export interface FrameworkScanResult {
  total: number;          // assets seen from ListBlueprintAssets
  fingerprinted: number;  // RequestDeepScan calls that succeeded
  written: number;        // skeleton files actually written
  failures: FrameworkScanFailure[];
  // Aggregated graph data — caller may stash this in a store for the L1 view.
  blueprints: BridgeDeepScanResult[];
}

export interface FrameworkScanProgress {
  phase: 'listing' | 'fingerprinting' | 'writing' | 'done';
  done: number;
  total: number;
}

export async function runFrameworkScan(
  projectRoot: string,
  opts: {
    onProgress?: (p: FrameworkScanProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<FrameworkScanResult> {
  const failures: FrameworkScanFailure[] = [];
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;

  onProgress({ phase: 'listing', done: 0, total: 0 });
  const assets = await bridgeListBlueprintAssets(projectRoot);
  if (assets.length === 0) {
    onProgress({ phase: 'done', done: 0, total: 0 });
    return { total: 0, fingerprinted: 0, written: 0, failures, blueprints: [] };
  }

  onProgress({ phase: 'fingerprinting', done: 0, total: assets.length });
  const fingerprints = await fingerprintAll(
    assets,
    failures,
    (done) => onProgress({ phase: 'fingerprinting', done, total: assets.length }),
    signal,
  );

  // A2: pull reflection summaries (UFUNCTION flags + UPROPERTY metadata +
  // class deps) so the skeleton .md frontmatter mirrors what the LLM scan
  // sees.  Best-effort — older C++ builds skip this entirely; per-asset
  // failures degrade gracefully (missing fields, no scan abort).
  const reflectionByAsset = await collectReflectionSummaries(fingerprints, signal);

  // Build an asset_path → existing-vault-relative-path map.  Lets us preserve
  // the user's manual organisation: if a .md was hand-moved into a custom
  // folder, this scan rewrites it in place instead of dropping a fresh copy
  // at the deterministic Blueprints/<Name>.md path and orphaning the move.
  // Same idea for system markdowns under Systems/<id>.md — if the user has
  // renamed/moved them, we look them up by `system_id` frontmatter.
  const existingByAsset = await buildExistingVaultIndex(projectRoot);

  // Step 1: per-blueprint skeleton .md files. Each member writes its own file
  // and uses the full fingerprint set as the title→name index for edge mapping.
  const totalToWrite = fingerprints.length + countSystems(fingerprints);
  onProgress({ phase: 'writing', done: 0, total: totalToWrite });
  let written = 0;
  for (let i = 0; i < fingerprints.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const entry = fingerprints[i];
    try {
      const existingPath = existingByAsset.byAsset.get(entry.asset_path);
      const relPath = existingPath ?? vaultPathFor(entry);
      const existingNotes = await loadExistingNotes(projectRoot, relPath);
      const md = renderSkeletonMd(
        entry, fingerprints, existingNotes,
        reflectionByAsset.get(entry.asset_path) ?? null,
      );
      await bridgeWriteVaultFile(projectRoot, relPath, md);
      written++;
    } catch (e) {
      failures.push({ asset_path: entry.asset_path, reason: formatError(e) });
    }
    onProgress({ phase: 'writing', done: i + 1, total: totalToWrite });
  }

  // Step 2: per-system aggregate .md files. Group members by their derived
  // system tag (`/Game/<system>/` first folder), then by deeper subfolder for
  // the SUBSYSTEMS section.  Members with no /Game/<x>/ prefix go to
  // `_unassigned`.  The system .md preserves a NOTES section the same way
  // per-blueprint .md does.
  const grouped = groupBySystemForScan(fingerprints);
  let groupedDone = 0;
  for (const [systemId, members] of grouped) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const existingPath = existingByAsset.bySystem.get(systemId);
      const relPath = existingPath ?? systemVaultPathFor(systemId);
      const existingNotes = await loadExistingNotes(projectRoot, relPath);
      const md = renderSystemSkeletonMd(systemId, members, existingNotes);
      await bridgeWriteVaultFile(projectRoot, relPath, md);
      written++;
    } catch (e) {
      failures.push({ asset_path: `system:${systemId}`, reason: formatError(e) });
    }
    groupedDone++;
    onProgress({ phase: 'writing', done: fingerprints.length + groupedDone, total: totalToWrite });
  }

  onProgress({ phase: 'done', done: written, total: totalToWrite });
  return {
    total: assets.length,
    fingerprinted: fingerprints.length,
    written,
    failures,
    blueprints: fingerprints,
  };
}

// ---- Single-asset rescan ---------------------------------------------------
// Used by the stale-sync engine to handle `added` / `updated` events: deep-
// scan one asset, render its skeleton .md, and write it under its existing
// path (or the deterministic default if it's brand-new).  NOTES are
// preserved — same as the bulk path.  Returns the relative_path written.

export async function syncSingleAsset(
  projectRoot: string,
  assetPath: string,
): Promise<{ relativePath: string; entry: BridgeDeepScanResult }> {
  const entry = await bridgeRequestDeepScan(assetPath);

  // Best-effort reflection enrichment so the rescanned skeleton .md keeps
  // properties / function_flags / class_dependencies aligned with what a
  // full framework scan would produce.  Older plugin builds → null; bridge
  // throws → null.  Non-fatal in either case.
  let reflection: BridgeAssetSummary | null = null;
  if (isReflectionSummaryAvailable()) {
    try {
      reflection = await bridgeGetReflectionAssetSummary(assetPath);
    } catch {
      reflection = null;
    }
  }

  // Look up an existing vault note for this asset.  Falls back to the
  // deterministic Blueprints/<Name>.md when nothing exists (added case).
  const index = await buildExistingVaultIndex(projectRoot);
  const existingPath = index.byAsset.get(entry.asset_path);
  const relPath = existingPath ?? vaultPathFor(entry);

  const existingNotes = await loadExistingNotes(projectRoot, relPath);
  // For single-asset path we can't dereference cross-asset edges through
  // the full fingerprint set — pass an empty array so renderSkeletonMd
  // simply skips edge target name resolution.  The next full framework
  // scan will refill those links.
  const md = renderSkeletonMd(entry, [entry], existingNotes, reflection);
  await bridgeWriteVaultFile(projectRoot, relPath, md);
  return { relativePath: relPath, entry };
}

// ---- Implementation -------------------------------------------------------

async function fingerprintAll(
  assets: BridgeAssetEntry[],
  failures: FrameworkScanFailure[],
  onProgress: (done: number) => void,
  signal: AbortSignal | undefined,
): Promise<BridgeDeepScanResult[]> {
  const results: BridgeDeepScanResult[] = [];
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < assets.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

  const pool = Math.min(FRAMEWORK_SCAN_CONCURRENCY, assets.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

// A2 reflection enrichment.  Returns a Map keyed by asset_path; absent
// entries mean either the bridge endpoint isn't bound (older plugin) or
// the per-asset call threw (corrupt asset, non-UClass, etc).  Failures
// are intentionally swallowed here — the skeleton render falls back to
// the legacy frontmatter shape and the caller's UI surfaces nothing
// surprising.  Concurrency matches FRAMEWORK_SCAN_CONCURRENCY so we don't
// hammer the bridge harder than the deepscan pass already does.
async function collectReflectionSummaries(
  fingerprints: BridgeDeepScanResult[],
  signal: AbortSignal | undefined,
): Promise<Map<string, BridgeAssetSummary>> {
  const out = new Map<string, BridgeAssetSummary>();
  if (!isReflectionSummaryAvailable() || fingerprints.length === 0) return out;

  let cursor = 0;
  async function worker() {
    while (cursor < fingerprints.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const idx = cursor++;
      const r = fingerprints[idx];
      try {
        const summary = await bridgeGetReflectionAssetSummary(r.asset_path);
        out.set(r.asset_path, summary);
      } catch {
        // Non-fatal — skeleton render will skip the reflection blocks
        // for this asset.
      }
    }
  }

  const pool = Math.min(FRAMEWORK_SCAN_CONCURRENCY, fingerprints.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}

async function loadExistingNotes(projectRoot: string, relPath: string): Promise<string> {
  try {
    const file = await bridgeReadVaultFile(projectRoot, relPath);
    const body = stripFrontmatter(file.content);
    const { notes } = extractNotes(body);
    return notes;
  } catch {
    // file doesn't exist yet — first scan, return empty notes
    return '';
  }
}

function vaultPathFor(entry: BridgeDeepScanResult): string {
  const subdir = subdirForType(entry.node_type);
  // Use the asset name (already unique per /Game/ path) as the file stem.
  return `${subdir}/${entry.name}.md`;
}

function subdirForType(nodeType: string): string {
  // Mirror backend/vault_writer.py NODE_TYPE_TO_SUBDIR.  When the C++ bridge
  // surfaces new flavours (WidgetBlueprint / AnimBlueprint / Libraries) keep
  // both sides in sync — the LLM batch scan path uses the backend mapping
  // for is_unchanged() lookup, framework-scan uses this one.
  if (nodeType === 'Interface') return 'Interfaces';
  if (nodeType === 'Component') return 'Components';
  if (nodeType === 'WidgetBlueprint') return 'Widgets';
  if (nodeType === 'AnimBlueprint') return 'Anims';
  if (nodeType === 'FunctionLibrary' || nodeType === 'MacroLibrary') return 'Libraries';
  // Phase B (§22.5 #4) — DataTable / native UDataAsset subclasses share one
  // Data/ subdir.  Splitting them by type adds folder churn for marginal
  // value at this scale (typical project = a handful of each).
  if (nodeType === 'DataAsset' || nodeType === 'DataTable') return 'Data';
  return 'Blueprints';
}

function renderSkeletonMd(
  entry: BridgeDeepScanResult,
  allEntries: BridgeDeepScanResult[],
  preservedNotes: string,
  reflection: BridgeAssetSummary | null = null,
): string {
  const assetPathToName: Record<string, string> = {};
  for (const e of allEntries) assetPathToName[e.asset_path] = e.name;

  const fns = entry.functions ?? [];
  const userFns = fns.filter((f) => f.kind === 'function').map((f) => f.name);
  const events = fns.filter((f) => f.kind === 'event' || f.kind === 'custom_event').map((f) => f.name);
  const dispatchers = fns.filter((f) => f.kind === 'dispatcher').map((f) => f.name);

  // A2 reflection blobs — only emitted when the bridge supplied them, so
  // pre-A2 vaults don't grow empty `properties: []` keys.
  const reflectionFunctionFlags: Record<string, string[]> = {};
  if (reflection) {
    for (const f of reflection.exports ?? []) {
      reflectionFunctionFlags[f.name] = f.flags ?? [];
    }
  }
  const reflectionProperties = reflection?.properties ?? [];
  const reflectionEdges = reflection?.edges;

  // Group outbound edges by mapped kind, deduping (target, refs) tuples.
  const edgesByKind: Record<string, Array<{ target: string; refs: string[] }>> = {};
  for (const e of entry.edges ?? []) {
    const targetName = assetPathToName[e.target_asset];
    if (!targetName) continue; // edge points outside the scanned set — skip silently
    const kind = mapEdgeKind(e.kind);
    if (!edgesByKind[kind]) edgesByKind[kind] = [];
    const refLabel = e.target_function
      ? `${e.from_function} → ${e.target_function}`
      : e.from_function;
    const existing = edgesByKind[kind].find((x) => x.target === targetName);
    if (existing) {
      if (!existing.refs.includes(refLabel)) existing.refs.push(refLabel);
    } else {
      edgesByKind[kind].push({ target: targetName, refs: [refLabel] });
    }
  }

  const systemTag = deriveSystemTag(entry.asset_path);
  const tags: string[] = [];
  if (systemTag) tags.push(`system/${systemTag}`);

  const lines: string[] = [];
  lines.push(`title: ${yamlScalar(entry.name)}`);
  lines.push(`asset_path: ${yamlScalar(entry.asset_path)}`);
  lines.push(`node_type: ${yamlScalar(entry.node_type)}`);
  if (entry.parent_class) lines.push(`parent_class: ${yamlScalar(entry.parent_class)}`);
  lines.push(`ast_hash: ${yamlScalar(entry.ast_hash)}`);
  lines.push(`scan_at: ${new Date().toISOString()}`);
  lines.push(`analysis_state: skeleton`);
  if (tags.length > 0) {
    lines.push(`tags:`);
    for (const t of tags) lines.push(`  - ${yamlScalar(t)}`);
  }
  if (userFns.length > 0) {
    lines.push(`exports_functions:`);
    for (const f of userFns) lines.push(`  - ${yamlScalar(f)}`);
  }
  if (events.length > 0) {
    lines.push(`exports_events:`);
    for (const f of events) lines.push(`  - ${yamlScalar(f)}`);
  }
  if (dispatchers.length > 0) {
    lines.push(`exports_dispatchers:`);
    for (const f of dispatchers) lines.push(`  - ${yamlScalar(f)}`);
  }
  if (entry.components && entry.components.length > 0) {
    lines.push(`components:`);
    for (const c of entry.components) {
      lines.push(`  - name: ${yamlScalar(c.name)}`);
      lines.push(`    class: ${yamlScalar(c.class)}`);
      if (c.parent) lines.push(`    parent: ${yamlScalar(c.parent)}`);
    }
  }
  // A2 reflection — properties live alongside components since they share
  // the "this is what the BP exposes" mental model.  `flags` is always
  // emitted even when empty so YAML readers see the property's full shape.
  if (reflectionProperties.length > 0) {
    lines.push(`properties:`);
    for (const p of reflectionProperties) {
      lines.push(`  - name: ${yamlScalar(p.name)}`);
      lines.push(`    type: ${yamlScalar(p.type)}`);
      if (p.flags && p.flags.length > 0) {
        lines.push(`    flags:`);
        for (const f of p.flags) lines.push(`      - ${yamlScalar(f)}`);
      }
    }
  }
  // function_flags is a name → flag-list map.  We render only when at least
  // one entry has flags — pre-A2 .md files end up identical to today.
  if (Object.values(reflectionFunctionFlags).some((flags) => flags.length > 0)) {
    lines.push(`function_flags:`);
    for (const [name, flags] of Object.entries(reflectionFunctionFlags)) {
      if (flags.length === 0) continue;
      lines.push(`  ${yamlScalar(name)}:`);
      for (const f of flags) lines.push(`    - ${yamlScalar(f)}`);
    }
  }
  // class_dependencies surfaces hard / soft / interface refs from the
  // AssetRegistry walk.  Useful for the LLM (interface-call resolution)
  // and for users browsing the .md directly.
  if (
    reflectionEdges &&
    ((reflectionEdges.hard_refs?.length ?? 0) > 0 ||
      (reflectionEdges.soft_refs?.length ?? 0) > 0 ||
      (reflectionEdges.interfaces?.length ?? 0) > 0)
  ) {
    lines.push(`class_dependencies:`);
    if ((reflectionEdges.hard_refs?.length ?? 0) > 0) {
      lines.push(`  hard_refs:`);
      for (const p of reflectionEdges.hard_refs) lines.push(`    - ${yamlScalar(p)}`);
    }
    if ((reflectionEdges.soft_refs?.length ?? 0) > 0) {
      lines.push(`  soft_refs:`);
      for (const p of reflectionEdges.soft_refs) lines.push(`    - ${yamlScalar(p)}`);
    }
    if ((reflectionEdges.interfaces?.length ?? 0) > 0) {
      lines.push(`  interfaces:`);
      for (const p of reflectionEdges.interfaces) lines.push(`    - ${yamlScalar(p)}`);
    }
  }
  if (Object.keys(edgesByKind).length > 0) {
    lines.push(`edges:`);
    for (const [kind, list] of Object.entries(edgesByKind)) {
      lines.push(`  ${kind}:`);
      for (const e of list) {
        lines.push(`    - target: ${yamlScalar(e.target)}`);
        if (e.refs.length > 0) {
          lines.push(`      refs:`);
          for (const r of e.refs) lines.push(`        - ${yamlScalar(r)}`);
        }
      }
    }
  }

  const aiSection =
    `*Skeleton entry — function/component/edge data extracted from AST. ` +
    `Run "Deep reasoning" on this node to add LLM-derived intent and tags.*\n`;

  const notesBlock = renderNotesBlock(preservedNotes);

  return `---\n${lines.join('\n')}\n---\n${aiSection}\n${notesBlock}`;
}

function renderNotesBlock(preservedNotes: string): string {
  const heading = `## [ NOTES ]`;
  const divider = `<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->`;
  const body = preservedNotes.trim().length > 0
    ? preservedNotes.trim() + '\n'
    : `*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*\n`;
  return `${heading}\n${divider}\n\n${body}`;
}

function deriveSystemTag(assetPath: string): string {
  // /Game/Combat/BP_X.BP_X → "combat" — first folder under /Game/.
  const m = assetPath.match(/^\/Game\/([^/]+)\//);
  if (!m) return '';
  return m[1].toLowerCase();
}

// /Game/Combat/AI/Foo.Foo → "ai".  Empty string when there's no nested folder
// (i.e. the asset sits directly under /Game/<system>/), used for the
// SUBSYSTEMS section grouping.
function deriveSubsystemTag(assetPath: string): string {
  const m = assetPath.match(/^\/Game\/[^/]+\/([^/]+)\//);
  if (!m) return '';
  return m[1].toLowerCase();
}

function countSystems(fingerprints: BridgeDeepScanResult[]): number {
  return groupBySystemForScan(fingerprints).size;
}

// Bucket fingerprints by deriveSystemTag.  Members whose asset path doesn't
// start with /Game/<x>/ go into `_unassigned` so we still write a system file
// for them (matches Lv0CardWall's `_unassigned` bucket).
function groupBySystemForScan(
  fingerprints: BridgeDeepScanResult[],
): Map<string, BridgeDeepScanResult[]> {
  const out = new Map<string, BridgeDeepScanResult[]>();
  for (const e of fingerprints) {
    const sys = deriveSystemTag(e.asset_path) || '_unassigned';
    const arr = out.get(sys) ?? [];
    arr.push(e);
    out.set(sys, arr);
  }
  return out;
}

function systemVaultPathFor(systemId: string): string {
  return `Systems/${systemId}.md`;
}

function renderSystemSkeletonMd(
  systemId: string,
  members: BridgeDeepScanResult[],
  preservedNotes: string,
): string {
  const displayName = systemId === '_unassigned'
    ? 'Unassigned'
    : systemId.charAt(0).toUpperCase() + systemId.slice(1);

  // SUBSYSTEMS: bucket members by their second /Game/<sys>/<sub>/ segment.
  // The empty-string bucket holds members directly under /Game/<sys>/ (no
  // nested folder).  Sort buckets alphabetically; the empty bucket comes last
  // under the label "(root)".
  const subsystems = new Map<string, BridgeDeepScanResult[]>();
  for (const m of members) {
    const sub = deriveSubsystemTag(m.asset_path);
    const arr = subsystems.get(sub) ?? [];
    arr.push(m);
    subsystems.set(sub, arr);
  }
  const subKeys = Array.from(subsystems.keys()).sort((a, b) => {
    if (a === '' && b !== '') return 1;
    if (b === '' && a !== '') return -1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  lines.push(`title: ${yamlScalar(displayName)}`);
  lines.push(`node_type: System`);
  lines.push(`system_id: ${yamlScalar(systemId)}`);
  lines.push(`member_count: ${members.length}`);
  lines.push(`scan_at: ${new Date().toISOString()}`);
  lines.push(`analysis_state: skeleton`);

  const body: string[] = [];
  body.push(`## [ INTRO ]`);
  body.push(`*（暂未运行 LLM 分析。运行 LLM 分析至少到 L2 层级即可获得本系统的详细介绍：游戏类型定位、本系统的职责、与其它系统的关系。）*`);
  body.push('');

  body.push(`## [ SUBSYSTEMS ]`);
  body.push(`*按 /Game/${systemId === '_unassigned' ? '...' : systemId}/<subfolder>/ 自动分组。LLM 分析后会按职责重新归类。*`);
  body.push('');
  for (const sub of subKeys) {
    const label = sub === '' ? '(root)' : `${systemId}/${sub}`;
    body.push(`### ${label}`);
    const list = (subsystems.get(sub) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const m of list) {
      const link = relPathFromSystemTo(m);
      body.push(`- [${m.name}](${link})`);
    }
    body.push('');
  }

  body.push(`## [ MEMBERS ]`);
  body.push(`*完整成员清单（${members.length} 个）。*`);
  body.push('');
  const sortedAll = members.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const m of sortedAll) {
    const link = relPathFromSystemTo(m);
    const typeBadge = m.node_type ? ` *(${m.node_type})*` : '';
    body.push(`- [${m.name}](${link})${typeBadge}`);
  }
  body.push('');

  const notesBlock = renderNotesBlock(preservedNotes);

  return `---\n${lines.join('\n')}\n---\n${body.join('\n')}\n${notesBlock}`;
}

// Members live under Blueprints/ Interfaces/ Components/; the system file
// lives under Systems/.  Build a relative link that climbs out of Systems/
// then into the member's subdir (e.g. ../Blueprints/BP_Foo.md).
function relPathFromSystemTo(entry: BridgeDeepScanResult): string {
  const subdir = subdirForType(entry.node_type);
  return `../${subdir}/${entry.name}.md`;
}

// Map C++ edge kinds → vocabulary the existing Lv1SystemGraph already colors.
// Keep in sync with projectScan.ts:mapEdgeKind — both scan paths produce the
// same edge_type vocabulary so vault frontmatter is identical regardless of
// whether framework-scan or LLM-scan wrote the file.
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

// Quote a YAML scalar only when it would otherwise be misparsed. Our embedded
// frontmatter parser is permissive but we still need to defend against colons
// in asset paths and leading dashes that look like list items.
function yamlScalar(s: string): string {
  if (s === '') return `""`;
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

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- Existing-vault index --------------------------------------------------
// Walks every .md in the vault and builds:
//   byAsset[asset_path] = relative_path        — preserves user-moved per-BP notes
//   bySystem[system_id]  = relative_path       — preserves user-renamed Systems/*.md
// Failures are tolerated quietly: a corrupt or non-frontmatter file just
// doesn't show up in the index and the scan falls back to the deterministic
// path (which then overwrites the bad file — desired).

interface ExistingVaultIndex {
  byAsset: Map<string, string>;
  bySystem: Map<string, string>;
}

async function buildExistingVaultIndex(projectRoot: string): Promise<ExistingVaultIndex> {
  const byAsset = new Map<string, string>();
  const bySystem = new Map<string, string>();
  let listing;
  try {
    listing = await listVault(projectRoot);
  } catch {
    return { byAsset, bySystem };
  }
  if (!listing.exists) return { byAsset, bySystem };

  // Read every .md (skip _meta/* and _systems/* — those are legacy aggregates,
  // not user content).  Reads run sequentially to avoid hammering the bridge;
  // first scan populates the cache so this is one-time-per-scan cost.
  for (const f of listing.files) {
    const top = f.relative_path.split('/')[0] ?? '';
    if (top === '_meta' || top === '_systems') continue;
    try {
      const file = await readVaultFile(projectRoot, f.relative_path);
      const fm = file.frontmatter as Record<string, unknown>;
      const assetPath = typeof fm.asset_path === 'string' ? fm.asset_path : '';
      if (assetPath) {
        byAsset.set(assetPath, f.relative_path);
      }
      const systemId = typeof fm.system_id === 'string' ? fm.system_id : '';
      if (systemId && fm.node_type === 'System') {
        bySystem.set(systemId, f.relative_path);
      }
    } catch {
      // skip — file will be (re)written at deterministic path on this scan
    }
  }
  return { byAsset, bySystem };
}
