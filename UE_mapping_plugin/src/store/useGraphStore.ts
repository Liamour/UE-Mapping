import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
} from 'reactflow';
import type {
  NodeChange,
  EdgeChange,
  Connection,
  Edge,
  Node,
} from 'reactflow';
import type { NodeData } from '../types/graph';
import { checkHealth, submitBatchScan, pollTaskStatus, type TaskStatusResponse } from "../services/llmService";

interface GraphState {
  // View State
  viewMode: 'global' | 'ast';
  currentBlueprintName: string | null;

  // Data Caches
  globalNodes: Node<NodeData>[];
  globalEdges: Edge[];
  astNodes: Node<NodeData>[];
  astEdges: Edge[];

  // Original Render Data
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedNode: Node<NodeData> | null;
  bridgeStatus: 'online' | 'offline';

  // AI Analysis State
  aiAnalysis: string | null;
  analysisStatus: 'idle' | 'analyzing' | 'success' | 'error';

  // Batch Scan State
  isRedisAvailable: boolean;
  batchScanTaskId: string | null;
  batchScanStatus: 'IDLE' | 'PROCESSING' | 'COMPLETED';
  nodeAnalysisStatus: Record<string, 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'>;
  privateBatchPollInterval: NodeJS.Timeout | null;

  // Original Methods
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setSelectedNode: (node: Node<NodeData> | null) => void;
  setNodes: (nodes: Node<NodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setBridgeStatus: (status: 'online' | 'offline') => void;
  applyClusters: (clusters: any[]) => void;
  updateNodeMeta: (nodeId: string, metaPayload: Partial<NodeData>) => void;
  addNodeTag: (nodeId: string, tag: string) => void;
  removeNodeTag: (nodeId: string, tag: string) => void;
  reparentNode: (nodeId: string, newParentId: string | undefined, newRelativePosition: { x: number, y: number }) => void;

  // New Wormhole Methods
  setGlobalGraph: (nodes: Node<NodeData>[], edges: Edge[]) => void;
  setAstGraph: (bpName: string, nodes: Node<NodeData>[], edges: Edge[]) => void;
  returnToGlobal: () => void;

  // AI Analysis Methods
  requestAiAnalysis: (bpName: string, astData: any) => Promise<void>;

  // Batch Scan Methods
  initHealthCheck: () => Promise<void>;
  startGlobalScan: () => Promise<void>;
  updateNodeStatus: (statusData: TaskStatusResponse) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  // New View State
  viewMode: 'global',
  currentBlueprintName: null,

  // New Data Caches
  globalNodes: [],
  globalEdges: [],
  astNodes: [],
  astEdges: [],

  // Original State
  nodes: [],
  edges: [],
  selectedNode: null,
  bridgeStatus: 'online',
  setBridgeStatus: (status) => set({ bridgeStatus: status }),

  // AI Analysis State
  aiAnalysis: null,
  analysisStatus: 'idle',

  // Batch Scan Initial State
  isRedisAvailable: false,
  batchScanTaskId: null,
  batchScanStatus: 'IDLE',
  nodeAnalysisStatus: {},
  privateBatchPollInterval: null,

  // New Method Implementations
  setGlobalGraph: (nodes, edges) => set({
    globalNodes: nodes,
    globalEdges: edges,
    nodes: nodes,
    edges: edges,
    viewMode: 'global',
    currentBlueprintName: null,
    // Reset AI analysis when returning to global
    aiAnalysis: null,
    analysisStatus: 'idle'
  }),

  setAstGraph: (bpName: string, nodes: Node<NodeData>[], edges: Edge[]) => set({
    astNodes: nodes,
    astEdges: edges,
    nodes: nodes,
    edges: edges,
    viewMode: 'ast',
    currentBlueprintName: bpName,
    // Reset AI analysis when entering new blueprint
    aiAnalysis: null,
    analysisStatus: 'idle'
  }),

  returnToGlobal: () => set((state) => ({
    viewMode: 'global',
    currentBlueprintName: null,
    nodes: state.globalNodes,
    edges: state.globalEdges,
    // Reset AI analysis when returning to global
    aiAnalysis: null,
    analysisStatus: 'idle'
  })),

  // AI Analysis Implementation
  requestAiAnalysis: async (bpName, astData) => {
    set({ analysisStatus: 'analyzing', aiAnalysis: null });
    try {
      // Replace with your actual backend API endpoint
      const response = await fetch('http://localhost:8000/api/analyze-blueprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: bpName, ast: astData })
      });
      
      if (!response.ok) throw new Error('AI Engine unreachable');
      
      const data = await response.json();
      set({ analysisStatus: 'success', aiAnalysis: data.summary });
    } catch (error) {
      console.error("[SYS_ERR] AI Analysis Failed:", error);
      set({ analysisStatus: 'error', aiAnalysis: 'CONNECTION_SEVERED: Unable to reach AI Brain.' });
    }
  },

  // Batch Scan Implementation
  initHealthCheck: async () => {
    const redisAvailable = await checkHealth();
    set({ isRedisAvailable: redisAvailable });
  },

