import React from 'react'; 
import { useGraphStore } from '../../store/useGraphStore'; 

export const TacticalBreadcrumb = () => { 
  const { viewMode, currentBlueprintName, returnToGlobal } = useGraphStore(); 

  return ( 
    <div className="absolute top-4 left-4 z-50 flex items-center gap-2 bg-[#0a0a0a] border border-[#333] px-3 py-1.5 rounded-md shadow-lg font-mono text-xs uppercase tracking-widest"> 
      
      {/* GLOBAL NODE */} 
      <button 
        onClick={returnToGlobal} 
        className={`transition-colors duration-200 ${viewMode === 'global' ? 'text-[#ff6600] font-black' : 'text-[#666] hover:text-white cursor-pointer'}`} 
      > 
        [ L0_GLOBAL ] 
      </button> 

      {/* AST DRILL-DOWN NODE */} 
      {viewMode === 'ast' && ( 
        <> 
          <span className="text-[#333]">/</span> 
          <div className="flex items-center gap-2"> 
            <span className="text-[#ff6600] font-black">[ L1_AST :</span> 
            <span className="text-white truncate max-w-[200px]">{currentBlueprintName}</span> 
            <span className="text-[#ff6600] font-black">]</span> 
            <div className="w-1.5 h-1.5 bg-[#ff6600] rounded-full animate-pulse ml-1" /> 
          </div> 
        </> 
      )} 
    </div> 
  ); 
};