import React, { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useVaultStore } from '../../store/useVaultStore';
import {
  bridgeReadFunctionFlow,
  isFunctionFlowAvailable,
  type BridgeFunctionFlow,
  type BridgeFunctionFlowNode,
} from '../../services/bridgeApi';

interface Props {
  relativePath: string;
  functionId: string;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; flow: BridgeFunctionFlow };

export const Lv3FunctionFlow: React.FC<Props> = ({ relativePath, functionId }) => {
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  useEffect(() => {
    if (!file) loadFile(relativePath);
  }, [relativePath, file, loadFile]);

  const assetPath = (file?.frontmatter.asset_path as string | undefined);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!assetPath) return;
      if (!isFunctionFlowAvailable()) {
        setState({
          kind: 'error',
          message: 'Function-flow bridge method not bound — rebuild the AICartographer C++ plugin and relaunch UE.',
        });
        return;
      }
      setState({ kind: 'loading' });
      try {
        const flow = await bridgeReadFunctionFlow(assetPath, functionId);
        if (cancelled) return;
        setState({ kind: 'ready', flow });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    };
    run();
    return () => { cancelled = true; };
  }, [assetPath, functionId]);

  const built = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return buildReactFlow(state.flow.nodes, state.flow.edges);
  }, [state]);

  if (!file) {
    return <div className="empty-state"><p>Loading note…</p></div>;
  }
  if (!assetPath) {
    return (
      <div className="empty-state">
        <h2>No <code>asset_path</code></h2>
        <p className="muted">This vault file has no <code>asset_path</code> in its frontmatter, so the function graph cannot be located.</p>
      </div>
    );
  }
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div className="empty-state">
        <p className="muted">Loading function flow for <code>{functionId}</code>…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="empty-state">
        <h2>Function flow failed</h2>
        <p className="muted">{state.message}</p>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          Asset: <code>{assetPath}</code> · Function: <code>{functionId}</code>
        </p>
      </div>
    );
  }

  if (!built || built.nodes.length === 0) {
    return (
      <div className="empty-state">
        <h2>Function is empty</h2>
        <p className="muted">No nodes found in <code>{state.flow.graph_name}</code>.</p>
      </div>
    );
  }

  return (
    <div className="function-flow">
      <div className="function-flow-header">
        <div>
          <h2>{state.flow.function}</h2>
          <span className="muted">{state.flow.nodes.length} nodes · {state.flow.edges.length} edges</span>
        </div>
        <code className="muted">{relativePath}</code>
      </div>
      <div className="function-flow-canvas">
        <ReactFlow
          nodes={built.nodes}
          edges={built.edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable
          nodesConnectable={false}
          panOnDrag
          zoomOnScroll
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={32} color="#e2dfd4" />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
};

function buildReactFlow(
  rawNodes: BridgeFunctionFlowNode[],
  rawEdges: BridgeFunctionFlow['edges'],
): { nodes: Node[]; edges: Edge[] } {
  // UE node coords come straight from the editor — they're roughly in the
  // same coordinate space as ReactFlow, but each node spans ~280×120 in UE
  // and we want them tighter. Apply a uniform scale.
  const SCALE_X = 0.5;
  const SCALE_Y = 0.6;

  // Normalize so the leftmost node sits near x=0 (UE coordinates can be negative
  // and very large, which makes fitView awkward).
  let minX = Infinity, minY = Infinity;
  for (const n of rawNodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }

  const nodes: Node[] = rawNodes.map((n) => ({
    id: n.id,
    position: { x: (n.x - minX) * SCALE_X, y: (n.y - minY) * SCALE_Y },
    data: { label: renderLabel(n) },
    style: {
      background: kindColor(n.kind),
      color: '#fff',
      border: '1px solid var(--border-strong)',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 11,
      boxShadow: 'var(--shadow-sm)',
      minWidth: 140,
      maxWidth: 240,
    },
  }));

  const edges: Edge[] = rawEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: e.isExec,
    style: {
      stroke: e.isExec ? '#7a3030' : '#a39f8e',
      strokeWidth: e.isExec ? 2 : 1,
    },
  }));

  return { nodes, edges };
}

function renderLabel(n: BridgeFunctionFlowNode): string {
  if (n.kind === 'function_call' && n.target) return `Call ${n.target}`;
  if (n.kind === 'event' && n.target) return `Event ${n.target}`;
  if (n.kind === 'custom_event' && n.target) return `Custom ${n.target}`;
  return n.label;
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'event':
    case 'custom_event': return '#7a3030';
    case 'function_call': return '#5a6c8a';
    case 'K2Node_IfThenElse': return '#8a7556';
    case 'K2Node_DynamicCast': return '#6c8a4a';
    case 'K2Node_VariableGet':
    case 'K2Node_VariableSet': return '#8a6c4a';
    default: return '#6b6357';
  }
}