  startGlobalScan: async () => {
    const state = useGraphStore.getState();
    if (!state.isRedisAvailable || state.batchScanStatus === 'PROCESSING') return;

    try {
      const scanNodes = state.globalNodes
        .filter(node => node.data && node.data.assetPath)
        .map(node => ({
          node_id: node.id,
          asset_path: node.data.assetPath,
          ast_data: node.data.ast || null
        }));

      if (scanNodes.length === 0) return;

      const taskId = await submitBatchScan(scanNodes);

      // Initialize node statuses as PENDING
      const initialNodeStatus: Record<string, 'PENDING'> = {};
      scanNodes.forEach(node => {
        initialNodeStatus[node.node_id] = 'PENDING';
      });

      set({
        batchScanTaskId: taskId,
        batchScanStatus: 'PROCESSING',
        nodeAnalysisStatus: initialNodeStatus
      });

      // Start polling interval (2000ms)
      const interval = setInterval(async () => {
        const currentState = useGraphStore.getState();
        if (!currentState.batchScanTaskId || currentState.batchScanStatus !== 'PROCESSING') {
          clearInterval(interval);
          return;
        }

        try {
          const status = await pollTaskStatus(currentState.batchScanTaskId);
          currentState.updateNodeStatus(status);
        } catch (error) {
          console.error("[SYS_ERR] Poll failed:", error);
        }
      }, 2000);

      set({ privateBatchPollInterval: interval });

    } catch (error) {
      console.error("[SYS_ERR] Batch scan failed:", error);
      set({ batchScanStatus: 'IDLE' });
    }
  },

  updateNodeStatus: (statusData: TaskStatusResponse) => {
    const state = useGraphStore.getState();

    if (statusData.status === 'COMPLETED' || statusData.status === 'FAILED' || statusData.status === 'PARTIAL_FAIL') {
      // Clear polling interval
      if (state.privateBatchPollInterval) {
        clearInterval(state.privateBatchPollInterval);
      }

      // Mark all remaining pending nodes as COMPLETED/FAILED based on status
      const updatedStatus = { ...state.nodeAnalysisStatus };
      Object.keys(updatedStatus).forEach(nodeId => {
        if (updatedStatus[nodeId] === 'PENDING') {
          updatedStatus[nodeId] = statusData.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
        }
      });

      set({
        batchScanStatus: 'COMPLETED',
        nodeAnalysisStatus: updatedStatus,
        privateBatchPollInterval: null
      });

      return;
    }

    // Update progress for processing state
    const updatedStatus = { ...state.nodeAnalysisStatus };
    // For simplicity, assume completed nodes are marked as completed
    // In a real implementation you would get per-node status from backend
    Object.keys(updatedStatus).forEach((nodeId, index) => {
      if (index < statusData.completed_nodes && updatedStatus[nodeId] === 'PENDING') {
        updatedStatus[nodeId] = 'COMPLETED';
      }
    });

    set({ nodeAnalysisStatus: updatedStatus });
  },

  // Original Methods Preserved
  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
    })),

  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    })),

  onConnect: (connection) =>
    set((state) => ({
      edges: [...state.edges, { ...connection, id: `${Date.now()}` }],
    })),

  setSelectedNode: (node) => set({ selectedNode: node }),

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  applyClusters: (clusters) => set((state) => {
    const newNodes = [...state.nodes];
    const groupNodes: any[] = [];

    let currentY = 0; // 全局纵向游标

    clusters.forEach((cluster) => {
        // 1. 创建父节点 (Group)
        const groupId = `group_${cluster.id}`;
        
        // 简单计算父容器需要多大：每排 3 个节点，每个节点假设宽 250 高 150
        const rows = Math.ceil(cluster.nodeIds.length / 3);
        const groupHeight = Math.max(300, rows * 180 + 100);

        groupNodes.push({
            id: groupId,
            type: 'clusterGroup',
            position: { x: 0, y: currentY },
            data: { title: cluster.label, description: cluster.description },
            style: { width: 850, height: groupHeight }, // 强制尺寸以容纳子节点
            zIndex: -1, // 确保它在子节点的底层
        });

        // 2. 将关联的物理节点收容进父节点
        let childX = 30;
        let childY = 80; // 避开顶部的标题栏

        cluster.nodeIds.forEach((nodeId: string) => {
            const nodeIndex = newNodes.findIndex(n => n.id === nodeId);
            if (nodeIndex !== -1) {
                newNodes[nodeIndex] = {
                    ...newNodes[nodeIndex],
                    parentNode: groupId,    // 核心 API：认父
                    position: { x: childX, y: childY } // 局部坐标系
                };

                // 局部网格步进
                childX += 270;
                if (childX > 600) {
                    childX = 30;
                    childY += 150;
                }
            }
        });

        currentY += groupHeight + 100; // 为下一个群组预留间距
    });

    return { nodes: [...groupNodes, ...newNodes] };
  }),

  updateNodeMeta: (nodeId, metaPayload) => set((state) => ({
    nodes: state.nodes.map(node => 
      node.id === nodeId 
        ? { ...node, data: { ...node.data, ...metaPayload } }
        : node
    )
  })),

  addNodeTag: (nodeId, tag) => set((state) => ({
    nodes: state.nodes.map(node => 
      node.id === nodeId 
        ? { 
            ...node, 
            data: { 
              ...node.data, 
              tags: [...new Set([...(node.data.tags || []), tag])] 
            } 
          }
        : node
    )
  })),

  removeNodeTag: (nodeId, tag) => set((state) => ({
    nodes: state.nodes.map(node => 
      node.id === nodeId 
        ? { 
            ...node, 
            data: { 
              ...node.data, 
              tags: (node.data.tags || []).filter(t => t !== tag) 
            } 
          }
        : node
    )
  })),

  reparentNode: (nodeId, newParentId, newRelativePosition) => set((state) => ({
    nodes: state.nodes.map((node) => {
      if (node.id === nodeId) {
        // Create a new node object to trigger React reactivity
        return {
          ...node,
          parentNode: newParentId,
          position: newRelativePosition,
          extent: undefined,
        };
      }
      return node;
    })
  })),
}));
