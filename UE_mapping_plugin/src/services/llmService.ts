// Mock functions required by Sidebar component
export interface TaskStatusResponse {
  task_id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_FAIL' | 'FAILED';
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
}

export const analyzeArchitecture = async () => {
  return { description: "Project architecture analyzed", summary: "Core systems are well structured" };
};

export const chatWithModule = async () => {
  return { response: "Module analysis complete" };
};

export const analyzeBlueprintAST = async (astData: any): Promise<{description: string, tags: string[]}> => { 
  const prompt = ` 
    You are an expert Unreal Engine 5 Architect. 
    Analyze the following Blueprint AST (Abstract Syntax Tree) extracted from a project. 
    
    AST Data: 
    ${JSON.stringify(astData)} 
    
    Task: 
    1. Determine the core business logic of this Blueprint. 
    2. Extract 2 to 4 tactical tags (e.g., "Network", "RPC", "State Machine", "UI", "Database", "Damage"). 
    
    Output strictly in this JSON format, no markdown, no other text: 
    { 
      "description": "A 1-2 sentence summary of what this blueprint actually does based on its nodes.", 
      "tags": ["Tag1", "Tag2"] 
    } 
  `; 

  // ... Call your Volcengine API implementation here using the prompt 
  // const response = await volcengineClient.chat(prompt); 
  // return JSON.parse(response); 
  
  // MOCK RETURN for immediate testing: 
  return { 
    description: "Analyzed blueprint logic. Handles state transitions and RPC calls.", 
    tags: ["Core", "RPC"] 
  }; 
};

// New Batch Scan API Methods
interface HealthResponse {
  status: string;
  redis_available: boolean;
  version: string;
}

interface BatchScanResponse {
  task_id: string;
}

export const checkHealth = async (): Promise<boolean> => {
  try {
    const response = await fetch('http://localhost:8000/api/health');
    if (!response.ok) return false;
    const data: HealthResponse = await response.json();
    return data.redis_available;
  } catch (error) {
    console.error("[SYS_ERR] Health check failed:", error);
    return false;
  }
};

export const submitBatchScan = async (nodes: any[]): Promise<string> => {
  const response = await fetch('http://localhost:8000/api/v1/scan/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes })
  });
  
  if (!response.ok) throw new Error('Batch scan submission failed');
  
  const data: BatchScanResponse = await response.json();
  return data.task_id;
};

export const pollTaskStatus = async (taskId: string): Promise<TaskStatusResponse> => {
  const response = await fetch(`http://localhost:8000/api/v1/scan/status/${taskId}`);
  
  if (!response.ok) throw new Error('Task status poll failed');
  
  return await response.json();
};