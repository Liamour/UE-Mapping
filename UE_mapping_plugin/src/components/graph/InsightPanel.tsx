import React, { useState } from 'react';
import { useGraphStore } from '../../store/useGraphStore';

export const InsightPanel = () => {
  const { viewMode, currentBlueprintName, aiAnalysis, analysisStatus } = useGraphStore();
  const [isCollapsed, setIsCollapsed] = useState(false); // Collapsible state

  if (viewMode !== 'ast') return null;

  return (
    // Backdrop blur and opacity added. Width slightly reduced.
    <div className="absolute right-4 top-16 w-[300px] bg-[#050505]/85 backdrop-blur-md border border-[#333] shadow-2xl rounded-md flex flex-col z-50 transition-all duration-200">
      
      {/* HEADER - Clickable to toggle collapse */}
      <div 
        className="bg-[#ff6600] px-3 py-1.5 flex items-center justify-between cursor-pointer rounded-t-sm" 
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-black font-black text-[10px] uppercase tracking-widest">
            [ SYS_INSIGHT ]
          </span>
          {analysisStatus === 'analyzing' && <div className="w-1.5 h-1.5 rounded-full bg-black animate-ping" />}
        </div>
        <button className="text-black font-bold text-xs hover:text-white transition-colors">
          {isCollapsed ? '[+]' : '[-]'}
        </button>
      </div>

      {/* CONTENT - Hidden if collapsed */}
      {!isCollapsed && (
        // Added max-h-[60vh] and custom-scrollbar
        <div className="p-3 flex flex-col gap-3 font-mono max-h-[60vh] overflow-y-auto custom-scrollbar">
          
          <div className="border-b border-[#222] pb-2">
            <span className="text-[#666] text-[9px] uppercase">Target Entity</span>
            <p className="text-[#eee] text-xs font-bold truncate mt-0.5" title={currentBlueprintName || ''}>
              {currentBlueprintName}
            </p>
          </div>

          <div>
            <span className="text-[#666] text-[9px] uppercase">Semantic Summary</span>
            
            <div className="mt-1.5 text-[11px] text-[#ccc] leading-relaxed">
              {analysisStatus === 'idle' && (
                <span className="text-[#ff6600] animate-pulse">AWAITING AI INITIATION...</span>
              )}
              {analysisStatus === 'analyzing' && (
                <span className="text-[#aaa] animate-pulse">EXTRACTING SEMANTICS...</span>
              )}
              {analysisStatus === 'error' && (
                <span className="text-red-500 font-bold">{aiAnalysis}</span>
              )}
              {analysisStatus === 'success' && (
                // Used whitespace-pre-wrap to respect LLM markdown line breaks
                <div className="whitespace-pre-wrap">
                  {aiAnalysis}
                </div>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
};