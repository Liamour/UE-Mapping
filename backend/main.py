from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import AsyncOpenAI
from contextlib import asynccontextmanager
import redis.asyncio as redis
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
import json
import os
import uuid
import asyncio
from typing import List, Dict, Optional, Union

# Initialize Async LLM Client configured for Volcengine (火山方舟)
# The user MUST set ARK_API_KEY and VOLC_ENDPOINT_ID in their environment or replace the strings below.
client = AsyncOpenAI(
    api_key=os.getenv("ARK_API_KEY", "e5ea8632-8610-45ae-b3b6-e36478f24cae"),
    base_url="https://ark.cn-beijing.volces.com/api/v3"
)

# The Endpoint ID acts as the model name in Volcengine
VOLC_MODEL_ENDPOINT = os.getenv("VOLC_ENDPOINT_ID", "ep-20260416103803-ckqm5")

# Concurrency control for Volcengine API
CONCURRENCY_LIMIT = 5
semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)

# Redis connection instance
redis_client = None

# The Architect's System Prompt
SYSTEM_PROMPT = """You are an elite Unreal Engine 5 System Architect.
Your task is to analyze raw Blueprint AST JSON and explain its business logic and intent.
Format your response in strict Markdown with a Future-Retro, cyberpunk-industrial tone.
Zero conversational fluff. Do not say "Here is the analysis".

Use the following strict structure:
### [ INTENT ]
(1 sentence explaining the core purpose of this blueprint)

### [ EXECUTION FLOW ]
(Bullet points of the main logic sequence, referencing node names)

### [ I/O & MUTATIONS ]
(Key inputs, outputs, or state changes)

### [ ARCHITECTURAL RISK ]
(Identify any potential performance bottlenecks or logic flaws, if none, output "SYSTEM NOMINAL")
"""

# Pydantic Data Contracts
class ASTNodePayload(BaseModel):
    node_id: str
    asset_path: str
    ast_data: Optional[Dict] = None

class BatchScanRequest(BaseModel):
    nodes: List[ASTNodePayload]

class TaskStatusResponse(BaseModel):
    task_id: str
    status: str  # ENUM: 'PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL_FAIL', 'FAILED'
    total_nodes: int
    completed_nodes: int
    failed_nodes: int

class ASTPayload(BaseModel):
    name: str
    ast: Union[List, Dict]

# Async Background Worker Logic
async def process_batch_ast_task(task_id: str, nodes: List[ASTNodePayload]):
    total_nodes = len(nodes)
    failed = 0
    completed = 0

    # Update task status to PROCESSING
    await redis_client.hset(f"task:{task_id}", mapping={
        "status": "PROCESSING",
        "total_nodes": total_nodes,
        "completed_nodes": 0,
        "failed_nodes": 0
    })

    async def process_single_node(node: ASTNodePayload):
        nonlocal completed, failed
        try:
            async with semaphore:
                print(f"[ARCHITECT_PROBE] Processing AST for: {node.asset_path} (Node ID: {node.node_id})")
                
                # Preserve AST physical dumping logic
                safe_filename = node.asset_path.split("/")[-1].replace(".", "_") 
                dump_path = f"dump_AST_{safe_filename}_{node.node_id}.json" 
                
                if node.ast_data:
                    with open(dump_path, "w", encoding="utf-8") as f: 
                        json.dump(node.ast_data, f, indent=2, ensure_ascii=False) 
                    print(f"[SYS_LOG] AST successfully dumped to physical hard drive: {dump_path}") 

                # LLM Analysis
                ast_string = json.dumps(node.ast_data)[:8000] if node.ast_data else "Empty AST"
                prompt = f"Analyze this UE5 Blueprint AST.\nBlueprint Path: {node.asset_path}\nAST Data:\n{ast_string}"

                response = await client.chat.completions.create(
                    model=VOLC_MODEL_ENDPOINT,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.1
                )

                analysis = response.choices[0].message.content
                # Store analysis result in Redis
                await redis_client.set(f"result:{task_id}:{node.node_id}", analysis)
                print(f"[ARCHITECT_PROBE] Analysis complete for node {node.node_id}")

                # Update completion counter
                await redis_client.hincrby(f"task:{task_id}", "completed_nodes", 1)
                completed += 1

        except Exception as e:
            print(f"[SYS_ERR] Failed to process node {node.node_id}: {str(e)}")
            await redis_client.hincrby(f"task:{task_id}", "failed_nodes", 1)
            failed += 1

    # Process all nodes concurrently
    tasks = [process_single_node(node) for node in nodes]
    await asyncio.gather(*tasks, return_exceptions=True)

    # Update final task status
    final_status = "COMPLETED" if failed == 0 else "PARTIAL_FAIL" if completed > 0 else "FAILED"
    await redis_client.hset(f"task:{task_id}", "status", final_status)
    print(f"[SYS_LOG] Batch task {task_id} completed. Status: {final_status}, Total: {total_nodes}, Completed: {completed}, Failed: {failed}")

