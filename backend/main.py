from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import AsyncOpenAI
from contextlib import asynccontextmanager
import redis.asyncio as redis
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
import json
import os
import re
import uuid
import asyncio
from pathlib import Path
from typing import List, Dict, Optional, Union, Any

import vault_writer

# Initialize Async LLM Client configured for Volcengine (火山方舟)
client = AsyncOpenAI(
    api_key=os.getenv("ARK_API_KEY", "e5ea8632-8610-45ae-b3b6-e36478f24cae"),
    base_url="https://ark.cn-beijing.volces.com/api/v3"
)

VOLC_MODEL_ENDPOINT = os.getenv("VOLC_ENDPOINT_ID", "ep-20260416103803-ckqm5")

CONCURRENCY_LIMIT = 5
semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)

redis_client = None

DEFAULT_VOCAB_PATH = Path(__file__).parent / "tag_vocabulary_default.json"

# ─────────────────────────────────────────────────────────────────────────────
# System prompt — outputs structured metadata block, then markdown body
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an elite Unreal Engine 5 System Architect.
Analyze the provided Blueprint AST and produce TWO sections in this exact order:

[METADATA]
{
  "intent": "<one sentence describing the core purpose>",
  "system": ["<pick 1-3 from system axis>"],
  "layer": "<pick exactly 1 from layer axis>",
  "role": "<pick exactly 1 from role axis>",
  "risk_level": "<nominal | warning | critical>"
}
[/METADATA]

[ANALYSIS]
### [ INTENT ]
(1 sentence explaining the core purpose)

### [ EXECUTION FLOW ]
(Bullet points referencing node names)

### [ I/O & MUTATIONS ]
(Key inputs, outputs, state changes)

### [ ARCHITECTURAL RISK ]
(Performance bottlenecks or logic flaws. If none, output "SYSTEM NOMINAL")
[/ANALYSIS]

CONTROLLED VOCABULARY — you MUST pick tag values only from these lists:
- system axis: gameplay-core, combat, ai, animation, physics, network, multiplayer-meta, ui, audio, vfx, cinematic, camera, input, world, spawn, persistence, progression, economy, analytics, tooling
- layer axis: gameplay, framework, ui, data, service, tooling
- role axis: actor, component, widget, controller, gamemode, gamestate, playerstate, subsystem, interface, function-library, data-asset, data-table, struct, enum, animation-blueprint, behavior-tree

