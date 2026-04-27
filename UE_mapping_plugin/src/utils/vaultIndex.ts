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
  return 'Other';
}

export interface SystemBucket {
  systemId: string;
  count: number;
  nodes: NodeSummary[];
}

export function groupBySystem(summaries: NodeSummary[]): SystemBucket[] {
  const map = new Map<string, NodeSummary[]>();
  let untaggedCount = 0;
  for (const s of summaries) {
    if (s.systems.length === 0) {
      const k = '_unassigned';
      const arr = map.get(k) ?? [];
      arr.push(s);
      map.set(k, arr);
      untaggedCount++;
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
    case 'Blueprint': return 'var(--node-blueprint)';
    case 'CPP': return 'var(--node-cpp)';
    case 'Interface': return 'var(--node-interface)';
    case 'Component': return 'var(--node-component)';
    default: return 'var(--text-muted)';
  }
}
