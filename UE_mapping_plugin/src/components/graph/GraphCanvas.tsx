import React, { useCallback, useEffect } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
} from 'reactflow';
import type {
  NodeTypes,
  OnSelectionChangeParams,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import SystemNode from './nodes/SystemNode';
import ClusterGroupNode from './nodes/ClusterGroupNode';
import { BlueprintNode } from './nodes/BlueprintNode';
import { TacticalBreadcrumb } from '../layout/TacticalBreadcrumb';
import { InsightPanel } from './InsightPanel';
import { useGraphStore } from '../../store/useGraphStore';
import type { NodeData } from '../../types/graph';

const nodeTypes: NodeTypes = {
  system: SystemNode,
  clusterGroup: ClusterGroupNode, // 新增：注册群组节点
  blueprintNode: BlueprintNode, // 注册蓝图拓扑节点
};

export const GraphCanvas: React.FC = () => {
  const { 
    nodes: storeNodes, 
    edges: storeEdges, 
    onNodesChange, 
    onEdgesChange, 
    onConnect, 
    setSelectedNode, 
    reparentNode,
    viewMode,
    globalNodes,
    globalEdges,
    astNodes,
    astEdges
  } = useGraphStore();
  const { getIntersectingNodes } = useReactFlow();

  // Dynamically select the raw data based on view mode
  const currentRawNodes = viewMode === 'global' ? globalNodes : astNodes;
  const currentRawEdges = viewMode === 'global' ? globalEdges : astEdges;

  // Auto-switch render data and apply layout based on view mode
  useEffect(() => {
    const { setNodes, setEdges } = useGraphStore.getState();
    const processLayout = async () => {
      if (currentRawNodes.length === 0) {
        setNodes([]);
        setEdges([]);
        return;
      }
      
      if (viewMode === 'global') {
        // Apply ELK.js auto-layout for the chaotic 55 global nodes
        const styledEdges = currentRawEdges.map(e => ({
          ...e,
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#ff6600', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#ff6600' },
        }));

        const layouted = await applyElkLayout(currentRawNodes, styledEdges);
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
      } else {
        // AST MODE: Respect the native Unreal Engine physics coordinates!
        // Do NOT run ELK. Just style the edges.
        const styledEdges = currentRawEdges.map(e => ({
          ...e,
          type: 'default', // UE blueprints use bezier/default lines
          animated: true,
          style: { stroke: '#ff6600', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#ff6600' },
        }));
        
        setNodes(currentRawNodes);
        setEdges(styledEdges);
      }
    };

    processLayout();
  }, [currentRawNodes, currentRawEdges, viewMode]);

  const onNodeClick = useCallback((event: any, node: any) => {
    if (node.type === 'clusterGroup') {
      setSelectedNode(null);
      return;
    }
    setSelectedNode(node);
  }, [setSelectedNode]);

  const onNodeDragStop = useCallback((event: React.MouseEvent, node: any) => {
    // 1. Skip if the dragged node is a cluster itself (prevent cluster-in-cluster for now)
    if (node.type === 'clusterGroup') return;

    // 2. Find what clusters the dragged node is currently hovering over
    const intersections = getIntersectingNodes(node);
    const targetCluster = intersections.find(n => n.type === 'clusterGroup');

    if (targetCluster) {
      // 3. Dropped ON a cluster.
      if (node.parentNode !== targetCluster.id) {
        // Calculate new relative position: Absolute Dragged Node Pos - Absolute Target Cluster Pos
        const newRelativeX = node.positionAbsolute!.x - targetCluster.positionAbsolute!.x;
        const newRelativeY = node.positionAbsolute!.y - targetCluster.positionAbsolute!.y;
        
        reparentNode(node.id, targetCluster.id, { x: newRelativeX, y: newRelativeY });
      }
    } else {
      // 4. Dropped on EMPTY CANVAS. Detach from parent.
      if (node.parentNode) {
        // The node's absolute position becomes its new actual position on the root canvas
        reparentNode(node.id, undefined, { x: node.positionAbsolute!.x, y: node.positionAbsolute!.y });
      }
    }
  }, [getIntersectingNodes, reparentNode]);

  const defaultEdgeOptions = {
    style: { stroke: '#555555', strokeWidth: 2 },
    animated: true,
  };

  if (!storeNodes || storeNodes.length === 0) {
    return (
        <div className="flex items-center justify-center w-full h-full text-slate-500 bg-slate-900 flex-col">
            <span className="text-xl font-bold mb-4">Awaiting Architecture Scan</span>
            <span className="text-sm">Click "扫描项目蓝图资产" to extract engine data.</span>
        </div>
    );
  }

  return (
    <div className="flex-1 w-full h-full relative min-h-[500px]">
      {/* TE Tactical Breadcrumb Navigator */}
      <TacticalBreadcrumb />
      {/* TE AI Insight Panel */}
      <InsightPanel />
      <ReactFlow
        nodes={storeNodes}
        edges={storeEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => setSelectedNode(null)}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        proOptions={{ hideAttribution: true }}
        defaultViewport={{ zoom: 0.8 }}
        minZoom={0.2}
        maxZoom={4}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="#333333" style={{ backgroundColor: '#0a0a0a' }} />
        
        {/* 暗黑版底部导航控件 */}
        <Controls
            style={{
                backgroundColor: '#1a1a1a',
                borderRadius: '12px',
                border: '1px solid #333333',
                overflow: 'hidden',
                fill: '#f5f5f5' // 控制图标颜色
            }}
        />
        
        {/* 暗黑版小地图 */}
        <MiniMap
            style={{
                backgroundColor: '#111111',
                border: '2px solid #333333',
                borderRadius: '16px'
            }}
            nodeColor={(node) => node.type === 'clusterGroup' ? 'transparent' : '#ff6600'}
            maskColor="rgba(0, 0, 0, 0.8)"
        />
      </ReactFlow>
    </div>
  );
};
