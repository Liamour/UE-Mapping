import React, { useState, useRef, useEffect } from 'react';
import { useGraphStore } from '../../store/useGraphStore';
import { Code, FileCode, List, FileText, Send } from 'lucide-react';
import type { NodeType } from '../../types/graph';
import { analyzeArchitecture, chatWithModule } from '../../services/llmService';
import { requestDeepScan, requestGlobalGraph } from '../../services/engineBridge';
import { downloadJson } from '../../utils/exportUtils';

const typeIcons = {
  Blueprint: <FileCode size={18} className="text-cyan-400" />,
  CPP: <Code size={18} className="text-purple-400" />,
};

const typeColors = {
  Blueprint: 'text-cyan-400 border-cyan-500/30 bg-cyan-950/30',
  CPP: 'text-purple-400 border-purple-500/30 bg-purple-950/30',
};

export const Sidebar: React.FC = () => {
  const { nodes, edges, selectedNode, bridgeStatus, isRedisAvailable, batchScanStatus, startGlobalScan } = useGraphStore();

  const getDependencies = () => {
    if (!selectedNode) return { incoming: [], outgoing: [] };
    
    const incoming = edges
      .filter((e: any) => e.target === selectedNode.id)
      .map((e: any) => nodes.find((n: any) => n.id === e.source)?.data?.title || e.source);
        
    const outgoing = edges
      .filter((e: any) => e.source === selectedNode.id)
      .map((e: any) => nodes.find((n: any) => n.id === e.target)?.data?.title || e.target);

    return { incoming, outgoing };
  };

  const deps = getDependencies();

  // 聊天功能状态
  const [chatMode, setChatMode] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLog, setChatLog] = useState<{role: string, content: string}[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部效果
  useEffect(() => {
      if (chatScrollRef.current) {
          chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
  }, [chatLog]);

  // 重置聊天状态 (当切换选中节点时)
  useEffect(() => {
      setChatMode(false);
      setChatLog([]);
  }, [selectedNode]);

  // 对话提交处理逻辑
  const handleSendMessage = async () => {
      if (!chatInput.trim() || !apiKey || !endpointId || !selectedNode) return;
      
      const userMsg = chatInput;
      setChatLog(prev => [...prev, { role: 'user', content: userMsg }]);
      setChatInput('');
      setIsChatting(true);

      try {
          const deps = getDependencies();
          const reply = await chatWithModule(
              selectedNode.data?.title || selectedNode.id,
              deps.incoming,
              deps.outgoing,
              userMsg,
              apiKey,
              endpointId,
              baseURL
          );
          setChatLog(prev => [...prev, { role: 'ai', content: reply }]);
      } catch (error: any) {
          setChatLog(prev => [...prev, { role: 'system', content: `❌ Error: ${error.message}` }]);
      } finally {
          setIsChatting(false);
      }
  };

  // 回车键发送
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // 全量导出
  const handleExportFullGraph = () => {
    const { nodes, edges } = useGraphStore.getState();
    if (nodes.length === 0) return alert("No architecture data to export.");
    downloadJson({ nodes, edges }, 'UE_Architecture_Full.json');
  };

  // 单节点精准导出
  const handleExportSingleNode = () => {
    if (!selectedNode) return;
    const deps = getDependencies();
    const exportData = {
        targetAsset: selectedNode.data?.title || selectedNode.id,
        type: selectedNode.data?.type || 'Blueprint',
        packagePath: selectedNode.data?.description || '',
        incomingDependencies: deps.incoming,
        outgoingDependencies: deps.outgoing,
        rawNodeData: selectedNode
    };
    downloadJson(exportData, `UE_Node_${selectedNode.data?.title || selectedNode.id}.json`);
  };

  // 火山引擎 LLM 配置状态
    const [apiKey, setApiKey] = useState(localStorage.getItem('volc_api_key') || '');
    const [endpointId, setEndpointId] = useState(localStorage.getItem('volc_endpoint_id') || '');
    const [baseURL, setBaseURL] = useState(localStorage.getItem('volc_base_url') || 'https://ark.cn-beijing.volces.com/api/v3');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [statusMsg, setStatusMsg] = useState("");

  // 火山引擎 AI 架构分析处理
  const handleAIAnalysis = async () => {
    const { nodes, edges } = useGraphStore.getState();
    if (!nodes.length) {
        setStatusMsg("❌ Error: Please scan architecture first.");
        return alert("Please scan architecture first.");
    }
    if (!apiKey) {
        setStatusMsg("❌ Error: Please enter Volcengine API Key.");
        return alert("Please enter Volcengine API Key.");
    }
    if (!endpointId) {
        setStatusMsg("❌ Error: Please enter Volcengine Endpoint ID (ep-xxx).");
        return alert("Please enter Volcengine Endpoint ID (ep-xxx).");
    }

    localStorage.setItem('volc_api_key', apiKey);
    localStorage.setItem('volc_endpoint_id', endpointId);
    localStorage.setItem('volc_base_url', baseURL);

    setStatusMsg("Step 1: Preparing payload...");
    setIsAnalyzing(true);
    try {
        setStatusMsg("Step 2: Sending request to Vite Proxy...");
        const result = await analyzeArchitecture(nodes, edges, apiKey, endpointId, baseURL);
        console.log("AI Architect Result:", result);
        
        setStatusMsg("Step 3: Applying dimensional folding...");
        // 触发维度折叠与矩阵重排
        useGraphStore.getState().applyClusters(result.clusters);
        
        setStatusMsg("✅ Analysis Complete!");
        alert(`Semantic Clustering Complete! Reshaping ${result.clusters.length} Sub-systems.`);
    } catch (error: any) {
        setStatusMsg(`❌ Error: ${error.message}`);
        console.error("====== LLM FATAL ERROR ======");
        console.error(error);
        console.error("=============================");
        alert(`Analysis Failed! Open DevTools (F12) to see details. Error: ${error.message}`);
    } finally {
        setIsAnalyzing(false);
    }
  };

  const handleScanArchitecture = async () => {
    try {
        console.log("Initiating Global Asset Scan...");
        // Use our new RPC Shield protected function (handles all async, error checking, bridge status)
        await requestGlobalGraph();
    } catch (error: any) {
        console.error("Scan Pipeline Crashed:", error.message);
    }
  };

  return (
    <div className="w-[320px] h-full bg-[#0a0a0a] border-l border-[#222222] flex flex-col text-[#f5f5f5] overflow-y-auto custom-scrollbar">
      <div className="p-4 border-b border-slate-800">
        {bridgeStatus === 'offline' && (
          <div className="mb-4 p-2 bg-black border-2 border-[#ff3300] rounded-md">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-[#ff3300] animate-ping rounded-full" />
              <span className="text-[#ff3300] font-mono text-[10px] font-black tracking-widest uppercase">
                [ SYS_ERR: RPC LINK SEVERED ]
              </span>
            </div>
            <p className="mt-1 text-[#666] font-mono text-[9px] uppercase tracking-wider">
              V8 Context Lost. Restart UI Tab to re-initialize bridge.
            </p>
          </div>
        )}
        <h2 className="text-lg font-semibold text-slate-100">Node Details</h2>
        <button
          onClick={async () => {
            try {
              // 架构师级嗅探：同时兼容新旧版本引擎的注入路径
              const bridge = window.cartographerbridge || window.ue?.cartographerbridge;

              if (!bridge) {
                  console.error("ERROR: Bridge missing. Window keys:", Object.keys(window).filter(k => k.includes('cartographer') || k === 'ue'));
                  return;
              }

              // 尝试调用 (适配可能的 UE 内部首字母小写化)
              if (typeof bridge.SendLogToUE === 'function') {
                  bridge.SendLogToUE("Ping from React! (PascalCase)");
              } else if (typeof (bridge as any).sendLogToUE === 'function') {
                  (bridge as any).sendLogToUE("Ping from React! (camelCase)");
              } else if (typeof (bridge as any).sendlogtoue === 'function') {
                  (bridge as any).sendlogtoue("Ping from React! (lowercase)");
              } else {
                  console.error("Bridge exists, but function SendLogToUE is missing! Methods:", Object.keys(bridge));
              }

              // 请求UE数据
              if (bridge) {
                const mockDataString = await bridge.RequestGraphData();
                console.log("Received from UE:", JSON.parse(mockDataString));
              }

            } catch (error: any) {
         console.error("====== LLM FATAL ERROR ======");
         console.error(error);
         console.error("=============================");
         alert(`Analysis Failed! Open DevTools (F12) to see details. Error: ${error.message}`);
     } finally {
         setIsAnalyzing(false);
     }
          }}
          className="w-full bg-gradient-to-b from-[#3a3a3a] to-[#222222] text-white font-black uppercase tracking-widest py-3.5 px-4 rounded-2xl transition-all duration-75 shadow-[0_6px_0_0_#1a1a1a,0_8px_15px_rgba(0,0,0,0.5)] hover:shadow-[0_4px_0_0_#1a1a1a,0_5px_10px_rgba(0,0,0,0.5)] hover:translate-y-[2px] active:shadow-[0_0_0_0_#1a1a1a] active:translate-y-[6px] border border-[#555555]/40 flex items-center justify-center gap-2 mt-3"
        >
          Ping UE RPC Bridge
        </button>
        <button
          onClick={handleScanArchitecture}
          className="w-full bg-gradient-to-b from-[#ff7711] to-[#e65c00] text-[#0a0a0a] font-black uppercase tracking-widest py-3.5 px-4 rounded-2xl transition-all duration-75 shadow-[0_6px_0_0_#b34700,0_8px_15px_rgba(0,0,0,0.5)] hover:shadow-[0_4px_0_0_#b34700,0_5px_10px_rgba(0,0,0,0.5)] hover:translate-y-[2px] active:shadow-[0_0_0_0_#b34700] active:translate-y-[6px] border border-[#ff9955]/40 flex items-center justify-center gap-2 mt-2"
        >
          扫描项目蓝图资产
        </button>

        <div className="mt-6 border-t border-slate-700 pt-4">
            <h3 className="text-sm font-bold text-blue-400 mb-2">Volcengine AI Clustering</h3>
            <input
                type="password" placeholder="API Key"
                value={apiKey} onChange={e => setApiKey(e.target.value)}
                className="w-full bg-[#111111] text-[#f5f5f5] p-3 rounded-xl border border-[#2a2a2a] focus:border-[#ff6600] focus:ring-1 focus:ring-[#ff6600]/50 focus:outline-none font-mono text-xs mb-3 transition-all duration-200"
            />
            <input
                type="text" placeholder="Endpoint ID (e.g., ep-2024...)"
                value={endpointId} onChange={e => setEndpointId(e.target.value)}
                className="w-full bg-[#111111] text-[#f5f5f5] p-3 rounded-xl border border-[#2a2a2a] focus:border-[#ff6600] focus:ring-1 focus:ring-[#ff6600]/50 focus:outline-none font-mono text-xs mb-3 transition-all duration-200"
            />
            <input
                type="text" placeholder="Base URL"
                value={baseURL} onChange={e => setBaseURL(e.target.value)}
                className="w-full bg-[#111111] text-[#f5f5f5] p-3 rounded-xl border border-[#2a2a2a] focus:border-[#ff6600] focus:ring-1 focus:ring-[#ff6600]/50 focus:outline-none font-mono text-xs mb-3 transition-all duration-200"
            />
            <button 
                onClick={() => startGlobalScan()} 
                disabled={!isRedisAvailable || batchScanStatus === 'PROCESSING'} 
                className={`w-full font-black uppercase tracking-widest py-3.5 px-4 rounded-2xl transition-all duration-75 border ${ 
                    !isRedisAvailable || batchScanStatus === 'PROCESSING' 
                        ? 'bg-[#333333] border-[#444444]/50 text-[#888888] cursor-not-allowed' 
                        : 'bg-gradient-to-b from-[#ff7711] to-[#e65c00] text-[#0a0a0a] shadow-[0_6px_0_0_#b34700,0_8px_15px_rgba(0,0,0,0.5)] hover:shadow-[0_4px_0_0_#b34700,0_5px_10px_rgba(0,0,0,0.5)] hover:translate-y-[2px] active:shadow-[0_0_0_0_#b34700] active:translate-y-[6px] border-[#ff9955]/40' 
                } flex items-center justify-center gap-2`} 
            > 
                {!isRedisAvailable 
                    ? '[ REDIS OFFLINE ] BATCH MODE DISABLED' 
                    : batchScanStatus === 'PROCESSING' 
                        ? '[ PROCESSING ] GLOBAL ANALYSIS RUNNING' 
                        : '[ TACTICAL TRIGGER ] GLOBAL BATCH ANALYSIS' 
                } 
            </button>
            <div className="mt-2 text-xs font-mono text-yellow-400 break-words">{statusMsg}</div>
            <button 
                onClick={handleExportFullGraph} 
                className="w-full mt-2 bg-[#222222] hover:bg-[#333333] text-[#f5f5f5] font-bold uppercase tracking-wider py-2 rounded-xl transition-all duration-200 border border-[#444444] hover:border-[#888888] flex items-center justify-center gap-2 shadow-[0_4px_0_0_#111] hover:translate-y-[2px] hover:shadow-[0_2px_0_0_#111] active:translate-y-[4px] active:shadow-none" 
            > 
                [+] Export Full JSON 
            </button>
        </div>
      </div>

      <div className="p-4 flex-1">
        {!selectedNode ? (
          <div className="flex flex-col items-center justify-center text-center p-8 text-[#666666]">
            <FileText size={48} className="mb-3 opacity-50" />
            <p className="text-sm">Select a system node to view details</p>
          </div>
        ) : (
          <>
            <div className="mb-6 bg-[#151515] p-5 rounded-3xl border border-[#2a2a2a] shadow-lg flex flex-col gap-4">
                <div>
                    <div className="inline-block px-3 py-1 bg-[#222222] text-white text-[10px] font-bold uppercase tracking-wider rounded-lg border border-[#333333] mb-3">
                        {selectedNode.data?.type || 'Blueprint'}
                    </div>
                    <h2 className="text-xl font-black text-white tracking-wide break-words leading-tight">
                        {selectedNode.data?.title || selectedNode.id}
                    </h2>
                </div>
                
                <div className="bg-[#050505] p-3.5 rounded-2xl border-t-2 border-t-[#000000] border-b border-b-[#2a2a2a] border-l border-l-[#0a0a0a] border-r border-r-[#0a0a0a] shadow-[inset_0_4px_10px_rgba(0,0,0,0.8)]">
                    <span className="block text-[10px] text-[#666666] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 bg-white rounded-full"></div> Package Path
                    </span>
                    <span className="text-xs text-[#b3b3b3] font-mono break-all leading-relaxed">
                        {selectedNode.data?.description || 'No path available'}
                    </span>
                </div>
            </div>

            {/* Groove Container */}
            <div className="mb-6 bg-[#0a0a0a] rounded-xl shadow-[inset_0_2px_8px_rgba(0,0,0,0.8)] border border-[#151515] p-4">
                <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wider text-xs">
                    Node Metadata
                </h4>

                {/* Description Section */}
                <div className="mb-4">
                    <span className="block text-[10px] text-[#666666] font-bold uppercase tracking-widest mb-1.5">
                        Description
                    </span>
                    <p className="text-xs text-[#b3b3b3] font-mono leading-relaxed">
                        {selectedNode.data?.description || 'No description available'}
                    </p>
                </div>

                {/* Tags Section */}
                {selectedNode.data?.tags?.length > 0 && (
                    <div>
                        <span className="block text-[10px] text-[#666666] font-bold uppercase tracking-widest mb-2">
                            Tags
                        </span>
                        <div className="flex flex-wrap gap-2">
                            {selectedNode.data.tags.map((tag: string, index: number) => {
                                const isHighRisk = ['Warning', 'Error', 'RPC', 'Network'].some(keyword => 
                                    tag.includes(keyword)
                                );
                                return (
                                    <span
                                        key={index}
                                        className={`px-3 py-1 text-xs font-mono rounded-full ${
                                            isHighRisk
                                                ? 'bg-[#ff6600] text-black border-none font-bold'
                                                : 'bg-[#151515] text-gray-300 border border-gray-700'
                                        }`}
                                    >
                                        {tag}
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Deep Scan Button */}
                <div className="mt-6 w-full">
                  <button
                    onClick={() => requestDeepScan(selectedNode.id, selectedNode.data.assetPath || selectedNode.data.description)}
                    className="w-full py-3 bg-[#151515] border border-[#ff6600]/50 hover:bg-[#ff6600] hover:text-black text-[#ff6600] font-black tracking-[0.2em] uppercase rounded-lg transition-all duration-200 shadow-[0_0_15px_rgba(255,102,0,0.1)] hover:shadow-[0_0_20px_rgba(255,102,0,0.4)] active:translate-y-[2px]"
                  >
                    Initialize Deep Scan
                  </button>
                  <p className="text-center text-[9px] text-gray-500 font-mono mt-2 tracking-widest uppercase">
                     Triggers C++ AST Extraction & LLM Analysis
                   </p>
                </div>

                {/* TE-Aesthetic Deep Scan Diagnostics State Machine */}
                <div className="mb-6 border-t border-[#333] pt-4"> 
                  <h4 className="text-[10px] font-black text-[#666] tracking-[0.2em] uppercase mb-2">Deep Scan Diagnostics</h4> 
                   
                  {/* The State Machine Indicator */} 
                  <div className="mb-3 font-mono text-[10px] tracking-widest uppercase"> 
                    {selectedNode.data?.scanStatus === 'scanning' && ( 
                      <span className="text-[#ff6600] animate-pulse">[ PROCESSING AST ... ]</span> 
                    )} 
                    {selectedNode.data?.scanStatus === 'failed' && ( 
                      <span className="text-red-500">[ ERR: {selectedNode.data.scanError} ]</span> 
                    )} 
                    {selectedNode.data?.scanStatus === 'completed' && ( 
                      <span className="text-green-500">[ DECOMPILATION COMPLETE ]</span> 
                    )} 
                    {(!selectedNode.data?.scanStatus || selectedNode.data?.scanStatus === 'idle') && ( 
                      <span className="text-gray-600">[ AWAITING INIT ]</span> 
                    )} 
                  </div> 

                  {/* The Analysis Result */} 
                  {selectedNode.data?.analysisResult && ( 
                    <p className="text-xs text-gray-300 font-mono leading-relaxed border-l-2 border-[#ff6600] pl-3"> 
                      {selectedNode.data.analysisResult} 
                    </p> 
                  )} 
                </div>
            </div>

            {selectedNode.data?.methods?.length > 0 && (
              <div className="mb-6 bg-[#151515] p-5 rounded-3xl border border-[#2a2a2a] shadow-lg">
                <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wider text-xs">
                  <Code size={14} className="text-[#ff6600]" />
                  Methods
                </h4>
                <div className="space-y-2">
                  {selectedNode.data.methods.map((method, index) => (
                    <div
                      key={index}
                      className="p-2.5 rounded-xl bg-[#0a0a0a] border border-[#1f1f1f] text-xs font-mono text-[#d4d4d4]"
                    >
                      {method}()
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {selectedNode && (
    <div className="mt-8 bg-[#1a1a1a] rounded-2xl border-2 border-[#333333] p-5 shadow-2xl flex flex-col gap-4">
        <div className="flex items-center justify-between border-b-2 border-[#333333] pb-3">
            <span className="font-black text-[#ff6600] text-lg uppercase tracking-widest">Node Inspector</span>
            <span className="bg-[#333333] px-2 py-1 rounded text-[10px] font-bold text-white uppercase border border-[#444444]">
                {selectedNode.data?.type || 'BP'}
            </span>
        </div>
        
        <div className="bg-[#050505] p-3.5 rounded-2xl border-t-2 border-t-[#000000] border-b border-b-[#2a2a2a] border-l border-l-[#0a0a0a] border-r border-r-[#0a0a0a] shadow-[inset_0_4px_10px_rgba(0,0,0,0.8)]">
            <span className="block text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-1">Target Asset</span>
            <span className="font-mono font-bold text-[#f5f5f5] text-sm break-all">{selectedNode.data?.title || selectedNode.id}</span>
        </div>

        <div className="bg-[#050505] p-3.5 rounded-2xl border-t-2 border-t-[#000000] border-b border-b-[#2a2a2a] border-l border-l-[#0a0a0a] border-r border-r-[#0a0a0a] shadow-[inset_0_4px_10px_rgba(0,0,0,0.8)]">
            <span className="block text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-2 flex items-center">
                <div className="w-2 h-2 bg-[#3b82f6] rounded-sm mr-2"></div> Incoming (Called By)
            </span>
            {deps.incoming.length > 0 ? (
                <div className="space-y-1.5 max-h-[120px] overflow-y-auto custom-scrollbar">
                    {deps.incoming.map((name: string, i: number) => (
                        <div key={i} className="text-xs font-mono text-[#d4d4d4] bg-[#1a1a1a] px-2 py-1 rounded border border-[#333333] truncate">
                            {name}
                        </div>
                    ))}
                </div>
            ) : <span className="text-[#444444] text-xs italic font-mono">NULL</span>}
        </div>

        <div className="bg-[#050505] p-3.5 rounded-2xl border-t-2 border-t-[#000000] border-b border-b-[#2a2a2a] border-l border-l-[#0a0a0a] border-r border-r-[#0a0a0a] shadow-[inset_0_4px_10px_rgba(0,0,0,0.8)]">
            <span className="block text-[10px] font-bold text-[#888888] uppercase tracking-wider mb-2 flex items-center">
                <div className="w-2 h-2 bg-[#ff6600] rounded-sm mr-2"></div> Outgoing (Calls To)
            </span>
            {deps.outgoing.length > 0 ? (
                <div className="space-y-1.5 max-h-[120px] overflow-y-auto custom-scrollbar">
                    {deps.outgoing.map((name: string, i: number) => (
                        <div key={i} className="text-xs font-mono text-[#d4d4d4] bg-[#1a1a1a] px-2 py-1 rounded border border-[#333333] truncate">
                            {name}
                        </div>
                    ))}
                </div>
            ) : <span className="text-[#444444] text-xs italic font-mono">NULL</span>}
        </div>
        
        <button 
            onClick={handleExportSingleNode} 
            className="w-full bg-[#111111] hover:bg-[#222222] text-[#888888] hover:text-white font-mono text-xs uppercase tracking-widest py-2 rounded-lg border border-[#333333] transition-colors mb-2" 
        > 
            Export Node Data (.json) 
        </button>
        {/* 替换原有的 Chat 按钮区域，加入状态机切换 */}
        {!chatMode ? (
            <button 
                onClick={() => setChatMode(true)} 
                className="mt-2 w-full bg-[#2a2a2a] hover:bg-[#ff6600] hover:text-[#0a0a0a] text-[#b3b3b3] font-bold uppercase tracking-wider py-3 rounded-xl border-2 border-[#444444] hover:border-[#ff6600] transition-all duration-200" 
            > 
                Enter Audit Mode (AI Chat) 
            </button> 
        ) : ( 
            <div className="mt-4 flex flex-col gap-2 border-t border-[#333333] pt-4"> 
                <span className="text-[10px] font-bold text-[#ff6600] uppercase tracking-widest flex justify-between"> 
                    <span>AI Audit Link Active</span> 
                    <button onClick={() => setChatMode(false)} className="text-[#666666] hover:text-white">Close</button> 
                </span> 
                
                {/* 聊天记录流 */} 
                <div ref={chatScrollRef} className="h-48 overflow-y-auto custom-scrollbar flex flex-col gap-3 p-2 bg-[#050505] rounded-xl border border-[#1f1f1f] shadow-[inset_0_4px_10px_rgba(0,0,0,0.8)]"> 
                    {chatLog.length === 0 && <span className="text-[#444444] text-xs font-mono italic text-center mt-4">System ready. Ask about dependencies, risks, or logic...</span>} 
                    {chatLog.map((msg, idx) => ( 
                        <div key={idx} className={`text-xs font-mono p-2 rounded-lg max-w-[90%] ${msg.role === 'user' ? 'bg-[#ff6600]/10 text-[#ff8833] border border-[#ff6600]/30 self-end' : msg.role === 'ai' ? 'bg-[#1a1a1a] text-[#d4d4d4] border border-[#333333] self-start' : 'bg-red-900/20 text-red-400 self-center'}`}> 
                            {msg.content} 
                        </div> 
                    ))} 
                    {isChatting && <div className="text-[#666666] text-xs font-mono animate-pulse">AI is thinking...</div>} 
                </div> 

                {/* 输入区 */} 
                <div className="flex gap-2"> 
                    <textarea 
                        value={chatInput} 
                        onChange={(e) => setChatInput(e.target.value)} 
                        onKeyDown={(e) => { 
                            if (e.key === 'Enter' && !e.shiftKey) { 
                                e.preventDefault(); 
                                handleSendMessage(); 
                            } 
                        }} 
                        placeholder="Type query... (Shift+Enter for new line)" 
                        rows={1} 
                        className="flex-1 bg-[#111111] text-[#f5f5f5] px-3 py-2 rounded-lg border border-[#333333] focus:border-[#ff6600] focus:outline-none font-mono text-xs resize-none overflow-hidden" 
                    /> 
                    <button 
                        onClick={handleSendMessage} 
                        disabled={isChatting} 
                        className="bg-[#333333] hover:bg-[#ff6600] text-white hover:text-black px-4 rounded-lg font-bold transition-colors disabled:opacity-50" 
                    > 
                        &gt; 
                    </button> 
                </div> 
            </div> 
        )}
    </div>
)}
      </div>
    </div>
  );
};
