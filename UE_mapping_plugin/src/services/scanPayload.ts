// Single source of truth for "what we send to the LLM".  Both the project
// batch scan (project_scan.ts) and the per-node Deep reasoning button
// (Lv2BlueprintFocus.tsx) build their ScanBatchNode through these helpers
// so the two paths stay in lockstep.  Adding a new scan trigger (L1 enrich,
// future agent loops, …) means importing one of the two builders below —
// not duplicating shape-juggling code three times like before.
//
// Why this matters:
//   1. The backend prompt (`main.py:analyze_one_node`) JSON-serialises
//      `ast_data` straight into the user message — anything not in that
//      dict the LLM never sees.
//   2. The vault writer (`vault_writer.py:_build_frontmatter`) reads
//      `outbound_edges` for the `edges:` block AND mines `ast_data` for
//      `exports.*` / `components` / `variables`.  Both sides must be
//      populated, otherwise the .md gets a wiped frontmatter section.
//   3. Pre-refactor, batch had outbound_edges but no edges in ast_data
//      (LLM blind to relationships) and single-node had edges in ast_data
//      but empty outbound_edges (writer wiped frontmatter edges on rerun).
//      One helper, both bugs gone.
//
// The two entry points map "where the AST came from" to a ScanBatchNode:
//   - buildScanNodeFromBridge      ← fresh C++ deep-scan result (batch path)
//   - buildScanNodeFromFrontmatter ← already-written vault file (single-node path)

import type { BridgeDeepScanResult } from './bridgeApi';
import type { ScanBatchNode, ScanBatchEdge } from './scanApi';
import type { VaultEdge, VaultFrontmatter } from '../utils/frontmatter';

// What the LLM sees + what the backend mines for frontmatter persistence.
// Edges live here in the same nested {kind: [{target, refs}]} shape the
// vault frontmatter uses — that way "scan from bridge" and "scan from
// existing file" produce byte-identical ast_data when the underlying AST
// hasn't changed.
export interface ScanASTData {
  ast_hash: string;
  asset_path: string;
  exports_functions: string[];
  exports_events: string[];
  exports_dispatchers: string[];
  components: Array<{ name?: string; class?: string; parent?: string }>;
  edges: Record<string, Array<{ target: string; refs?: string[] }>>;
}

// Map raw bridge edge kinds → vault edge_type vocabulary.  Mirrors the
// table in vault_writer / frameworkScan; centralising it here means the
// single-node path uses the same vocabulary too.
function mapBridgeEdgeKind(rawKind: string): string {
  switch (rawKind) {
    case 'call': return 'function_call';
    case 'cast': return 'cast';
    case 'spawn': return 'spawn';
    case 'delegate': return 'listens_to';
    case 'inherits': return 'inheritance';
    default: return rawKind;
  }
}

// Build the LLM-facing AST blob from a fresh C++ deep-scan result.  Edges
// targeting assets outside the scanned set (engine classes, plugin content)
// are dropped — the L1/L2 graph can only render in-project links anyway,
// and feeding the LLM "BP_Foo calls UPrimitiveComponent::SetVisibility"
// dilutes its attention without telling the user anything new.
export function buildScanASTFromBridge(
  r: BridgeDeepScanResult,
  assetPathToName: Record<string, string>,
): ScanASTData {
  const fns = r.functions ?? [];
  const edges: ScanASTData['edges'] = {};

  for (const e of r.edges ?? []) {
    const targetName = assetPathToName[e.target_asset];
    if (!targetName) continue;
    const kind = mapBridgeEdgeKind(e.kind);
    const refLabel = e.target_function
      ? `${e.from_function} → ${e.target_function}`
      : e.from_function;
    if (!edges[kind]) edges[kind] = [];
    const existing = edges[kind].find((x) => x.target === targetName);
    if (existing) {
      existing.refs ??= [];
      if (refLabel && !existing.refs.includes(refLabel)) existing.refs.push(refLabel);
    } else {
      edges[kind].push({ target: targetName, refs: refLabel ? [refLabel] : [] });
    }
  }

  return {
    ast_hash: r.ast_hash,
    asset_path: r.asset_path,
    exports_functions: fns.filter((f) => f.kind === 'function').map((f) => f.name),
    exports_events: fns
      .filter((f) => f.kind === 'event' || f.kind === 'custom_event')
      .map((f) => f.name),
    exports_dispatchers: fns.filter((f) => f.kind === 'dispatcher').map((f) => f.name),
    components: r.components ?? [],
    edges,
  };
}

