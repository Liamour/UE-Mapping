import { memo, useState } from 'react';
import { NodeResizer } from 'reactflow';
import { useGraphStore } from '../../../store/useGraphStore';

const ClusterGroupNode = ({ id, data, selected = false }: any) => {
    const { title = '', label = title || '', isEditing = false } = data || {};
    const updateNodeMeta = useGraphStore(state => state.updateNodeMeta);
    const [editValue, setEditValue] = useState(label);

    const handleSave = () => {
        updateNodeMeta(id, { label: editValue, isEditing: false });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <>
            {/* The Resizer is injected outside the main div.
              It MUST ONLY be visible when 'selected' is true.
            */}
            <NodeResizer
                color="#ff6600"
                isVisible={selected}
                minWidth={400}
                minHeight={300}
                handleClassName="!bg-[#ff6600] !border-2 !border-black !w-3 !h-3 !rounded-[4px]"
                lineClassName="!border-[#ff6600] !opacity-30"
            />

            {/* CRITICAL CSS CHANGE: Changed to 'w-full h-full' so it stretches
              to the dimensions dictated by the NodeResizer.
            */}
            <div className="relative min-w-[400px] min-h-[300px] w-full h-full rounded-[32px] bg-[#111]/80 backdrop-blur-md border-2 border-[#ff6600]/30 shadow-2xl transition-all duration-100 flex flex-col items-center">
              
              {/* Stratum 1: The AI Group Header (Editable) */}
              <div className="w-full px-8 pt-6 pb-4 flex justify-center border-b border-[#333]">
                {isEditing ? (
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={handleKeyDown}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="w-full text-center bg-transparent outline-none resize-none font-bold text-xl uppercase tracking-wider text-[#ff6600] overflow-hidden"
                    autoFocus
                  />
                ) : (
                  <div
                    className="w-full text-center font-bold text-xl uppercase tracking-wider text-[#ff6600] cursor-text select-none"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      updateNodeMeta(id, { isEditing: true });
                    }}
                  >
                    {label || 'AI CLUSTER'}
                  </div>
                )}
              </div>

              {/* Stratum 2: The Playground (For Child Nodes) */}
              {/* Must use flex-1 to push the bottom and fill available height */}
              <div className="w-full h-full flex-1 p-8 relative">
                {/* Child nodes will float here. Keep empty. */}
              </div>
              
            </div>
        </>
    );
};

export default memo(ClusterGroupNode);
