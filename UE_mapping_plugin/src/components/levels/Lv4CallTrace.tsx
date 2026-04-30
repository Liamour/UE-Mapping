// Lv4 — Cross-BP call trace.  HANDOFF §19.3 + §21.5 / §22.
//
// Walks the vault frontmatter `edges:` blocks BFS-style from a root BP and
// renders the result as a concentric force layout: the root sits at the
// centre, layer-1 BPs ring it at radius R, layer-2 at 2R, etc.  Edge colour
// follows the existing vault edge_type vocabulary
// (function_call / interface_call / cast / spawn / listens_to / inheritance /
// delegate) — sharing the same palette as Lv1SystemGraph so the user's
// colour memory carries between views.
//
// Why concentric instead of free-floating force-directed:
//   - Visual answer to "how far is X from the root?" reads instantly off
//     the radius.  A free force layout can drift the root off-centre as
//     hubs accumulate edges, blurring that affordance.
//   - The BFS layer is a meaningful semantic axis — collapsing it into
//     spring forces wastes context.
//
// We still run d3-force for the *intra-ring* layout (forceX / forceY pinning
// each node to its computed (r·cos θ, r·sin θ), forceCollide, forceManyBody
// at low strength) so dense layers spread out instead of stacking on the
// pinned target points.  Edges get straight ReactFlow lines — curved edges
// in concentric layouts get visually noisy fast.
//
// Click a node → navigate Lv2 of that BP's vault file.  The root node's
// click is a no-op (we're already focussed on it).