// Build the LLM-facing AST blob from an already-written vault file.
// Used by Lv2 "Deep reasoning": the .md is the system of record once a
// framework scan has run, so re-extracting from the bridge would be
// redundant work.  Falls back to empty arrays/dicts for fields the
// frontmatter omits (e.g. components on Interfaces).
export function buildScanASTFromFrontmatter(fm: VaultFrontmatter): ScanASTData {
  return {
    ast_hash: (fm.ast_hash as string) ?? '',
    asset_path: (fm.asset_path as string) ?? '',
    exports_functions: ((fm.exports_functions as string[] | undefined) ?? []),
    exports_events: ((fm.exports_events as string[] | undefined) ?? []),
    exports_dispatchers: ((fm.exports_dispatchers as string[] | undefined) ?? []),
    components: ((fm.components as Array<{ name?: string; class?: string; parent?: string }> | undefined) ?? []),
    edges: ((fm.edges as Record<string, VaultEdge[]> | undefined) ?? {}),
  };
}

// Flatten the nested edges dict to the flat outbound_edges shape the
// backend's vault writer expects.  Both scan paths use this so the writer
// always gets edges regardless of whether the source was a bridge call
// (where edges came from C++) or a frontmatter read (where edges came
// from a previous scan's .md).
//
// Defensive: edges with missing/empty `target` are dropped here.  The
// backend's EdgePayload Pydantic model requires `target: str` (non-empty)
// and rejects the whole request with HTTP 422 if any item lacks it.  A
// historical scan or an older plugin version occasionally seeded the
// vault frontmatter with target-less edges (e.g. when target_asset
// failed to resolve to a project-local name and the writer didn't filter);
// dropping them at the outbound boundary prevents one bad row from
// breaking Deep Reasoning entirely.
export function flattenEdgesToOutbound(
  edges: ScanASTData['edges'],
): ScanBatchEdge[] {
  const out: ScanBatchEdge[] = [];
  for (const [kind, list] of Object.entries(edges)) {
    for (const e of list ?? []) {
      const target = (e?.target ?? '').toString().trim();
      if (!target) continue;
      out.push({
        target,
        edge_type: kind,
        refs: e.refs ?? [],
      });
    }
  }
  return out;
}

// One-stop builder: bridge scan → ScanBatchNode.  Used by the project-wide
// batch scan after fingerprinting via bridgeRequestDeepScan.
export function buildScanNodeFromBridge(
  r: BridgeDeepScanResult,
  nodeId: string,
  assetPathToName: Record<string, string>,
): ScanBatchNode {
  const ast = buildScanASTFromBridge(r, assetPathToName);
  return {
    node_id: nodeId,
    asset_path: r.asset_path,
    title: r.name,
    node_type: r.node_type,
    parent_class: r.parent_class || undefined,
    ast_data: ast as unknown as Record<string, unknown>,
    outbound_edges: flattenEdgesToOutbound(ast.edges),
  };
}

// One-stop builder: existing frontmatter → ScanBatchNode.  Used by the
// per-node Deep reasoning button when the user wants to re-analyse a BP
// without re-fingerprinting it (the .md already has all the AST data).
export function buildScanNodeFromFrontmatter(
  fm: VaultFrontmatter,
  relativePath: string,
): ScanBatchNode {
  const title = (fm.title as string) ?? relativePath;
  const ast = buildScanASTFromFrontmatter(fm);
  return {
    node_id: title,
    asset_path: ast.asset_path,
    title,
    node_type: (fm.node_type as string) ?? 'Blueprint',
    parent_class: (fm.parent_class as string | undefined) ?? undefined,
    ast_data: ast as unknown as Record<string, unknown>,
    outbound_edges: flattenEdgesToOutbound(ast.edges),
  };
}
