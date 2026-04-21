export type NodeType = 'Blueprint' | 'CPP';

export interface NodeData {
  title: string;
  type: NodeType;
  description: string; // Physical Asset Path from UE5, never overwritten by AI
  methods: string[];
  label?: string;
  tags?: string[];
  isEditing?: boolean;
  clusterId?: string;
  customHeader?: string;
  isHeaderEditing?: boolean;

  // Deep Scan State Machine Fields
  scanStatus?: 'idle' | 'scanning' | 'completed' | 'failed';
  analysisResult?: string; // AI decompilation result
  scanError?: string; // Error message if scan fails
}

export interface GraphPayload {
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data: NodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    animated?: boolean;
    label?: string;
  }>;
}
