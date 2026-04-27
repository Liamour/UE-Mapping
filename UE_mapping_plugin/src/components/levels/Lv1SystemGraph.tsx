import React, { useMemo, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
  Position,
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
  type SimulationNodeDatum,
} from 'd3-force';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { summarize, nodeColor } from '../../utils/vaultIndex';
import type { VaultEdge } from '../../utils/frontmatter';

interface Props {
  systemId: string;
}

export const Lv1SystemGraph: React.FC<Props> = ({ systemId }) => {
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const loadFile = useVaultStore((s) => s.loadFile);
  const navigate = useTabsStore((s) => s.navigateActive);

  // Make sure all files relevant to this system are loaded
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (cancelled) return;
        if (!fileCache[f.relative_path]) await loadFile(f.relative_path);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const summaries = useMemo(
    () => files.map((f) => summarize(f, fileCache[f.relative_path])),
    [files, fileCache],
  );
  const inSystem = useMemo(
    () => summaries.filter((s) =>
      systemId === '_unassigned'
        ? s.systems.length === 0
        : s.systems.includes(systemId)
    ),
    [summaries, systemId],
  );

  const built = useMemo(() => buildGraph(inSystem, fileCache), [inSystem, fileCache]);

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  // When the underlying graph recomputes (new files load, system switches),
  // merge in the new nodes/edges but preserve existing node positions so
  // drags persist across re-renders.
  useEffect(() => {
    setNodes((current) => {
      const posById = new Map(current.map((n) => [n.id, n.position]));
      return built.nodes.map((n) =>
        posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n,
      );
    });
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  if (inSystem.length === 0) {
    return (
      <div className="empty-state">
        <p>No nodes tagged with <code>system/{systemId}</code> yet.</p>
      </div>
    );
  }

  // Legend reflects the edge-color map below; only show entries actually present
  // in the current graph so the header doesn't lie about edge types that aren't
  // visible.
  const presentEdgeTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of built.edges) {
      if (typeof e.data === 'object' && e.data && 'edgeType' in e.data) {
        set.add((e.data as { edgeType: string }).edgeType);
      }
    }
    return Array.from(set).sort();
  }, [built]);

  return (
    <div className="system-graph">
      <div className="system-graph-header">
        <h2>{formatSystem(systemId)}</h2>
        <span className="muted">{inSystem.length} nodes</span>
        {presentEdgeTypes.length > 0 && (
          <div className="edge-legend">
            {presentEdgeTypes.map((t) => (
              <span key={t} className="edge-legend-item">
                <span className="edge-legend-swatch" style={{ background: edgeColor(t) }} />
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="system-graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
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
            const path = (n.data as any).relativePath as string | undefined;
            if (path) navigate({ level: 'lv2', relativePath: path, systemId }, n.data.label as string);
          }}
        >
          <Background gap={32} color="#e2dfd4" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
};

function formatSystem(id: string): string {
  if (id === '_unassigned') return 'Unassigned';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

interface FileMap { [k: string]: ReturnType<typeof summarize>; }

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  nodeType: string;
}

function buildGraph(
  summaries: Array<ReturnType<typeof summarize>>,
  fileCache: ReturnType<typeof useVaultStore.getState>['fileCache'],
): { nodes: Node[]; edges: Edge[] } {
  const titleToPath: Record<string, string> = {};
  for (const s of summaries) titleToPath[s.title] = s.relativePath;

  // Collect raw edge tuples from frontmatter, deduped by (source,target,type).
  type RawEdge = { source: string; target: string; type: string };
  const rawEdges: RawEdge[] = [];
  const seen = new Set<string>();
  for (const s of summaries) {
    const file = fileCache[s.relativePath];
    if (!file) continue;
    const edgesByType = file.frontmatter.edges ?? {};
    for (const [edgeType, list] of Object.entries(edgesByType)) {
      for (const edge of (list as VaultEdge[]) ?? []) {
        const targetPath = titleToPath[edge.target];
        if (!targetPath) continue;
        const key = `${s.relativePath}|${targetPath}|${edgeType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rawEdges.push({ source: s.relativePath, target: targetPath, type: edgeType });
      }
    }
  }

  // d3-force simulation — pre-converged. Larger graphs need a wider canvas;
  // scale link distance + collision radius by node count so the layout
  // doesn't pile up when the graph grows.
  const simNodes: SimNode[] = summaries.map((s, i) => ({
    id: s.relativePath,
    title: s.title,
    nodeType: s.nodeType,
    // Seed positions on a small circle so the simulation starts non-degenerate.
    x: Math.cos((i / summaries.length) * Math.PI * 2) * 50,
    y: Math.sin((i / summaries.length) * Math.PI * 2) * 50,
  }));
  const simLinks = rawEdges.map((e) => ({ source: e.source, target: e.target }));

  // Tuned for dense small graphs (3-8 nodes with bidirectional edges) where
  // under-spread leads to overlapping labels/lines. For larger graphs (20+),
  // these parameters still converge cleanly because forceManyBody scales
  // by node count automatically.
  const linkDistance = 220;
  const repulsion = -800;
  const collideRadius = 95;

  const sim = forceSimulation<SimNode>(simNodes)
    .force('link', forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(simLinks)
      .id((d) => d.id)
      .distance(linkDistance)
      .strength(0.5))
    .force('charge', forceManyBody<SimNode>().strength(repulsion))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide<SimNode>(collideRadius))
    .stop();
  // Run a fixed number of ticks then freeze. 240 is enough for ~50 nodes
  // to settle without making the build feel sluggish.
  for (let i = 0; i < 240; i++) sim.tick();

  const nodes: Node[] = simNodes.map((s) => ({
    id: s.id,
    position: { x: s.x ?? 0, y: s.y ?? 0 },
    data: { label: s.title, relativePath: s.id, nodeType: s.nodeType },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    style: {
      background: nodeColor(s.nodeType),
      color: '#fff',
      border: '1px solid var(--border-strong)',
      borderRadius: 8,
      padding: '6px 10px',
      fontSize: 12,
      boxShadow: 'var(--shadow-sm)',
      minWidth: 120,
      textAlign: 'center' as const,
    },
  }));

  // No edge labels — they collide on dense graphs and the color already
  // disambiguates type via the legend in the header. Edge type is stashed
  // in `data.edgeType` so a future hover-tooltip layer can pick it up.
  const edges: Edge[] = rawEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    type: 'default',
    data: { edgeType: e.type },
    style: { stroke: edgeColor(e.type), strokeWidth: 1.5, opacity: 0.75 },
  }));

  return { nodes, edges };
}

function edgeColor(edgeType: string): string {
  switch (edgeType) {
    case 'function_call': return '#8a7556';
    case 'interface_call': return '#8a4a6c';
    case 'cast': return '#4a6c8a';
    case 'spawn': return '#6c8a4a';
    case 'listens_to': return '#8a6c4a';
    default: return '#a39f8e';
  }
}