# FastAPI Lifespan Context Manager
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize Redis connection pool on startup
    global redis_client
    app.state.redis_available = False
    try:
        redis_host = os.getenv("REDIS_HOST", "localhost")
        redis_port = int(os.getenv("REDIS_PORT", 6379))
        redis_client = redis.Redis(host=redis_host, port=redis_port, db=0, decode_responses=True, socket_connect_timeout=5)
        # Verify connection
        await redis_client.ping()
        app.state.redis_available = True
        print("[ SYS_NOMINAL ] Redis connected. Batch Cartography ONLINE.")
    except (RedisConnectionError, RedisTimeoutError) as e:
        print("[ SYS_WARNING ] Redis unavailable. Running in degraded mode. Batch Cartography DISABLED.")
        app.state.redis_available = False
        redis_client = None
    
    yield
    
    # Close Redis connection on shutdown if available
    if app.state.redis_available and redis_client:
        await redis_client.close()
        print("[SYS_LOG] Redis connection closed")

# Initialize FastAPI
app = FastAPI(title="AICartographer Brain", lifespan=lifespan)

# Enable CORS for React Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# System Health Check Endpoint
@app.get("/api/health")
async def health_check():
    return {
        "status": "SYS_NOMINAL",
        "redis_available": getattr(app.state, "redis_available", False),
        "version": "1.2.0"
    }

@app.post("/api/analyze-blueprint")
async def analyze_blueprint(payload: ASTPayload):
    try:
        print(f"[ARCHITECT_PROBE] Receiving AST for: {payload.name}")
        
        # 👇 [ARCHITECT OVERRIDE: PHYSICAL DATA DUMP] 👇 
        # Clean the name to create a safe filename 
        safe_filename = payload.name.split("/")[-1].replace(".", "_") 
        dump_path = f"dump_AST_{safe_filename}.json" 
        
        with open(dump_path, "w", encoding="utf-8") as f: 
            json.dump(payload.ast, f, indent=2, ensure_ascii=False) 
            
        print(f"[SYS_LOG] AST successfully dumped to physical hard drive: {dump_path}") 
        # 👆 ======================================== 👆 
        
        # Compress AST to string
        ast_string = json.dumps(payload.ast)[:8000]
        prompt = f"Analyze this UE5 Blueprint AST.\nBlueprint Name: {payload.name}\nAST Data:\n{ast_string}"

        response = await client.chat.completions.create(
            model=VOLC_MODEL_ENDPOINT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            temperature=0.1
        )

        analysis = response.choices[0].message.content
        print(f"[ARCHITECT_PROBE] Analysis complete via Volcengine. Dispatching to frontend.")
        
        return {"summary": analysis}

    except Exception as e:
        print(f"[SYS_ERR] AI Engine Failure: {str(e)}")
        raise HTTPException(
            status_code=500, 
            detail="CONNECTION_SEVERED: Unable to reach AI Brain (Volcengine)."
        )
# ------------------------------
# END OF LEGACY SYNCHRONOUS ENDPOINT
# ------------------------------

# New Async Batch Endpoints
@app.post("/api/v1/scan/batch", status_code=202)
async def create_batch_scan_task(request: BatchScanRequest, background_tasks: BackgroundTasks):
    if not request.app.state.redis_available:
        raise HTTPException(status_code=503, detail="Batch Cartography Engine offline. Redis is required for asynchronous scanning.")
    # Generate unique task ID
    task_id = str(uuid.uuid4())
    
    # Initialize task state in Redis
    await redis_client.hset(f"task:{task_id}", mapping={
        "status": "PENDING",
        "total_nodes": len(request.nodes),
        "completed_nodes": 0,
        "failed_nodes": 0
    })
    
    # Dispatch background processing task
    background_tasks.add_task(process_batch_ast_task, task_id, request.nodes)
    
    return {"task_id": task_id}

@app.get("/api/v1/scan/status/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    task_data = await redis_client.hgetall(f"task:{task_id}")
    
    if not task_data:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    
    return TaskStatusResponse(
        task_id=task_id,
        status=task_data.get("status", "PENDING"),
        total_nodes=int(task_data.get("total_nodes", 0)),
        completed_nodes=int(task_data.get("completed_nodes", 0)),
        failed_nodes=int(task_data.get("failed_nodes", 0))
    )

@app.get("/api/v1/scan/result/{task_id}/{node_id}")
async def get_node_result(task_id: str, node_id: str):
    result = await redis_client.get(f"result:{task_id}:{node_id}")
    
    if not result:
        raise HTTPException(status_code=404, detail=f"Result for node {node_id} in task {task_id} not found")
    
    return {"analysis": result}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
