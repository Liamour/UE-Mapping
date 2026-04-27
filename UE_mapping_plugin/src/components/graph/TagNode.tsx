// Shared ReactFlow custom node renderer used by every force graph in the
// shell (Lv1 system graph, Lv2 blueprint internal graph, Lv3 function flow).
//
// Layout — a small "tag strip" sits above the node body so the type is
// readable at a glance even when the node is shrunk to fit dense layouts:
//
//     [event]            ← tagLabel   (small, uppercase, semi-transparent)
//     ┌──────────────┐
//     │ ReceiveExeAI │   ← label      (main name)
//     └──────────────┘
//
// Both Source and Target handles are rendered invisibly so ReactFlow can route
// edges; the visible body is driven by `data.color`, `data.label`, and
// `data.tag`.  No mouse interactions are added here — callers attach
// onNodeClick at the ReactFlow level instead.

import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface TagNodeData {
  label: string;
  tag: string;
  color: string;
  // Optional sub-label rendered under the main label in muted text — used by
  // L2 to show e.g. the parent class for a function node.
  subLabel?: string;
  // Free-form extra fields (relativePath, functionId, externalPath, …) that
  // the per-graph onNodeClick handlers read to drive navigation.  Stashed on
  // the data record itself so we don't have to thread a separate payload prop
  // through ReactFlow.
  [key: string]: unknown;
}

export const TagNode: React.FC<NodeProps<TagNodeData>> = ({ data }) => {
  return (
    <div className="tag-node">
      <div className="tag-node-tag">{data.tag}</div>
      <div className="tag-node-body" style={{ background: data.color }}>
        <div className="tag-node-label">{data.label}</div>
        {data.subLabel && <div className="tag-node-sublabel">{data.subLabel}</div>}
      </div>
      {/* Invisible handles — every edge connector points at the body center. */}
      <Handle type="target" position={Position.Left} className="tag-node-handle" />
      <Handle type="source" position={Position.Right} className="tag-node-handle" />
    </div>
  );
};

// Map ReactFlow nodeTypes to our custom node — pass this object to <ReactFlow nodeTypes={nodeTypes}>.
export const tagNodeTypes = { tag: TagNode };
