import { useGraphStore } from '../store/useGraphStore';
import { analyzeBlueprintAST } from './llmService';

// 1. Define the physical check function (async to handle UE CEF Promise wrapping)
const verifyBridgeIntegrity = async (): Promise<boolean> => {
  try {
    if (!window.ue || !window.ue.aicartographerbridge) return false;
    
    // Attempt the physical heartbeat ping
    // STRICT LOWERCASE for UE CEF execution, await the Promise from C++
    const status = await window.ue.aicartographerbridge.pingbridge();
    return status === "ONLINE";
  } catch (error) {
    return false; // Ghost object or missing function
  }
};

// 2. The Safe Executor Wrapper (async to handle UE CEF Promise wrapping)
export const executeUECommand = async <T>(commandName: string, ...args: any[]): Promise<T | null> => {
  // Await the integrity check result
  const isAlive = await verifyBridgeIntegrity();
  
  if (!isAlive) {
    console.error(`[SYS_ERR] RPC Bridge Offline. Dropping command: ${commandName}`);
    useGraphStore.getState().setBridgeStatus('offline');
    return null;
  }

  try {
    useGraphStore.getState().setBridgeStatus('online');
    // Dynamically call the strictly lowercase command
    const targetFunction = (window.ue.aicartographerbridge as any)[commandName.toLowerCase()];
    if (typeof targetFunction !== 'function') throw new Error("Function not mapped.");
    
    // Await the actual C++ function execution (handles both void and value returns)
    return await targetFunction(...args);
  } catch (error) {
    console.error(`[SYS_ERR] Command execution failed: ${commandName}`, error);
    useGraphStore.getState().setBridgeStatus('offline');
    return null;
  }
};

// Global listener for global scan results
(window as any).receiveGlobalNodes = (nodesData: any) => { 
    console.warn("===============================================");
    console.warn("[ARCHITECT_PROBE] FRONTEND RECEIVED ASSET DATA!");
    console.warn("Data Payload:", nodesData);
    console.warn("===============================================");
    
    // Update store with received graph data (global cache + render state)
    if (nodesData.nodes && nodesData.edges) {
        useGraphStore.getState().setGlobalGraph(nodesData.nodes, nodesData.edges);
    }
};

// Global listener for deep scan results
(window as any).receiveDeepScan = async (nodeId: string, astData: any) => { 
  console.warn("[ARCHITECT_PROBE] AST Data Received for Node:", nodeId); 
  
  if (!nodeId) { 
    console.error("Critical Error: nodeId missing from C++ callback."); 
    useGraphStore.getState().updateNodeMeta(nodeId, { scanStatus: 'failed', scanError: "Invalid node ID from backend" }); 
    return; 
  } 

  if (astData.status === "error") { 
    useGraphStore.getState().updateNodeMeta(nodeId, { scanStatus: 'failed', scanError: "Engine AST Extractor Failed" }); 
    return; 
  } 

  try { 
    // Parse AST if it's still a string (defensive check)
    const parsedAST = typeof astData === 'string' ? JSON.parse(astData) : astData;
    
    // 1. THE SCHEMATIC MAPPER: Transform C++ flat fields to React Flow format 
    const formattedNodes = (parsedAST.nodes || []).map((node: any) => ({ 
        id: node.id, 
        type: 'blueprintNode', // Ensure it uses our TE-Aesthetic component 
        // CRITICAL: Map the coordinates to prevent SVG NaN crashes 
        position: { 
            x: node.x || node.NodePosX || 0, 
            y: node.y || node.NodePosY || 0 
        }, 
        data: { 
            label: node.label || 'Unnamed Node', 
            pins: node.pins || [], 
        } 
    })); 

    // 2. Dispatch the formatted, safe data to the store 
    useGraphStore.getState().setAstGraph(nodeId, formattedNodes, parsedAST.edges || []); 
    
    // Automatically trigger AI Brain semantic analysis
    useGraphStore.getState().requestAiAnalysis(nodeId, formattedNodes);
    
    // Run LLM analysis for sidebar metadata (legacy for node tags)
    const aiResult = await analyzeBlueprintAST(parsedAST); 
    // Update node metadata for sidebar display
    useGraphStore.getState().updateNodeMeta(nodeId, { 
      scanStatus: 'completed', 
      analysisResult: aiResult.description, 
      tags: aiResult.tags 
    }); 
  } catch (error) { 
    useGraphStore.getState().updateNodeMeta(nodeId, { scanStatus: 'failed', scanError: "LLM Analysis Timeout" }); 
  } 
};

// 3. Refactored API calls using the executor (async)
export const requestDeepScan = async (nodeId: string, dirtyPath: string) => { 
  useGraphStore.getState().updateNodeMeta(nodeId, { scanStatus: 'scanning' }); 
  
  // 1. REGEX PURIFIER: Extract the pure path starting with /Game/ 
  // This strips out any "Blueprint None." or localized prefixes/suffixes 
  const pathMatch = dirtyPath.match(/(\/Game\/[^\s'"]+)/); 
  const cleanPath = pathMatch ? pathMatch[1] : dirtyPath; 

  console.warn(`[ARCHITECT_PROBE] Sanitized Path for Deep Scan: ${cleanPath}`);
  
  // Await the executor execution
  await executeUECommand("RequestDeepScan", nodeId, cleanPath); 
  
  // Note: We don't check for 'null' here to trigger the fallback UI immediately anymore,
  // because the executeUECommand already sets bridgeStatus='offline' globally,
  // which will trigger the TE-Aesthetic Red Alert in the Sidebar automatically.
};

// Request global graph data from UE (async)
export const requestGlobalGraph = async () => { 
  console.warn("[ARCHITECT_PROBE] Initiating Global Graph Scan..."); 
  
  // Use the proxy shield. It handles the lowercase conversion internally. 
  const result = await executeUECommand<string>("RequestGraphData"); 

  if (result) { 
    console.warn("[ARCHITECT_PROBE] Global Graph Data Received!", result); 
    try {
      const data = JSON.parse(result);
      (window as any).receiveGlobalNodes(data);
    } catch (e) {
      console.error("Failed to parse global graph data:", e);
    }
  } else { 
    console.error("[ARCHITECT_PROBE] Global Scan Failed or Bridge Offline."); 
  } 
};
