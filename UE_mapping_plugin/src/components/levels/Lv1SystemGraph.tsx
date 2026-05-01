import React, { useMemo, useEffect } from 'react';
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
import { summarize, nodeColor } from '../../utils/vaultIndex';
import type { VaultEdge } from '../../utils/frontmatter';
import { tagNodeTypes, type TagNodeData } from '../graph/TagNode';
import { L1ScanButton } from './L1ScanButton';
import { useT } from '../../utils/i18n';

interface Props {
  systemId: string;
}

export const Lv1SystemGraph: React.FC<Props> = ({ systemId }) => {
  const t = useT();
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
    () => summaries
      // System .md files (Systems/<id>.md) and the project-overview page are
      // aggregate intros, not graph members — exclude them so they don't
      // appear as orphan nodes.
      .filter((s) => s.nodeType !== 'System' && s.nodeType !== 'ProjectOverview')
      .filter((s) => {
        if (systemId === '_overview') return true;        // show every BP for the project map
        if (systemId === '_unassigned') return s.systems.length === 0;
        return s.systems.includes(systemId);
      }),
    [summaries, systemId],
  );

  const built = useMemo(() => buildGraph(inSystem, fileCache), [inSystem, fileCache]);

  const [nodes, setNodes, onNodesChange] = useNodesState<TagNodeData>(built.nodes);
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
        <p>
          {t({ en: 'No nodes tagged with', zh: '尚无节点带有标签' })}{' '}
          <code>system/{systemId}</code>{t({ en: ' yet.', zh: '。' })}
        </p>
      </div>
    );
  }

  // Legends only surface symbols that actually appear in the current graph,
  // so the header doesn't lie about types/colors that aren't visible.
  const presentEdgeTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of built.edges) {
      if (typeof e.data === 'object' && e.data && 'edgeType' in e.data) {
        set.add((e.data as { edgeType: string }).edgeType);
      }
    }
    return Array.from(set).sort();
  }, [built]);
  const presentNodeTypes = useMemo(() => {
    const set = new Set<string>();
    for (const n of inSystem) set.add(n.nodeType);
    return Array.from(set).sort();
  }, [inSystem]);

  return (
    <div className="system-graph">
      <div className="system-graph-header">
        <h2>{formatSystem(systemId)}</h2>
        <span className="muted">{t({ en: `${inSystem.length} nodes`, zh: `${inSystem.length} 个节点` })}</span>
        <L1ScanButton systemId={systemId} />
        {presentNodeTypes.length > 0 && (
          <div className="edge-legend" title={t({ en: 'Node colors', zh: '节点颜色' })}>
            {presentNodeTypes.map((nt) => (
              <span key={nt} className="edge-legend-item">
                <span
                  className="edge-legend-swatch edge-legend-swatch-node"
                  style={{ background: nodeColor(nt) }}
                />
                {nt}
              </span>
            ))}
          </div>
        )}
        {presentEdgeTypes.length > 0 && (
          <div className="edge-legend" title={t({ en: 'Edge colors', zh: '边颜色' })}>
            {presentEdgeTypes.map((et) => (
              <span key={et} className="edge-legend-item">
                <span className="edge-legend-swatch" style={{ background: edgeColor(et) }} />
                {et}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="system-graph-canvas">
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
            // AppShell dispatches lv2 to markdown- or graph-flavored renderer
            // based on the current viewMode — we only need to set the level.
            const path = n.data.relativePath as string | undefined;
            if (path) navigate({ level: 'lv2', relativePath: path, systemId }, n.data.label);
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
  if (id === '_overview') return 'Project Overview';
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
): { nodes: Node<TagNodeData>[]; edges: Edge[] } {
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

  // d3-force simulation — pre-converged. Parameters scale with node count so
  // small (3-8 node) and large (50+ node) graphs both converge to a readable
  // layout.  forceX/forceY anchor every node toward the origin so disconnected
  // components don't drift to infinity (forceCenter alone only moves the
  // centroid, not individual orphans).  forceManyBody.distanceMax caps the
  // long-range repulsion that otherwise pushes outliers off-canvas.
  const simNodes: SimNode[] = summaries.map((s, i) => ({
    id: s.relativePath,
    title: s.title,
    nodeType: s.nodeType,
    // Seed positions on a small circle so the simulation starts non-degenerate.
    x: Math.cos((i / summaries.length) * Math.PI * 2) * 50,
    y: Math.sin((i / summaries.length) * Math.PI * 2) * 50,
  }));
  const simLinks = rawEdges.map((e) => ({ source: e.source, target: e.target }));

  const N = simNodes.length;
  const linkDistance     = N <= 8 ? 220 : N <= 30 ? 180 : 150;
  const repulsion        = N <= 8 ? -800 : N <= 30 ? -500 : -350;
  const collideRadius    = N <= 8 ? 95  : N <= 30 ? 85  : 75;
  const centerStrength   = N <= 8 ? 0.04 : N <= 30 ? 0.08 : 0.12;
  const distanceMax      = N <= 8 ? 1200 : N <= 30 ? 800 : 600;
  const collideIters     = N <= 30 ? 2 : 3;
  const ticks            = N <= 30 ? 320 : 480;

  const sim = forceSimulation<SimNode>(simNodes)
    .force('link', forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(simLinks)
      .id((d) => d.id)
      .distance(linkDistance)
      .strength(0.6))
    .force('charge', forceManyBody<SimNode>().strength(repulsion).distanceMax(distanceMax))
    .force('center', forceCenter(0, 0))
    .force('x', forceX<SimNode>(0).strength(centerStrength))
    .force('y', forceY<SimNode>(0).strength(centerStrength))
    .force('collide', forceCollide<SimNode>(collideRadius).iterations(collideIters).strength(0.95))
    .stop();
  for (let i = 0; i < ticks; i++) sim.tick();

  const nodes: Node<TagNodeData>[] = simNodes.map((s) => ({
    id: s.id,
    type: 'tag',
    position: { x: s.x ?? 0, y: s.y ?? 0 },
    data: {
      label: s.title,
      tag: s.nodeType.toLowerCase(),
      color: nodeColor(s.nodeType),
      relativePath: s.id,
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
  // High-distinction palette — previous values used the same low-saturation
  // sepia profile (#8a*) for every type, so dense graphs with mixed edge
  // kinds looked monochromatic.  These hues line up with the node-type
  // tokens (function_call ↔ blueprint amber, cast ↔ cpp teal, etc.) so a
  // BP→BP function call stays in the warm-amber family while a cast hop
  // immediately reads as the cool teal that marks C++ classes.
  switch (edgeType) {
    case 'function_call':  return '#b8842f';   // amber
    case 'interface_call': return '#a8458a';   // plum
    case 'cast':           return '#2f6f88';   // teal
    case 'spawn':          return '#5b8c3f';   // forest green
    case 'listens_to':     return '#c75f3a';   // rust — distinct from amber
    case 'inheritance':    return '#6e5092';   // deep violet — distinct from plum
    default:               return '#888577';   // neutral gray for fallback
  }
}