Rules:
- Tone: Future-Retro, cyberpunk-industrial. Zero conversational fluff.
- Do not invent tag values. If unsure, pick the closest from the vocabulary.
- METADATA block must be valid JSON.
"""

# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

class EdgePayload(BaseModel):
    target: str                          # target node title (filename stem) or id
    edge_type: str = "function_call"     # function_call|interface_call|cast|spawn|listens_to
    refs: List[str] = []
    label: Optional[str] = None


class ASTNodePayload(BaseModel):
    node_id: str
    asset_path: str
    title: Optional[str] = None          # human-friendly name; defaults to last segment of asset_path
    node_type: str = "Blueprint"         # Blueprint | CPP | Interface | Component
    parent_class: Optional[str] = None
    ast_data: Optional[Dict] = None
    outbound_edges: List[EdgePayload] = []


class BatchScanRequest(BaseModel):
    nodes: List[ASTNodePayload]
    project_root: Optional[str] = None   # absolute path to UE project; vault is written under <project_root>/.aicartographer/vault


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    total_nodes: int
    completed_nodes: int
    failed_nodes: int
    skipped_nodes: int = 0
    node_statuses: Dict[str, str] = {}


class ASTPayload(BaseModel):
    name: str
    ast: Optional[Union[List, Dict]] = None


class WriteNotesRequest(BaseModel):
    project_root: str
    relative_path: str                   # e.g. "Blueprints/BP_PlayerCharacter.md"
    content: str


# ─────────────────────────────────────────────────────────────────────────────
# LLM response parser
# ─────────────────────────────────────────────────────────────────────────────

_METADATA_RE = re.compile(r"\[METADATA\](.*?)\[/METADATA\]", re.DOTALL)
_ANALYSIS_RE = re.compile(r"\[ANALYSIS\](.*?)\[/ANALYSIS\]", re.DOTALL)


def parse_llm_response(raw: str) -> Dict[str, Any]:
    """
    Returns: {
      'intent': str|None, 'tags': [..], 'risk_level': str,
      'analysis_markdown': str, 'parse_ok': bool
    }
    """
    out: Dict[str, Any] = {
        "intent": None, "tags": [], "risk_level": "nominal",
        "analysis_markdown": raw, "parse_ok": False,
    }

    md_match = _METADATA_RE.search(raw)
    body_match = _ANALYSIS_RE.search(raw)

    if md_match:
        try:
            md_obj = json.loads(md_match.group(1).strip())
            out["intent"] = md_obj.get("intent")
            risk = (md_obj.get("risk_level") or "nominal").lower()
            if risk not in ("nominal", "warning", "critical"):
                risk = "nominal"
            out["risk_level"] = risk
            tags: List[str] = []
            for s in md_obj.get("system", []) or []:
                tags.append(f"#system/{s}")
            if md_obj.get("layer"):
                tags.append(f"#layer/{md_obj['layer']}")
            if md_obj.get("role"):
                tags.append(f"#role/{md_obj['role']}")
            out["tags"] = tags
            out["parse_ok"] = True
        except (json.JSONDecodeError, AttributeError) as e:
            print(f"[SYS_WARN] METADATA block malformed: {e}")

    if body_match:
        out["analysis_markdown"] = body_match.group(1).strip()

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Background batch worker
# ─────────────────────────────────────────────────────────────────────────────

async def process_batch_ast_task(task_id: str, nodes: List[ASTNodePayload], project_root: Optional[str]):
    total_nodes = len(nodes)
    failed = 0
    completed = 0
    skipped = 0

    # Per-task asset_hashes accumulator (written to manifest at end)
    asset_hashes: Dict[str, str] = {}
    # Initial baseline pulled from existing manifest so unchanged nodes survive
    if project_root:
        existing_manifest = vault_writer.load_manifest(project_root)
        asset_hashes.update(existing_manifest.get("asset_hashes", {}))

    await redis_client.hset(f"task:{task_id}", mapping={
        "status": "PROCESSING",
        "total_nodes": total_nodes,
        "completed_nodes": 0,
        "failed_nodes": 0,
        "skipped_nodes": 0,
    })

    if project_root:
        vault_writer.ensure_vault_layout(project_root, DEFAULT_VOCAB_PATH)

    async def process_single_node(node: ASTNodePayload):
        nonlocal completed, failed, skipped
        try:
            ast_hash = vault_writer.compute_ast_hash(node.ast_data)

            # Incremental skip: same AST as previous scan → no LLM call, no rewrite
            if project_root and vault_writer.is_unchanged(project_root, node.node_id, ast_hash):
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "SKIPPED")
                await redis_client.hincrby(f"task:{task_id}", "skipped_nodes", 1)
                skipped += 1
                asset_hashes[node.node_id] = ast_hash
                print(f"[SKIP] {node.asset_path} unchanged (hash={ast_hash})")
                return

            async with semaphore:
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "PROCESSING")
                print(f"[ARCHITECT_PROBE] Processing AST for: {node.asset_path} (Node ID: {node.node_id})")

                # Optional physical AST dump (kept from legacy flow)
                if node.ast_data:
                    safe_filename = node.asset_path.split("/")[-1].replace(".", "_")
                    dump_path = f"dump_AST_{safe_filename}_{node.node_id}.json"
                    with open(dump_path, "w", encoding="utf-8") as f:
                        json.dump(node.ast_data, f, indent=2, ensure_ascii=False)

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

                raw_analysis = response.choices[0].message.content or ""
                parsed = parse_llm_response(raw_analysis)

                # Store full analysis + parse status in Redis (legacy clients still read this)
                await redis_client.set(f"result:{task_id}:{node.node_id}", parsed["analysis_markdown"])

                # Write to vault
                if project_root:
                    title = node.title or node.asset_path.split("/")[-1].split(".")[-1] or node.node_id
                    record = vault_writer.NodeRecord(
                        node_id=node.node_id,
                        title=title,
                        asset_path=node.asset_path,
                        node_type=node.node_type,
                        parent_class=node.parent_class,
                        ast_data=node.ast_data,
                        edges_out=[
                            vault_writer.Edge(
                                target=e.target, edge_type=e.edge_type,
                                refs=e.refs, label=e.label,
                            ) for e in node.outbound_edges
                        ],
                        intent=parsed["intent"],
                        risk_level=parsed["risk_level"],
                        tags=parsed["tags"],
                        full_analysis_markdown=parsed["analysis_markdown"],
                    )
                    write_result = vault_writer.write_node_file(
                        project_root=project_root,
                        node=record,
                        model=VOLC_MODEL_ENDPOINT,
                        engine_version="5.7",
                    )
                    asset_hashes[node.node_id] = write_result["ast_hash"]
                    print(f"[VAULT] wrote {write_result['path']} (review_needed={write_result['notes_review_needed']})")

                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "COMPLETED")
                await redis_client.hincrby(f"task:{task_id}", "completed_nodes", 1)
                completed += 1

        except Exception as e:
            print(f"[SYS_ERR] Failed to process node {node.node_id}: {e}")
            try:
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "FAILED")
                await redis_client.hincrby(f"task:{task_id}", "failed_nodes", 1)
            except Exception as inner:
                print(f"[SYS_ERR] Could not record FAILED state for {node.node_id}: {inner}")
            failed += 1

    await asyncio.gather(*(process_single_node(n) for n in nodes), return_exceptions=True)

    # Backlinks reverse-index + manifest update happen ONCE per batch
    if project_root:
        try:
            counts = vault_writer.rebuild_backlinks(project_root)
            print(f"[VAULT] backlinks: {counts}")
            vault_writer.update_manifest(
                project_root,
                completed=completed,
                failed=failed,
                skipped=skipped,
                asset_hashes=asset_hashes,
            )
        except Exception as e:
            print(f"[SYS_ERR] Vault post-processing failed: {e}")

    final_status = "COMPLETED" if failed == 0 else "PARTIAL_FAIL" if completed > 0 else "FAILED"
    await redis_client.hset(f"task:{task_id}", "status", final_status)
    print(f"[SYS_LOG] Batch {task_id} done. Status={final_status} completed={completed} failed={failed} skipped={skipped}")


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI lifespan + app
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client
    app.state.redis_available = False
    try:
        redis_host = os.getenv("REDIS_HOST", "localhost")
        redis_port = int(os.getenv("REDIS_PORT", 6379))
        redis_client = redis.Redis(host=redis_host, port=redis_port, db=0, decode_responses=True, socket_connect_timeout=5)
        await redis_client.ping()
        app.state.redis_available = True
        print("[ SYS_NOMINAL ] Redis connected. Batch Cartography ONLINE.")
    except (RedisConnectionError, RedisTimeoutError):
        print("[ SYS_WARNING ] Redis unavailable. Running in degraded mode.")
        app.state.redis_available = False
        redis_client = None

    yield

    if app.state.redis_available and redis_client:
        await redis_client.close()
        print("[SYS_LOG] Redis connection closed")


app = FastAPI(title="AICartographer Brain", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Health & legacy endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "SYS_NOMINAL",
        "redis_available": getattr(app.state, "redis_available", False),
        "version": "1.3.0",
    }


@app.post("/api/analyze-blueprint")
async def analyze_blueprint(payload: ASTPayload):
    try:
        print(f"[ARCHITECT_PROBE] Receiving AST for: {payload.name}")
        if payload.ast:
            safe_filename = payload.name.split("/")[-1].replace(".", "_")
            dump_path = f"dump_AST_{safe_filename}.json"
            with open(dump_path, "w", encoding="utf-8") as f:
                json.dump(payload.ast, f, indent=2, ensure_ascii=False)

        ast_string = json.dumps(payload.ast)[:8000] if payload.ast else "Empty AST (degraded mode)"
        prompt = f"Analyze this UE5 Blueprint AST.\nBlueprint Name: {payload.name}\nAST Data:\n{ast_string}"

        response = await client.chat.completions.create(
            model=VOLC_MODEL_ENDPOINT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            temperature=0.1
        )

        raw = response.choices[0].message.content or ""
        parsed = parse_llm_response(raw)
        return {"summary": parsed["analysis_markdown"], "metadata": {
            "intent": parsed["intent"], "tags": parsed["tags"], "risk_level": parsed["risk_level"],
        }}

    except Exception as e:
        print(f"[SYS_ERR] AI Engine Failure: {e}")
        raise HTTPException(status_code=500, detail="CONNECTION_SEVERED: Unable to reach AI Brain.")


# ─────────────────────────────────────────────────────────────────────────────
# Async batch endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/v1/scan/batch", status_code=202)
async def create_batch_scan_task(request: BatchScanRequest, background_tasks: BackgroundTasks):
    if not getattr(app.state, "redis_available", False) or redis_client is None:
        raise HTTPException(status_code=503, detail="Batch Cartography Engine offline. Redis required.")
    task_id = str(uuid.uuid4())

    await redis_client.hset(f"task:{task_id}", mapping={
        "status": "PENDING",
        "total_nodes": len(request.nodes),
        "completed_nodes": 0,
        "failed_nodes": 0,
        "skipped_nodes": 0,
    })

    if request.nodes:
        per_node_init = {n.node_id: "PENDING" for n in request.nodes}
        await redis_client.hset(f"task:{task_id}:nodes", mapping=per_node_init)

    background_tasks.add_task(process_batch_ast_task, task_id, request.nodes, request.project_root)
    return {"task_id": task_id}


@app.get("/api/v1/scan/status/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis offline")
    task_data = await redis_client.hgetall(f"task:{task_id}")
    if not task_data:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    node_statuses = await redis_client.hgetall(f"task:{task_id}:nodes")
    return TaskStatusResponse(
        task_id=task_id,
        status=task_data.get("status", "PENDING"),
        total_nodes=int(task_data.get("total_nodes", 0)),
        completed_nodes=int(task_data.get("completed_nodes", 0)),
        failed_nodes=int(task_data.get("failed_nodes", 0)),
        skipped_nodes=int(task_data.get("skipped_nodes", 0)),
        node_statuses=node_statuses or {},
    )


@app.get("/api/v1/scan/result/{task_id}/{node_id}")
async def get_node_result(task_id: str, node_id: str):
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis offline")
    result = await redis_client.get(f"result:{task_id}:{node_id}")
    if not result:
        raise HTTPException(status_code=404, detail=f"Result for {node_id} not found")
    return {"analysis": result}


# ─────────────────────────────────────────────────────────────────────────────
# Vault endpoints
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_vault_path(project_root: str, relative_path: str) -> Path:
    """Defence-in-depth path resolver — refuses any path that escapes vault root."""
    root = vault_writer.vault_root(project_root).resolve()
    target = (root / relative_path).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(status_code=400, detail="Path escapes vault root")
    return target


@app.get("/api/v1/vault/list")
async def vault_list(project_root: str):
    root = vault_writer.vault_root(project_root)
    if not root.exists():
        return {"project_root": project_root, "exists": False, "files": []}
    files = []
    for p in root.rglob("*.md"):
        files.append({
            "relative_path": str(p.relative_to(root)).replace("\\", "/"),
            "title": p.stem,
            "subdir": str(p.parent.relative_to(root)).replace("\\", "/"),
            "size": p.stat().st_size,
        })
    manifest = vault_writer.load_manifest(project_root)
    return {
        "project_root": project_root,
        "exists": True,
        "files": files,
        "manifest": manifest,
    }


@app.get("/api/v1/vault/read")
async def vault_read(project_root: str, relative_path: str):
    target = _resolve_vault_path(project_root, relative_path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {relative_path}")
    text = target.read_text(encoding="utf-8")
    fm = vault_writer.read_existing_frontmatter(target) or {}
    return {
        "relative_path": relative_path,
        "frontmatter": fm,
        "content": text,
    }


@app.put("/api/v1/vault/notes")
async def vault_write_notes(req: WriteNotesRequest):
    try:
        result = vault_writer.write_user_notes(req.project_root, req.relative_path, req.content)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write notes: {e}")


@app.post("/api/v1/vault/rebuild-backlinks")
async def vault_rebuild_backlinks(project_root: str):
    try:
        counts = vault_writer.rebuild_backlinks(project_root)
        return {"project_root": project_root, **counts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
