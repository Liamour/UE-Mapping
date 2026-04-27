// Map-of-Content (MOC) generator. Aggregates vault files by `system/X` tag and
// writes one `_systems/X.md` per system. Implementation lives in the frontend
// (rather than the C++ bridge) because the YAML parser already runs here and
// the bridge has no LLM/parser dependency.
//
// MOC files are plain markdown (no frontmatter) so the regular vault scanner
// won't accidentally treat them as nodes.

import { listVault, readVaultFile } from './vaultApi';
import { isVaultFileWriteAvailable, bridgeWriteVaultFile } from './bridgeApi';
import type { VaultFrontmatter } from '../utils/frontmatter';

export interface MOCEntry {
  title: string;
  relativePath: string;
  intent?: string;
  riskLevel?: string;
  layer?: string;
  role?: string;
  nodeType?: string;
}

export interface MOCResult {
  systemId: string;
  outputPath: string;
  entryCount: number;
}

export interface MOCRunResult {
  systems: MOCResult[];
  unassignedCount: number;
  ranAt: string;
}

// Walk the vault, parse every file's tags, group by system, write a MOC per
// group. Returns a per-system summary.
export async function rebuildSystemMOCs(projectRoot: string): Promise<MOCRunResult> {
  if (!isVaultFileWriteAvailable()) {
    throw new Error('writevaultfile bridge method not bound — rebuild the AICartographer C++ plugin and relaunch UE.');
  }

  const list = await listVault(projectRoot);
  // Skip MOC files themselves and other _systems/_meta artifacts so we don't
  // recursively cite them.
  const sourceFiles = list.files.filter((f) => !f.relative_path.startsWith('_systems/') && !f.relative_path.startsWith('_meta/'));

  const bySystem = new Map<string, MOCEntry[]>();
  let unassignedCount = 0;

  for (const f of sourceFiles) {
    const file = await readVaultFile(projectRoot, f.relative_path);
    const fm = file.frontmatter;
    const { systems, layer, role } = extractTagAxes(fm);
    const entry: MOCEntry = {
      title: (fm.title as string) ?? f.title,
      relativePath: f.relative_path,
      intent: fm.intent as string | undefined,
      riskLevel: fm.risk_level as string | undefined,
      layer,
      role,
      nodeType: fm.node_type as string | undefined,
    };
    if (systems.length === 0) {
      unassignedCount++;
      continue;
    }
    for (const sys of systems) {
      const arr = bySystem.get(sys) ?? [];
      arr.push(entry);
      bySystem.set(sys, arr);
    }
  }

  const ranAt = new Date().toISOString();
  const results: MOCResult[] = [];
  for (const [systemId, entries] of bySystem.entries()) {
    entries.sort((a, b) => a.title.localeCompare(b.title));
    const md = renderMOC(systemId, entries, ranAt);
    const outputPath = `_systems/${systemId}.md`;
    await bridgeWriteVaultFile(projectRoot, outputPath, md);
    results.push({ systemId, outputPath, entryCount: entries.length });
  }
  results.sort((a, b) => a.systemId.localeCompare(b.systemId));

  return { systems: results, unassignedCount, ranAt };
}

function extractTagAxes(fm: VaultFrontmatter): { systems: string[]; layer?: string; role?: string } {
  const tags = (fm.tags ?? []) as unknown[];
  const systems: string[] = [];
  let layer: string | undefined;
  let role: string | undefined;
  for (const tRaw of tags) {
    if (typeof tRaw !== 'string') continue;
    const t = tRaw.startsWith('#') ? tRaw.slice(1) : tRaw;
    if (t.startsWith('system/')) systems.push(t.slice('system/'.length));
    else if (t.startsWith('layer/')) layer = t.slice('layer/'.length);
    else if (t.startsWith('role/')) role = t.slice('role/'.length);
  }
  return { systems, layer, role };
}

function renderMOC(systemId: string, entries: MOCEntry[], ranAt: string): string {
  const titleCase = systemId.charAt(0).toUpperCase() + systemId.slice(1);
  const lines: string[] = [];
  lines.push(`# ${titleCase} — System Map`);
  lines.push('');
  lines.push(`> Auto-generated MOC. Lists every node tagged \`system/${systemId}\`. Regenerate from Settings → Rebuild MOCs.`);
  lines.push('');
  lines.push(`_Last regenerated: ${ranAt}_`);
  lines.push('');

  // Group within system by layer
  const byLayer = new Map<string, MOCEntry[]>();
  for (const e of entries) {
    const k = e.layer ?? '(unlayered)';
    const arr = byLayer.get(k) ?? [];
    arr.push(e);
    byLayer.set(k, arr);
  }
  const layers = Array.from(byLayer.keys()).sort();

  for (const layer of layers) {
    lines.push(`## Layer: ${layer}`);
    lines.push('');
    for (const e of byLayer.get(layer)!) {
      const linkPath = relativePathFromMOC(e.relativePath);
      const meta: string[] = [];
      if (e.role) meta.push(`role:${e.role}`);
      if (e.nodeType) meta.push(e.nodeType);
      if (e.riskLevel && e.riskLevel !== 'nominal') meta.push(`risk:${e.riskLevel}`);
      const metaStr = meta.length ? ` — _${meta.join(' · ')}_` : '';
      lines.push(`- [[${e.title}|${linkPath}]]${metaStr}`);
      if (e.intent) {
        lines.push(`  - ${e.intent}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Total nodes in this system: **${entries.length}**`);
  lines.push('');
  return lines.join('\n');
}

// MOC files live in `_systems/`, so links to vault files (which live one
// directory up) need a `../` prefix.
function relativePathFromMOC(target: string): string {
  return `../${target}`;
}