import React, { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import {
  getCallTrace,
  type CallTraceResponse,
  type CallTraceEdgeType,
  BackendUnreachableError,
} from '../../services/scanApi';
import { tagNodeTypes, type TagNodeData } from '../graph/TagNode';
import { useT } from '../../utils/i18n';

interface Props {
  relativePath: string;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: CallTraceResponse };

const DEFAULT_DEPTH = 3;
const DEFAULT_NODES = 100;

// One radius per BFS layer.  Tightish so a depth=3 trace fits a screen
// without the user needing to pan; intra-ring repulsion expands when a
// layer gets dense.
const LAYER_RADIUS = 280;

// Stable colour per edge type — kept in sync with Lv1SystemGraph so the
// user's "purple = spawn" muscle memory carries.
const EDGE_TYPE_COLOR: Record<string, string> = {
  function_call: '#5a6c8a',
  interface_call: '#7a5a8a',
  cast: '#6c8a4a',
  spawn: '#8a7556',
  listens_to: '#7a3030',
  inheritance: '#3a4a3a',
  delegate: '#5a8a8a',
};

const EDGE_TYPE_ORDER: CallTraceEdgeType[] = [
  'function_call', 'interface_call', 'cast', 'spawn',
  'listens_to', 'delegate', 'inheritance',
];

export const Lv4CallTrace: React.FC<Props> = ({ relativePath }) => {
  const t = useT();
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const files = useVaultStore((s) => s.files);
  const navigate = useTabsStore((s) => s.navigateActive);

  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [maxDepth, setMaxDepth] = useState(DEFAULT_DEPTH);
  const [enabledTypes, setEnabledTypes] = useState<Set<CallTraceEdgeType>>(
    new Set(EDGE_TYPE_ORDER),
  );

  useEffect(() => {
    if (!file) loadFile(relativePath);
  }, [relativePath, file, loadFile]);

  const assetPath = file?.frontmatter.asset_path as string | undefined;

  // Fire whenever the root BP / depth / filter changes.  We do NOT include
  // enabledTypes in the dependency because filtering is a UI-side concern
  // — the backend already handed us the full graph; toggling chips just
  // hides edges.  Re-fetching on every chip click would be wasteful.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!projectRoot || !assetPath) return;
      setState({ kind: 'loading' });
      try {
        const data = await getCallTrace({
          projectRoot,
          rootAssetPath: assetPath,
          maxDepth,
          maxNodes: DEFAULT_NODES,
        });
        if (cancelled) return;
        setState({ kind: 'ready', data });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof BackendUnreachableError
          ? t({
              en: 'Backend offline — start uvicorn (cd backend && uvicorn main:app --reload).',
              zh: '后端未启动 — 请运行 uvicorn (cd backend && uvicorn main:app --reload)。',
            })
          : e instanceof Error ? e.message : String(e);
        setState({ kind: 'error', message });
      }
    };
    run();
    return () => { cancelled = true; };
  }, [projectRoot, assetPath, maxDepth, t]);

  // assetPath → relativePath index for click→navigate.  Built from the
  // sidebar's vault listing so a node click can navigate Lv2 even when
  // its file hasn't been opened yet.
  const assetToRelative = useMemo(() => {
    const idx: Record<string, string> = {};
    for (const f of files) {
      // file listing only carries title; pull asset_path from the cache
      // when available, else skip (Lv2 navigation will fall back).
      // (Most BPs the user clicks will have been touched by an earlier scan
      // so the cache covers them.)
      idx[f.title] = f.relative_path;
    }
    return idx;
  }, [files]);

  // The graph build runs on every (state, enabledTypes) change.  Cheap —
  // O(N+E) with N ≤ max_nodes (default 100), so even a dense trace finishes
  // in well under a render frame.
  const built = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return buildConcentric(state.data, enabledTypes);
  }, [state, enabledTypes]);

  if (!file) {
    return (
      <div className="empty-state">
        <p>{t({ en: 'Loading note…', zh: '正在加载笔记…' })}</p>
      </div>
    );
  }
  if (!assetPath) {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'No', zh: '缺少' })} <code>asset_path</code></h2>
        <p className="muted">
          {t({
            en: 'This vault file has no asset_path in its frontmatter, so the call trace cannot be located.',
            zh: '该 vault 文件的 frontmatter 中没有 asset_path，无法定位调用链。',
          })}
        </p>
      </div>
    );
  }
  if (!projectRoot) {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'No project root', zh: '未设置项目根目录' })}</h2>
        <p className="muted">
          {t({
            en: 'Set a project root in Settings before running a call trace.',
            zh: '请先在「设置」中配置项目根目录。',
          })}
        </p>
      </div>
    );
  }
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div className="empty-state">
        <p className="muted">
          {t({
            en: `Tracing calls from ${file.frontmatter.title ?? relativePath}…`,
            zh: `正在分析来自 ${file.frontmatter.title ?? relativePath} 的调用链…`,
          })}
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'Call trace failed', zh: '调用链加载失败' })}</h2>
        <p className="muted">{state.message}</p>
      </div>
    );
  }

  const presentTypes = Array.from(new Set(state.data.edges.map((e) => e.edge_type)))
    .filter((t) => EDGE_TYPE_ORDER.includes(t as CallTraceEdgeType))
    .sort((a, b) => EDGE_TYPE_ORDER.indexOf(a) - EDGE_TYPE_ORDER.indexOf(b));

  const onNodeClick = (_evt: unknown, n: Node<TagNodeData>) => {
    if (!n.data) return;
    const target = (n.data as TagNodeData).label;
    const rel = assetToRelative[target];
    if (rel) navigate({ level: 'lv2', relativePath: rel }, target);
  };

  const onToggleType = (type: CallTraceEdgeType) => {
    setEnabledTypes((cur) => {
      const next = new Set(cur);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="function-flow">
      <div className="function-flow-header">
        <div>
          <h2>
            {t({ en: 'Call trace from ', zh: '调用链起点：' })}
            <code>{(file.frontmatter.title as string | undefined) ?? relativePath}</code>
          </h2>
          <span className="muted">
            {t({
              en: `${state.data.nodes.length} nodes · ${state.data.edges.length} edges · depth ≤ ${state.data.max_depth}`,
              zh: `${state.data.nodes.length} 个节点 · ${state.data.edges.length} 条边 · 深度 ≤ ${state.data.max_depth}`,
            })}
            {state.data.truncated && (
              <span style={{ marginLeft: 12, color: '#dc2626' }}>
                {t({
                  en: '· truncated (frontier hit max_nodes)',
                  zh: '· 已截断（前沿超过 max_nodes 上限）',
                })}
              </span>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/*
            Button-group depth picker.  An HTML <select> would crash CEF
            (UE5 WebBrowser) on some Windows configs because the Chromium
            popup widget can't resolve a parent HWND inside the embedded
            view — surfaces as a __debugbreak() / 0xC0000005 in
            UnrealEditor-WebBrowser.dll.  Custom toggle group avoids the
            popup entirely.
          */}
          <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {t({ en: 'Depth', zh: '深度' })}:
          </span>
          <div className="depth-picker" role="radiogroup" aria-label="depth">
            {[1, 2, 3, 4, 5].map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={d === maxDepth}
                onClick={() => setMaxDepth(d)}
                style={{
                  padding: '2px 8px',
                  border: '1px solid #d8d4c8',
                  background: d === maxDepth ? '#3b82f6' : 'transparent',
                  color: d === maxDepth ? '#fff' : 'inherit',
                  cursor: 'pointer',
                  fontSize: 'var(--fs-sm)',
                  borderRadius: 0,
                  marginLeft: -1,    // collapse adjacent borders
                  fontWeight: d === maxDepth ? 600 : 400,
                }}
              >
                {d}
              </button>
            ))}
          </div>
          <code className="muted">{relativePath}</code>
        </div>
      </div>
      <div className="function-flow-legend">
        {presentTypes.map((type) => {
          const enabled = enabledTypes.has(type);
          return (
            <button
              key={type}
              type="button"
              className="edge-legend-item"
              onClick={() => onToggleType(type)}
              style={{
                cursor: 'pointer',
                opacity: enabled ? 1 : 0.35,
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                color: 'inherit',
                font: 'inherit',
              }}
              title={t({
                en: enabled ? `Click to hide ${type}` : `Click to show ${type}`,
                zh: enabled ? `点击隐藏 ${type}` : `点击显示 ${type}`,
              })}
            >
              <span
                className="edge-legend-swatch edge-legend-swatch-line"
                style={{ background: EDGE_TYPE_COLOR[type] ?? '#6b6357' }}
              />
              {type}
            </button>
          );
        })}
      </div>
      <div className="function-flow-canvas">
        <ReactFlow
          nodes={built?.nodes ?? []}
          edges={built?.edges ?? []}
          nodeTypes={tagNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          nodesDraggable
          nodesConnectable={false}
          panOnDrag
          zoomOnScroll
          minZoom={0.2}
          maxZoom={2}
          onNodeClick={onNodeClick}
        >
          <Background gap={32} color="#e2dfd4" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
};

// ── Layout ─────────────────────────────────────────────────────────────────
// Pure-geometric concentric: layer 0 → centre, layer L → ring of radius
// max(L · LAYER_RADIUS, min_radius_to_fit_count).  No force pass — the
// answer to "how far is X from the root?" reads off the ring directly,
// and any spring relaxation would muddy that.  Dense rings push their
// radius outward (`min_radius_to_fit_count`) instead of squeezing nodes
// against each other.
//
// Layer-N ordering: when a node has a unique parent in layer N-1, we
// inherit that parent's angle so children fan out roughly under their
// caller — purely cosmetic but dramatically reduces edge crossings on
// hub-rooted traces.

interface PositionedNode {
  id: string;             // asset_path
  layer: number;
  x: number;
  y: number;
  title: string;
  nodeType: string;
  riskLevel: string;
  isRoot: boolean;
  isMissing: boolean;
}

// Min angular distance between two nodes on the same ring before we
// consider expanding the radius.  Tuned so a typical TagNode card (~120 px
// wide) doesn't visually collide with its ring-neighbour at the default
// LAYER_RADIUS = 280.
const MIN_NODE_SPACING = 110;

function buildConcentric(
  data: CallTraceResponse,
  enabledTypes: Set<CallTraceEdgeType>,
): { nodes: Node<TagNodeData>[]; edges: Edge[] } {
  // Bucket nodes by layer for ring placement.
  const byLayer = new Map<number, typeof data.nodes>();
  for (const n of data.nodes) {
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer)!.push(n);
  }

  // Layer-N nodes inherit their primary parent's angle when available so
  // edges radiate outward instead of crossing the disc.  Built layer by
  // layer in BFS order.
  const angleByAsset = new Map<string, number>();
  const positioned: PositionedNode[] = [];
  const layers = Array.from(byLayer.keys()).sort((a, b) => a - b);

  for (const layer of layers) {
    const ring = byLayer.get(layer) ?? [];

    if (layer === 0) {
      // Root: one node at the centre.  No angle assignment needed for
      // children — they'll fall back to even spacing if no other parent
      // is found.
      const root = ring[0];
      if (root) {
        positioned.push({
          id: root.asset_path,
          layer: 0,
          x: 0, y: 0,
          title: root.title,
          nodeType: root.node_type,
          riskLevel: (root.risk_level ?? 'nominal').toString(),
          isRoot: true,
          isMissing: !!root.missing,
        });
        angleByAsset.set(root.asset_path, 0);
      }
      continue;
    }

    // Find each ring-N node's first incoming edge from layer N-1 to
    // inherit angle.  Falls back to even spacing when no parent is found.
    const parentAngle = new Map<string, number>();
    for (const e of data.edges) {
      if (parentAngle.has(e.target)) continue;
      const a = angleByAsset.get(e.source);
      if (a !== undefined) parentAngle.set(e.target, a);
    }

    const sortedRing = ring.slice().sort((a, b) => {
      const aa = parentAngle.get(a.asset_path);
      const bb = parentAngle.get(b.asset_path);
      // Nodes with a known parent angle sort by it; orphans go after.
      if (aa === undefined && bb === undefined) return 0;
      if (aa === undefined) return 1;
      if (bb === undefined) return -1;
      return aa - bb;
    });

    const count = sortedRing.length;
    // Expand radius if the ring is too dense to fit at the default radius.
    const minCircumference = count * MIN_NODE_SPACING;
    const minRadius = minCircumference / (2 * Math.PI);
    const r = Math.max(layer * LAYER_RADIUS, minRadius);

    sortedRing.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / count;
      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);
      angleByAsset.set(n.asset_path, angle);
      positioned.push({
        id: n.asset_path,
        layer,
        x, y,
        title: n.title,
        nodeType: n.node_type,
        riskLevel: (n.risk_level ?? 'nominal').toString(),
        isRoot: false,
        isMissing: !!n.missing,
      });
    });
  }

  const reactNodes: Node<TagNodeData>[] = positioned.map((n) => ({
    id: n.id,
    type: 'tag',
    position: { x: n.x, y: n.y },
    data: {
      label: n.title,
      tag: n.isRoot ? 'root' : `layer ${n.layer}`,
      color: nodeColorFor(n),
    },
    draggable: !n.isRoot,
  }));

  const reactEdges: Edge[] = data.edges
    .filter((e) => enabledTypes.has(e.edge_type))
    .map((e, i) => ({
      id: `${e.source}->${e.target}#${i}`,
      source: e.source,
      target: e.target,
      label: e.refs[0]?.length ? e.refs[0] : undefined,
      style: {
        stroke: EDGE_TYPE_COLOR[e.edge_type] ?? '#6b6357',
        strokeWidth: e.edge_type === 'inheritance' ? 1 : 1.5,
        strokeDasharray: e.edge_type === 'cast' ? '4 3' : undefined,
      },
      labelStyle: { fontSize: 10, fill: '#5a5147' },
    }));

  return { nodes: reactNodes, edges: reactEdges };
}

function nodeColorFor(n: PositionedNode): string {
  if (n.isMissing) return '#9ca3af';
  if (n.isRoot) return '#3b82f6';
  if (n.riskLevel === 'critical') return '#dc2626';
  if (n.riskLevel === 'warning') return '#d97706';
  // Default per-type tint matches the rest of the app's palette.
  switch (n.nodeType) {
    case 'Interface': return '#8b5cf6';
    case 'WidgetBlueprint': return '#0ea5e9';
    case 'AnimBlueprint': return '#10b981';
    case 'Component': return '#f59e0b';
    default: return '#6b6357';
  }
}
