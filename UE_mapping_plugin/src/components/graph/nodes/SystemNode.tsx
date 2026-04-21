import { memo, useState } from 'react';
import { Handle, Position } from 'reactflow';
import { useGraphStore } from '../../../store/useGraphStore';

const SystemNode = ({ id, data, selected = false }: any) => {
    const { description = data.id || '', isEditing = false, customHeader, isHeaderEditing = false } = data || {};
    const displayTitle = data.label || data.title || 'Unknown Asset';
    const updateNodeMeta = useGraphStore(state => state.updateNodeMeta);
    const nodeStatus = useGraphStore(state => state.nodeAnalysisStatus[id] || null);
    const [editValue, setEditValue] = useState(displayTitle);
    const [editHeaderValue, setEditHeaderValue] = useState(customHeader || 'BLUEPRINT');

    const handleSave = () => {
        updateNodeMeta(id, { label: editValue, isEditing: false });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSave();
        }
    };

    const handleHeaderSave = () => {
        updateNodeMeta(id, { customHeader: editHeaderValue, isHeaderEditing: false });
    };

    const handleHeaderKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleHeaderSave();
        }
    };

    return (
        <div className={`relative min-w-[280px] w-fit max-w-[420px] rounded-[28px] border-2 transition-all duration-300
            ${selected ? 'border-[#ff6600] shadow-[0_0_20px_rgba(255,102,0,0.4)] z-50 scale-105' : ''}
            ${nodeStatus === 'PROCESSING' ? 'border-[#ff6600] animate-pulse shadow-[0_0_20px_rgba(255,102,0,0.3)]' : ''}
            ${!selected && nodeStatus !== 'PROCESSING' ? 'border-[#333333] hover:border-[#555555]' : ''}`}>
          {/* Handles remain anchored to the top/bottom centers */}
          <Handle type="target" position={Position.Top} className="!bg-[#ff6600] !w-3 !h-3 !-top-1.5" />
          
          <div className="w-full rounded-[28px] overflow-hidden flex flex-col items-center bg-[#1a1a1a] shadow-2xl border border-[#333]">
            
            {/* Stratum 1: Centered Editable Header */}
            <div className="w-full px-8 pt-6 pb-2 flex justify-center">
              {isHeaderEditing ? (
                  <textarea
                    value={editHeaderValue}
                    onChange={(e) => setEditHeaderValue(e.target.value)}
                    onBlur={handleHeaderSave}
                    className="w-full text-center bg-transparent outline-none resize-none font-mono text-[10px] uppercase tracking-[0.2em] text-gray-500 !text-gray-500 appearance-none !caret-white overflow-hidden"
                    autoFocus
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      handleHeaderKeyDown(e);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                <div
                  className="w-full text-center font-mono text-[10px] uppercase tracking-[0.2em] text-gray-500 cursor-text select-none"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    updateNodeMeta(id, { isHeaderEditing: true });
                  }}
                >
                  {customHeader || 'BLUEPRINT'}
                </div>
              )}
            </div>

            {/* Stratum 2: Centered Core Title (Large Card Style) */}
            <div className="w-full px-8 pb-5 flex justify-center">
              {isEditing ? (
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleSave}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    handleKeyDown(e);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="w-full text-center bg-transparent outline-none resize-none text-xl font-bold !text-white whitespace-nowrap leading-tight tracking-tight appearance-none !caret-white overflow-hidden"
                  autoFocus
                />
              ) : (
                <h3 
                  className="w-full text-center text-xl font-bold text-white whitespace-nowrap truncate leading-tight tracking-tight cursor-pointer"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    updateNodeMeta(id, { isEditing: true });
                  }}
                >
                  {displayTitle}
                </h3>
              )}
            </div>

            {/* Status Tag */}
            {nodeStatus && (
              <div className="w-full px-8 pb-4 flex justify-center">
                <span className={`font-mono text-[8px] uppercase tracking-[0.15em] font-bold px-2 py-1 rounded
                  ${nodeStatus === 'COMPLETED' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : ''}
                  ${nodeStatus === 'FAILED' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : ''}
                `}>
                  {nodeStatus === 'COMPLETED' ? '[ ANALYZED ]' : nodeStatus === 'FAILED' ? '[ ERR_AST ]' : ''}
                </span>
              </div>
            )}

            {/* Stratum 3: Centered Interactive Groove (Progressive Disclosure) */}
            <div 
              className="group relative w-full bg-[#0d0d0d] px-8 py-4 border-t border-[#222] cursor-pointer hover:bg-[#121212] transition-colors flex flex-col items-center"
              title={description}
              onClick={(e) => {
                e.stopPropagation();
                console.log("View Details Triggered for:", data.assetPath || data.description);
                // Note: React Flow natively selects the node on click, which naturally opens the Sidebar.
              }}
            >
              {/* Centered Path Text */}
              <p className="flex-1 min-w-0 text-[10.5px] text-gray-400 font-mono truncate leading-relaxed">
                    {data.description || 'UNKNOWN PATH'}
                  </p>
              
              {/* Floating Centered Badge on Hover */}
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-[#0d0d0d]/80 pointer-events-none">
                <span className="text-[10px] text-[#ff6600] font-black tracking-[0.3em] uppercase">
                  VIEW DETAILS
                </span>
              </div>
            </div>

          </div>
          
          <Handle type="source" position={Position.Bottom} className="!bg-[#ff6600] !w-3 !h-3 !-bottom-1.5" />
        </div>
    );
};

export default memo(SystemNode);
