// L2 blueprint view in GRAPH mode.
//
// Renders the internals of a single blueprint as a force graph: events,
// functions, and components are nodes; the BP's outgoing edges (call / cast /
// spawn / listens_to) connect those nodes to the corresponding TARGET
// blueprints in the same view (rendered as muted "external" nodes the user
// can click to navigate one level out).
//
// Data sources come from the BP's vault frontmatter (skeleton or LLM-derived
// — both have the same shape):
//   exports_events / exports_functions / exports_dispatchers  → internal nodes
//   components                                                → internal nodes
//   edges.<kind>[].target / .refs                              → connector edges
//
// Clicking a function node drills into Lv3 (function flow). Clicking an
// external blueprint node navigates to Lv2 of THAT blueprint (mode preserved
// at the AppShell dispatch level).

import React, { useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { tagNodeTypes, type TagNodeData } from '../graph/TagNode';
import type { VaultEdge } from '../../utils/frontmatter';
import { useT } from '../../utils/i18n';

interface Props {
  relativePath: string;
}

export const Lv2BlueprintGraph: React.FC<Props> = ({ relativePath }) => {
  const t = useT();
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const navigate = useTabsStore((s) => s.navigateActive);

  useEffect(() => {
    if (!file) loadFile(relativePath);
  }, [relativePath, file, loadFile]);

  // We need the title→relativePath index to turn edge targets (which reference
  // BPs by name) into Lv2 navigation targets.  Build this from both the index
  // listing and any cached frontmatter titles (the listing's title is the
  // filename stem which already matches our convention).
  const titleToPath = useMemo(() => {
    const idx: Record<string, string> = {};
    for (const f of files) idx[f.title] = f.relative_path;
    for (const cached of Object.values(fileCache)) {
      const t = cached.frontmatter.title;
      if (typeof t === 'string') idx[t] = cached.relative_path;
    }
    return idx;
  }, [files, fileCache]);

  const built = useMemo(
    () => (file ? buildGraph(file, relativePath, titleToPath) : null),
    [file, relativePath, titleToPath],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<TagNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Same drag-preserving merge as Lv1SystemGraph: when the underlying graph
  // is recomputed (file reload, BP switch), keep current positions for any
  // node id that survived so the user's manual drags don't get clobbered.
  useEffect(() => {
    if (!built) return;
    setNodes((current) => {
      const posById = new Map(current.map((n) => [n.id, n.position]));
      return built.nodes.map((n) =>
        posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n,
      );
    });
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  if (!file) {
    return <div className="empty-state"><p>{t({ en: 'Loading note…', zh: '正在加载笔记…' })}</p></div>;
  }
  if (!built || built.nodes.length === 0) {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'No internal structure', zh: '无内部结构' })}</h2>
        <p className="muted">
          {t({
            en: 'This blueprint has no events / functions / components / outgoing edges to graph. Try the markdown view, or run a deep scan.',
            zh: '该蓝图没有可绘制的事件 / 函数 / 组件 / 出向边。请改用 markdown 视图，或运行深度扫描。',
          })}
        </p>
      </div>
    );
  }

  const fm = file.frontmatter;

  return (
    <div className="bp-graph">
      <div className="bp-graph-header">
        <div>
          <h2>{(fm.title as string) ?? relativePath}</h2>
          <span className="muted">
            {t({
              en: `${built.internalCount} internal · ${built.externalCount} external · ${built.edges.length} edges`,
              zh: `内部 ${built.internalCount} · 外部 ${built.externalCount} · ${built.edges.length} 条边`,
            })}
          </span>
        </div>
        <code className="muted">{relativePath}</code>
      </div>
      <div className="bp-graph-legend">
        {LEGEND_NODE_TYPES.filter((t) => built.presentTags.has(t.tag)).map((t) => (
          <span key={t.tag} className="edge-legend-item">
            <span className="edge-legend-swatch edge-legend-swatch-node" style={{ background: t.color }} />
            {t.tag}
          </span>
        ))}
        {built.presentEdgeKinds.size > 0 && <span className="function-flow-legend-sep" />}
        {Array.from(built.presentEdgeKinds).sort().map((k) => (
          <span key={k} className="edge-legend-item">
            <span className="edge-legend-swatch edge-legend-swatch-line" style={{ background: edgeColor(k) }} />
            {k}
          </span>
        ))}
      </div>
      <div className="bp-graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={tagNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable
          nodesConnectable={false}
          panOnDrag
          zoomOnScroll
          minZoom={0.2}
          maxZoom={2}
          onNodeClick={(_e, n) => {
            const d = n.data as InternalNodeData;
            if (d.kind === 'function' || d.kind === 'event') {
              // Drill into Lv3 function flow for own functions/events.
              if (d.functionId) {
                navigate({ level: 'lv3', relativePath, functionId: d.functionId }, d.functionId);
              }
            } else if (d.kind === 'external' && d.externalPath) {
              // Hop to that external blueprint's L2 (current mode).
              navigate({ level: 'lv2', relativePath: d.externalPath }, d.label);
            }
          }}
        >
          <Background gap={32} color="#e2dfd4" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
};

// ---- Node taxonomy --------------------------------------------------------

interface InternalNodeData extends TagNodeData {
  kind: 'event' | 'function' | 'dispatcher' | 'component' | 'external';
  functionId?: string;       // for own events/functions — drives Lv3 drill
  externalPath?: string;     // for external blueprints — drives Lv2 hop
}

const LEGEND_NODE_TYPES: Array<{ tag: string; color: string }> = [
  { tag: 'event',       color: '#7a3030' },
  { tag: 'function',    color: '#5a6c8a' },
  { tag: 'dispatcher',  color: '#8a6c4a' },
  { tag: 'component',   color: '#6c8a4a' },
  { tag: 'external',    color: '#6b6357' },
];

function colorFor(tag: string): string {
  const hit = LEGEND_NODE_TYPES.find((t) => t.tag === tag);
  return hit?.color ?? '#6b6357';
}

function edgeColor(kind: string): string {
  switch (kind) {
    case 'function_call': return '#8a7556';
    case 'interface_call': return '#8a4a6c';
    case 'cast': return '#4a6c8a';
    case 'spawn': return '#6c8a4a';
    case 'listens_to': return '#8a6c4a';
    default: return '#a39f8e';
  }
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  data: InternalNodeData;
}

function buildGraph(
  file: ReturnType<typeof useVaultStore.getState>['fileCache'][string],
  relativePath: string,
  titleToPath: Record<string, string>,
): {
  nodes: Node<TagNodeData>[];
  edges: Edge[];
  internalCount: number;
  externalCount: number;
  presentTags: Set<string>;
  presentEdgeKinds: Set<string>;
} {
  const fm = file.frontmatter;
  const events = (fm.exports_events ?? []) as string[];
  const functions = (fm.exports_functions ?? []) as string[];
  const dispatchers = (fm.exports_dispatchers ?? []) as string[];
  const components = (fm.components ?? []) as Array<{ name?: string; class?: string }>;
  const edgesByKind = (fm.edges ?? {}) as Record<string, VaultEdge[]>;

  const simNodes: SimNode[] = [];
  const idSeen = new Set<string>();
  const presentTags = new Set<string>();

  const pushInternal = (id: string, data: InternalNodeData) => {
    if (idSeen.has(id)) return;
    idSeen.add(id);
    presentTags.add(data.tag);
    simNodes.push({ id, data });
  };

  for (const ev of events) {
    pushInternal(`event:${ev}`, {
      kind: 'event',
      tag: 'event',
      label: ev,
      color: colorFor('event'),
      functionId: ev,
    });
  }
  for (const fn of functions) {
    pushInternal(`fn:${fn}`, {
      kind: 'function',
      tag: 'function',
      label: fn,
      color: colorFor('function'),
      functionId: fn,
    });
  }
  for (const d of dispatchers) {
    pushInternal(`disp:${d}`, {
      kind: 'dispatcher',
      tag: 'dispatcher',
      label: d,
      color: colorFor('dispatcher'),
    });
  }
  for (const c of components) {
    const name = c.name ?? '?';
    const cls = c.class ?? '';
    pushInternal(`comp:${name}`, {
      kind: 'component',
      tag: 'component',
      label: name,
      color: colorFor('component'),
      subLabel: cls.replace(/_C$/, ''),
    });
  }

  // Build edges: each (kind, target) pair is one connector. We attach the
  // edge to the most specific source we can identify by parsing `refs`
  // ("from_function → target_function" or just "from_function").  When the
  // source name matches one of our internal events/functions, the edge starts
  // there; otherwise it falls back to a synthetic "(self)" anchor node so the
  // user can still see the dependency.
  const flowEdges: Edge[] = [];
  const presentEdgeKinds = new Set<string>();
  let externalCount = 0;
  let edgeSeq = 0;
  const ensureExternal = (targetTitle: string): string => {
    const id = `ext:${targetTitle}`;
    if (!idSeen.has(id)) {
      idSeen.add(id);
      presentTags.add('external');
      const externalPath = titleToPath[targetTitle];
      simNodes.push({
        id,
        data: {
          kind: 'external',
          tag: 'external',
          label: targetTitle,
          color: colorFor('external'),
          externalPath,
        },
      });
      externalCount++;
    }
    return id;
  };
  let selfAdded = false;
  const ensureSelfAnchor = (): string => {
    const id = '__self__';
    if (!selfAdded) {
      selfAdded = true;
      idSeen.add(id);
      presentTags.add('event'); // re-use event color so the anchor reads "entry-ish"
      simNodes.push({
        id,
        data: {
          kind: 'event',
          tag: 'self',
          label: (fm.title as string) ?? relativePath,
          color: '#444',
        },
      });
    }
    return id;
  };

  const ownNames = new Set([...events, ...functions, ...dispatchers]);
  const idForOwnName = (name: string): string | undefined => {
    if (events.includes(name)) return `event:${name}`;
    if (functions.includes(name)) return `fn:${name}`;
    if (dispatchers.includes(name)) return `disp:${name}`;
    return undefined;
  };

  for (const [kind, list] of Object.entries(edgesByKind)) {
    for (const e of (list as VaultEdge[]) ?? []) {
      const target = e.target;
      if (!target) continue;
      const tgtId = ensureExternal(target);
      const refs = e.refs && e.refs.length > 0 ? e.refs : [''];
      for (const ref of refs) {
        const fromName = ref.includes('→') ? ref.split('→')[0].trim() : ref.trim();
        const sourceId = (fromName && ownNames.has(fromName))
          ? idForOwnName(fromName)!
          : ensureSelfAnchor();
        const id = `e-${edgeSeq++}`;
        flowEdges.push({
          id,
          source: sourceId,
          target: tgtId,
          data: { kind },
          style: { stroke: edgeColor(kind), strokeWidth: 1.5, opacity: 0.8 },
          label: ref.includes('→') ? ref.split('→')[1].trim() : undefined,
          labelStyle: { fontSize: 9, fill: '#6b6357' },
          labelBgStyle: { fill: 'rgba(245,242,232,0.85)' },
        });
        presentEdgeKinds.add(kind);
      }
    }
  }

  // d3-force layout — same node-count-tiered parameters as Lv1, just with
  // tighter defaults because L2 graphs are usually small (≤30 nodes).
  for (let i = 0; i < simNodes.length; i++) {
    const s = simNodes[i];
    s.x = Math.cos((i / simNodes.length) * Math.PI * 2) * 60;
    s.y = Math.sin((i / simNodes.length) * Math.PI * 2) * 60;
  }
  const N = simNodes.length;
  const linkDistance = N <= 8 ? 200 : N <= 30 ? 160 : 130;
  const repulsion = N <= 8 ? -700 : N <= 30 ? -450 : -300;
  const collideRadius = N <= 8 ? 95 : N <= 30 ? 80 : 70;
  const centerStrength = N <= 8 ? 0.04 : N <= 30 ? 0.08 : 0.12;
  const distanceMax = N <= 8 ? 1000 : N <= 30 ? 700 : 550;
  const ticks = N <= 30 ? 320 : 480;

  const linkInputs = flowEdges.map((e) => ({ source: e.source, target: e.target }));
  const sim = forceSimulation<SimNode>(simNodes)
    .force('link', forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(linkInputs)
      .id((d) => d.id)
      .distance(linkDistance)
      .strength(0.6))
    .force('charge', forceManyBody<SimNode>().strength(repulsion).distanceMax(distanceMax))
    .force('center', forceCenter(0, 0))
    .force('x', forceX<SimNode>(0).strength(centerStrength))
    .force('y', forceY<SimNode>(0).strength(centerStrength))
    .force('collide', forceCollide<SimNode>(collideRadius).iterations(2).strength(0.95))
    .stop();
  for (let i = 0; i < ticks; i++) sim.tick();

  const nodes: Node<TagNodeData>[] = simNodes.map((s) => ({
    id: s.id,
    type: 'tag',
    position: { x: s.x ?? 0, y: s.y ?? 0 },
    data: s.data,
  }));

  return {
    nodes,
    edges: flowEdges,
    internalCount: simNodes.length - externalCount - (selfAdded ? 1 : 0),
    externalCount,
    presentTags,
    presentEdgeKinds,
  };
}
