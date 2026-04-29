import React, { useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useVaultStore } from '../../store/useVaultStore';
import { useStaleStore } from '../../store/useStaleStore';
import {
  bridgeReadFunctionFlow,
  bridgeOpenInEditor,
  isFunctionFlowAvailable,
  isOpenInEditorAvailable,
  type BridgeFunctionFlow,
  type BridgeFunctionFlowNode,
} from '../../services/bridgeApi';
import { tagNodeTypes, type TagNodeData } from '../graph/TagNode';
import { useT } from '../../utils/i18n';

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
  const t = useT();
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const staleByPath = useStaleStore((s) => s.staleByPath);
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
          message: t({
            en: 'Function-flow bridge method not bound — rebuild the AICartographer C++ plugin and relaunch UE.',
            zh: '函数流桥接方法未绑定 — 请重新编译 AICartographer C++ 插件并重启 UE。',
          }),
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
    return <div className="empty-state"><p>{t({ en: 'Loading note…', zh: '正在加载笔记…' })}</p></div>;
  }
  if (!assetPath) {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'No', zh: '缺少' })} <code>asset_path</code></h2>
        <p className="muted">{t({
          en: 'This vault file has no asset_path in its frontmatter, so the function graph cannot be located.',
          zh: '该 vault 文件的 frontmatter 中没有 asset_path，无法定位函数图。',
        })}</p>
      </div>
    );
  }
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div className="empty-state">
        <p className="muted">
          {t({ en: 'Loading function flow for', zh: '正在加载函数流' })} <code>{functionId}</code>…
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'Function flow failed', zh: '函数流加载失败' })}</h2>
        <p className="muted">{state.message}</p>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {t({ en: 'Asset:', zh: '资产：' })} <code>{assetPath}</code> · {t({ en: 'Function:', zh: '函数：' })} <code>{functionId}</code>
        </p>
      </div>
    );
  }

  if (!built || built.nodes.length === 0) {
    return (
      <div className="empty-state">
        <h2>{t({ en: 'Function is empty', zh: '函数为空' })}</h2>
        <p className="muted">{t({ en: 'No nodes found in', zh: '未在以下图中找到任何节点：' })} <code>{state.flow.graph_name}</code>.</p>
      </div>
    );
  }

  // Build legends from kinds/edges actually present in this function so we
  // don't show a "K2Node_DynamicCast" swatch for a function that has no casts.
  const presentKinds = Array.from(new Set(state.flow.nodes.map((n) => n.kind))).sort();
  const hasExec = state.flow.edges.some((e) => e.isExec);
  const hasData = state.flow.edges.some((e) => !e.isExec);

  const canOpenInUE = isOpenInEditorAvailable();
  const onOpenInUE = async () => {
    if (!assetPath) return;
    try {
      await bridgeOpenInEditor(assetPath, functionId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[OpenInEditor]', e);
    }
  };

  return (
    <div className="function-flow">
      <div className="function-flow-header">
        <div>
          <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {state.flow.function}
            {!!assetPath && staleByPath.has(assetPath) && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 12px',
                  borderRadius: 14,
                  background: '#dc2626',
                  color: '#fff',
                  fontSize: 'var(--fs-sm)',
                  fontWeight: 700,
                  boxShadow: '0 1px 2px rgba(220, 38, 38, 0.4)',
                }}
                title={t({
                  en: 'This blueprint changed in the UE editor since last scan — function flow may be out of date, re-scan recommended',
                  zh: '自上次扫描以来此蓝图在 UE 编辑器中变更 — 函数流可能已过期，建议重扫',
                })}
              >
                {t({ en: '⚠ Changed in editor — rescan needed', zh: '⚠ 编辑器中已变更 — 需要重扫' })}
              </span>
            )}
          </h2>
          <span className="muted">
            {t({
              en: `${state.flow.nodes.length} nodes · ${state.flow.edges.length} edges`,
              zh: `${state.flow.nodes.length} 个节点 · ${state.flow.edges.length} 条边`,
            })}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {canOpenInUE && (
            <button
              className="btn-text"
              onClick={onOpenInUE}
              title={t({
                en: 'Open this function graph in the UE Blueprint editor',
                zh: '在 UE 蓝图编辑器中打开此函数图',
              })}
            >
              {t({ en: '↗ Open in UE', zh: '↗ 在 UE 中打开' })}
            </button>
          )}
          <code className="muted">{relativePath}</code>
        </div>
      </div>
      <div className="function-flow-legend">
        {presentKinds.map((k) => (
          <span key={k} className="edge-legend-item">
            <span className="edge-legend-swatch edge-legend-swatch-node" style={{ background: kindColor(k) }} />
            {kindLabel(k)}
          </span>
        ))}
        {(hasExec || hasData) && <span className="function-flow-legend-sep" />}
        {hasExec && (
          <span className="edge-legend-item">
            <span className="edge-legend-swatch edge-legend-swatch-line" style={{ background: '#7a3030' }} />
            {t({ en: 'exec flow', zh: '执行流' })}
          </span>
        )}
        {hasData && (
          <span className="edge-legend-item">
            <span className="edge-legend-swatch edge-legend-swatch-line" style={{ background: '#a39f8e' }} />
            {t({ en: 'data flow', zh: '数据流' })}
          </span>
        )}
      </div>
      <div className="function-flow-canvas">
        <ReactFlow
          nodes={built.nodes}
          edges={built.edges}
          nodeTypes={tagNodeTypes}
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
): { nodes: Node<TagNodeData>[]; edges: Edge[] } {
  // UE node coords come straight from the editor.  We bumped the scale from
  // 0.5/0.6 → 0.7/0.7 so nodes stay roomier inside ReactFlow's narrower
  // node-box dimensions, then run a post-pass to nudge any pair that still
  // overlaps (compiler-generated K2Nodes occasionally share coordinates).
  const SCALE_X = 0.7;
  const SCALE_Y = 0.7;
  const NODE_W  = 200;
  const NODE_H  = 60;

  let minX = Infinity, minY = Infinity;
  for (const n of rawNodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }

  const positioned = rawNodes.map((n) => ({
    raw: n,
    x: (n.x - minX) * SCALE_X,
    y: (n.y - minY) * SCALE_Y,
  }));

  // O(N²) collision relax: two passes are enough for typical function graphs
  // (≤ 60 nodes).  Anything overlapping gets pushed apart along the axis with
  // the tighter overlap so we don't shove a tightly-packed exec flow sideways.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i];
        const b = positioned[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = NODE_W - Math.abs(dx);
        const overlapY = NODE_H - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = (overlapX + 8) / 2;
            const sign = dx >= 0 ? 1 : -1;
            a.x -= sign * push;
            b.x += sign * push;
          } else {
            const push = (overlapY + 8) / 2;
            const sign = dy >= 0 ? 1 : -1;
            a.y -= sign * push;
            b.y += sign * push;
          }
        }
      }
    }
  }

  const nodes: Node<TagNodeData>[] = positioned.map((p) => ({
    id: p.raw.id,
    type: 'tag',
    position: { x: p.x, y: p.y },
    data: {
      label: renderLabel(p.raw),
      tag: kindLabel(p.raw.kind),
      color: kindColor(p.raw.kind),
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

// Human-readable labels for the node-kind legend. Falls back to the raw
// K2Node class name with the prefix stripped so unfamiliar nodes still read.
function kindLabel(kind: string): string {
  switch (kind) {
    case 'event': return 'event';
    case 'custom_event': return 'custom event';
    case 'function_call': return 'function call';
    case 'K2Node_IfThenElse': return 'branch';
    case 'K2Node_DynamicCast': return 'cast';
    case 'K2Node_VariableGet': return 'get var';
    case 'K2Node_VariableSet': return 'set var';
    default: return kind.startsWith('K2Node_') ? kind.slice('K2Node_'.length) : kind;
  }
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
