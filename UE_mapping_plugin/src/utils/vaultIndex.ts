import type { VaultFile } from '../services/vaultApi';
import type { VaultListEntry } from '../services/vaultApi';

// Derives view-friendly groupings from a set of loaded vault files.
// For files we haven't loaded yet (only the directory listing), we fall
// back to the subdir hint (Blueprints / CPP / Interfaces).

export interface NodeSummary {
  relativePath: string;
  title: string;
  nodeType: string;
  subdir: string;
  systems: string[];     // e.g. ["combat", "ai"] from frontmatter tags
  layer?: string;
  role?: string;
  intent?: string;
  riskLevel?: string;
  loaded: boolean;
}

export function summarize(entry: VaultListEntry, file?: VaultFile): NodeSummary {
  if (!file) {
    return {
      relativePath: entry.relative_path,
      title: entry.title,
      nodeType: subdirToType(entry.subdir),
      subdir: entry.subdir,
      systems: [],
      loaded: false,
    };
  }
  const fm = file.frontmatter;
  const tags = (fm.tags ?? []) as string[];
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
  return {
    relativePath: entry.relative_path,
    title: (fm.title as string) ?? entry.title,
    nodeType: (fm.node_type as string) ?? subdirToType(entry.subdir),
    subdir: entry.subdir,
    systems,
    layer,
    role,
    intent: fm.intent as string | undefined,
    riskLevel: (fm.risk_level as string) ?? 'nominal',
    loaded: true,
  };
}

function subdirToType(sub: string): string {
  if (sub.startsWith('Blueprints')) return 'Blueprint';
  if (sub.startsWith('CPP')) return 'CPP';
  if (sub.startsWith('Interfaces')) return 'Interface';
  if (sub.startsWith('Components')) return 'Component';
  if (sub.startsWith('Widgets')) return 'WidgetBlueprint';
  if (sub.startsWith('Anims')) return 'AnimBlueprint';
  if (sub.startsWith('Libraries')) return 'FunctionLibrary';
  if (sub.startsWith('Systems')) return 'System';
  // Phase B (§22.5 #4) — DataTable / DataAsset both land in Data/.  Default
  // to 'DataAsset' for files without explicit `node_type` frontmatter; the
  // distinction matters less to the UI than the routing.
  if (sub.startsWith('Data')) return 'DataAsset';
  return 'Other';
}

export interface SystemBucket {
  systemId: string;
  count: number;
  nodes: NodeSummary[];
}

export function groupBySystem(summaries: NodeSummary[]): SystemBucket[] {
  const map = new Map<string, NodeSummary[]>();
  for (const s of summaries) {
    // Skip aggregate System entries — they describe a system, they aren't a
    // member of one.  Counting them here would create phantom buckets at L0
    // and pad the L1 force graph with self-referential nodes.
    if (s.nodeType === 'System') continue;
    if (s.systems.length === 0) {
      const k = '_unassigned';
      const arr = map.get(k) ?? [];
      arr.push(s);
      map.set(k, arr);
    } else {
      for (const sys of s.systems) {
        const arr = map.get(sys) ?? [];
        arr.push(s);
        map.set(sys, arr);
      }
    }
  }
  return Array.from(map.entries())
    .map(([systemId, nodes]) => ({ systemId, count: nodes.length, nodes }))
    .sort((a, b) => {
      if (a.systemId === '_unassigned') return 1;
      if (b.systemId === '_unassigned') return -1;
      return b.count - a.count;
    });
}

export function nodeColor(nodeType: string): string {
  switch (nodeType) {
    case 'Blueprint':
    case 'WidgetBlueprint':
    case 'AnimBlueprint':
    case 'FunctionLibrary':
    case 'MacroLibrary':
      return 'var(--node-blueprint)';
    case 'CPP': return 'var(--node-cpp)';
    case 'Interface': return 'var(--node-interface)';
    case 'Component': return 'var(--node-component)';
    case 'DataTable':
    case 'DataAsset':
      return 'var(--node-data)';
    default: return 'var(--text-muted)';
  }
}
