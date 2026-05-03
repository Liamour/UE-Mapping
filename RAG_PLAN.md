# AICartographer Phase C — RAG 问答 实施落地计划

> 创建：2026-05-04｜负责：UE-Mapping Developer
> 关联：[HANDOFF.md §18.6 / §19 / §22.5 / §24.7](HANDOFF.md)
> 状态：**未启动**，5 项关键决策已锁定（见 §1.2），等用户 greenlight 进入 C0 脚手架

> **下次 session 必读路径**：本文 §1 → §2 → §10（文件清单）→ §14（交接清单）。其余可按需翻。

---

## §1 一句话 + 锁定决策

### 1.1 一句话目标

把 vault 变成可问答的项目知识库。用户问"村民为什么会卡死""谁在调 BPI_GI.UpdateAllVillagers""存档怎么工作"，agent 用**混合检索 + 图查询**找证据、用 LLM 生成带**强制 asset_path 引用**的答案，前端把引用渲染成可点击的 Lv2 跳转链接。

不是"在 vault 上开 ChatGPT"。是**让已有的图结构（calltrace / system 成员 / edges）+ 已有的叙事（L1/L2 narrative）成为同一套检索 substrate**。

### 1.2 用户已拍板的 5 项决策（不再回议）

| # | 决策 | 含义 |
|---|---|---|
| 1 | **Embedding 本地化（bge-m3）** | 一次性 ~1.2GB 模型下载，CPU 跑 OK；零 per-query 费、零数据外流；与 §19.1 决策 #1（vault 不进 git，本地一份）哲学一致 |
| 2 | **sqlite-vec for v1，留升级空间** | 单文件、零守护进程、跟 FastAPI 同进程；如果 v2 召回瓶颈再换 lancedb（多向量原生支持） |
| 3 | **C0 不做 tool calling，纯 hybrid RAG** | 先 ship 5-7 天 MVP 锁住"能用"，C1 再加 agent；功能验证为主，留升级空间 |
| 4 | **重用 AIChat 面板** | 现在就是 stub，正好废物利用；不开新面板避免"两个 chat 哪个是哪个"的认知负担 |
| 5 | **OpenAI-compat 主攻，Anthropic 仅做基线验证** | **关键约束**——商用用户跑什么代理我们无法控制（同 §22-§24 教训）。生成路径必须走已有 `call_llm`，沿用 §22.x `with_raw_response` + 7 层提取兜底；Anthropic 用来跑能力对照实验，但不能作为唯一可工作路径 |

---

## §2 为什么标准 RAG 在这里不够（设计前提）

普通 RAG = "切片 → 向量 → 余弦召回 → 喂 LLM"。我们的 corpus 不是普通文本：

| 特性 | 影响 |
|---|---|
| frontmatter 是结构化字段（`asset_path` / `edges` / `exports` / `tags` / `system`） | 一部分查询用**精确图查询**比向量召回准确 10× |
| 文档分层（System narrative / BP narrative / NOTES） | 不同问题需要不同层级 |
| 文档间有显式边（`edges.function_call: BPI_GI`） | 邻接图本身是上下文 |
| 用户问题大多带类型 | "怎么实现"=narrative，"谁调我"=图查，"哪改值"=variable/DT 字段 |

**核心判断**：必须**混合检索**。纯向量在"BPI_GI 都被谁调"上输给已有的 `/api/v1/calltrace inbound`；纯结构化在"村民工作流"上输给向量。两者必须同时存在。

C0 阶段先把混合检索（BM25 + dense + RRF）做出来；C1 把 5 个图工具接成 agent，让 LLM 自己决定走哪条路。

---

## §3 架构

```
                     ┌──────────────────────────┐
   用户问题（zh/en）  │  POST /api/v1/qa (SSE)   │
       │            │  (流式 token + 引用 chip)│
       ↓            └────────────┬─────────────┘
                                 │
   ┌─────────────────────────────┼──────────────────────────┐
   │                                                         │
   │  C0：单轮检索 → 单次 LLM 生成                           │
   │  ┌────────────────────┐                                 │
   │  │ search_narrative(q)│ ← BM25 + bge-m3 dense + RRF    │
   │  │   → top-5 chunks   │                                 │
   │  └─────────┬──────────┘                                 │
   │            ↓                                            │
   │  ┌────────────────────────────────────────┐            │
   │  │ call_llm(SYSTEM_PROMPT_QA, q, chunks) │ ← 复用！   │
   │  └────────────────────────────────────────┘            │
   │                                                         │
   │  C1：多轮 agent loop（最多 6 步）                       │
   │  ┌────────────────────┐                                 │
   │  │  LLM 选工具：      │                                 │
   │  │  • search_narrative│                                 │
   │  │  • get_callers     │ ← 复用 /api/v1/calltrace inbound│
   │  │  • get_callees     │ ← 复用 /api/v1/calltrace outbound│
   │  │  • get_system      │ ← 复用 vault writer 索引       │
   │  │  • read_section    │ ← 文件按 heading 切片返        │
   │  └────────────────────┘                                 │
   └─────────────────────────────────────────────────────────┘
                                 │
                                 ↓
                     ┌──────────────────────────┐
                     │ AIChat.tsx 渲染 SSE 流  │
                     │ + 引用 chip → Lv2 跳    │
                     └──────────────────────────┘

离线：POST /api/v1/rag/reindex
       ↓
  vault → chunker (5 类) → bge-m3 encoder → sqlite-vec + FTS5
                                              ↓
                              .aicartographer/rag_index.db
```

**关键**：5 个工具里 4 个是**复用**已有结构化数据，工程量集中在切块/嵌入/检索三件套。

---

## §4 数据 pipeline

### 4.1 切块策略（最关键）

**不要按 token 数硬切**——会切碎 frontmatter、跨节标题、把 NOTES 跟 ANALYSIS 混。每个 vault 文件按语义切 3-5 个 chunk：

| chunk_kind | 来源 | 长度（粗） | 用途 |
|---|---|---:|---|
| `header` | title + intent + node_type + system + parent_class + tags（合成的小段） | 80-150 词 | 高频检索锚点（"BPI_GI 是什么"直接命中） |
| `structure` | exports_functions + exports_events + exports_dispatchers + components + edges 的扁平化文本 | 100-300 词 | 字面量召回（"哪个 BP 有 ChangeJob"） |
| `narrative` | aiSection（LLM 写的 ANALYSIS 段） | 200-600 词 | 概念性问题（"村民工作流怎么走"） |
| `notes` | NOTES 段（用户手写） | 可变 | 高价值 dev-curated 信息 |
| `system` | `vault/Systems/X.md` 的 narrative 段 | 300-800 词 | 系统级问题（"UI 系统都干啥"） |

**为什么不只切 narrative**：用户问"BP_Villager 的 components 是什么"——这是 `structure` chunk 的命中场景，纯 narrative 可能根本不提；问"BPI_GI 通常被谁调用"——`header` chunk 的 `tags: blueprint, interface` + 系统 chunk 配合命中。多种 kind 互补。

**chunk 唯一 ID**：`{title}#{chunk_kind}`（如 `BP_Villager#narrative`），稳定、可读、跨 reindex 不变。

**chunk payload**（入库前的 dict）：
```python
{
    "id": "BP_Villager#narrative",
    "text": "...",                           # 实际文本，~600 词内
    "embedding": [...],                       # bge-m3 dense 向量，1024 dim
    "metadata": {
        "asset_path": "/Game/Blueprint/Villagers/BP_Villager.BP_Villager",
        "title": "BP_Villager",
        "subdir": "Blueprints",
        "node_type": "Blueprint",
        "system_id": "ai",                   # 可空（System chunk 自身没 system_id）
        "chunk_kind": "narrative",
        "ast_hash": "e854f891",               # 增量索引关键
        "relative_path": "Blueprints/BP_Villager.md",
    },
}
```

### 4.2 Embedder

```python
# backend/rag/embedder.py 骨架
from sentence_transformers import SentenceTransformer

class BgeEmbedder:
    def __init__(self, cache_dir: Path):
        # 首次自动下载 ~1.2GB 到 cache_dir，落到 .aicartographer/models/
        self.model = SentenceTransformer("BAAI/bge-m3", cache_folder=str(cache_dir))
        self.dim = 1024

    def encode(self, texts: list[str]) -> np.ndarray:
        # batch_size 32，CPU 上 ~50ms/chunk；GPU 加速 ~5ms/chunk
        return self.model.encode(
            texts,
            batch_size=32,
            normalize_embeddings=True,        # 余弦 = 内积，sqlite-vec 直接用
            show_progress_bar=False,
        )
```

**关键决定**：
- `normalize_embeddings=True` 让向量 L2 归一化，sqlite-vec 默认 cosine 距离 = 内积比较，简化 schema
- bge-m3 支持 8192 ctx，narrative chunk 不会超
- 模型下载到 `.aicartographer/models/`，跟 vault 同目录树，便于 gitignore + 删除

### 4.3 sqlite-vec schema

```sql
-- 1. 主表：chunk 元数据 + 文本
CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    asset_path TEXT,
    title TEXT,
    subdir TEXT,
    node_type TEXT,
    system_id TEXT,
    chunk_kind TEXT,
    ast_hash TEXT,
    relative_path TEXT,
    indexed_at INTEGER                       -- unix epoch，用于 stale 检测
);

CREATE INDEX idx_chunks_ast_hash ON chunks(ast_hash);
CREATE INDEX idx_chunks_relative_path ON chunks(relative_path);

-- 2. 稠密向量：sqlite-vec 虚表
CREATE VIRTUAL TABLE chunk_vectors USING vec0(
    embedding FLOAT[1024]
);
-- chunk_vectors.rowid 跟 chunks.rowid 一一对应

-- 3. 稀疏检索：FTS5 全文表
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    title,
    asset_path,
    exports,                                  -- structure chunk 的字面量便于 BM25 命中
    content='chunks',
    content_rowid='rowid'
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text, title, asset_path, exports)
    VALUES (new.rowid, new.text, new.title, new.asset_path, '');
END;
```

**为什么 vec + fts 分两虚表**：sqlite-vec 不支持复合查询；BM25 必须 FTS5；分开后两路分别取 top-K，应用层做 RRF 合并最干净。

### 4.4 增量索引（C3 实现，C0 全量重建）

**触发**：
- 手动：用户点 Settings → "Rebuild RAG index"
- 自动 C3：scan/batch 完成回调里 enqueue diff 任务

**算法**：
1. 走 vault，按 `(relative_path, ast_hash)` 拿 ground truth 集合 `S`
2. 查 chunks 表里所有 (relative_path, ast_hash) 集合 `S'`
3. `S - S'` = 需要新增的文件；`S' - S` = 需要删除的（包含 rename + delete）
4. 受影响文件全部重新切块 + 嵌入，事务性替换其所有 chunk

C0 阶段简单粗暴：全删全建，76 文件 ~2 min。

---

## §5 检索 pipeline

```
query
  ↓
  ├─ BM25 over chunks_fts → top-30
  └─ bge-m3 encode(query) → cosine top-30 from chunk_vectors
        ↓
   RRF (k=60) 合并 → top-30
        ↓
  [v2 / Phase C2] bge-reranker cross-encoder → top-5
   [C0 / C1 跳过 reranker，直接 top-5]
        ↓
   按 chunk_kind 多样性 rebalance（避免 5 条全是 narrative）
        ↓
   返回给 LLM：编号 + title + chunk_kind + asset_path + text
```

### 5.1 RRF 公式

```python
def rrf_fuse(rank_lists: list[list[str]], k: int = 60) -> list[str]:
    """各召回路径的 [(chunk_id, rank)] → 融合后的排名"""
    scores: dict[str, float] = {}
    for rl in rank_lists:
        for rank, cid in enumerate(rl):
            scores[cid] = scores.get(cid, 0) + 1.0 / (k + rank + 1)
    return sorted(scores, key=scores.get, reverse=True)
```

`k=60` 是业界经验值，对前 ~10 名权重显著、之后衰减；不需要调权。

### 5.2 多样性 rebalance

避免 5 条全是 `narrative` 把 `structure` / `system` 挤掉：
- 取 RRF top-30
- 优先按 `chunk_kind` 各取 1（最多 5 类）
- 剩余配额按 RRF 顺序补满
- 输出 5 条

### 5.3 喂 LLM 的格式（**强制 cite 设计**）

```
[1] BP_Villager (system: ai, kind: narrative)
    asset_path: /Game/Blueprint/Villagers/BP_Villager.BP_Villager
    村民单位的行为壳。EventGraph 启动 BT 控制器 BTT_DefaultBT，
    通过 BPI_Villager 接口暴露 ChangeJob/PlayWorkAnim 给外部 ...

[2] BTT_Work (system: ai, kind: structure)
    asset_path: /Game/Blueprint/Villagers/BT/BTT_Work.BTT_Work
    exports_events: ReceiveExecuteAI
    edges.function_call → BPI_Villager (Play Work Anim)
    ...

[3] ...
```

System prompt（C0 草稿）：
```
你是 UE5 项目的代码助理。回答用户的问题时：
1. 你的每个事实声明必须用 [n] 引用上面提供的源
2. 如果源里没有相关信息，明确说"vault 里没找到"，**不要编**
3. 涉及 asset 的回答，必须给出 asset_path 全路径
4. 答案先给结论，再给推理依据，最后列引用
5. 中英文按用户问题语言回答
```

跟 §25 anti-fab 同一套思路：物理上不让 LLM 编造（输入里没有的东西它也提不到 asset_path）。

---

## §6 生成 pipeline（**OpenAI-compat 鲁棒性是这一段的命门**）

### 6.1 复用 `call_llm`

`backend/main.py` 已有的 `call_llm` 路径：
- 沿用 §22 之后的 OpenAI-compat 7 层提取兜底
- 沿用 `with_raw_response.create()` 拿原始 HTTP body
- 沿用 stream-mode fallback 应对 Responses API 后转换 bug

新增的 `qa_router.py` **不要**自己写 LLM 调用——必须走 `call_llm`，否则商用 user 用奇葩 proxy 时 RAG 回答会变空字符串（§22 趟过的坑）。

### 6.2 SSE 流式协议

```python
# backend/rag/qa_router.py
@app.post("/api/v1/qa")
async def qa(req: QARequest):
    async def event_stream():
        # 1. 检索
        yield sse({"type": "retrieval_start"})
        chunks = await retriever.search(req.query, k=5)
        yield sse({"type": "retrieval_done", "citations": [
            {"id": c.id, "title": c.title, "asset_path": c.asset_path,
             "relative_path": c.relative_path, "chunk_kind": c.chunk_kind}
            for c in chunks
        ]})

        # 2. 生成（流式）
        prompt = build_prompt(req.query, chunks)
        async for delta in call_llm_stream(prompt, provider_config=req.provider_config):
            yield sse({"type": "token", "delta": delta})

        yield sse({"type": "done"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

**前端**：AIChat 拿 `EventSource` 或 `fetch` + ReadableStream 接 SSE，按 `type` 分发：
- `retrieval_start` → 显示 "正在检索..."
- `retrieval_done` → 把 citations 渲染成 chip 排在答案上方
- `token` → 累加到答案文本
- `done` → 隐藏指示器

### 6.3 OpenAI-compat 流式陷阱（**预警**）

§22-§24 已经验证：
- Chat Completions stream 是大多数 proxy 的稳定路径
- 但有些 proxy 把 stream 路由到 Responses API 内部转换，可能把 `delta.content` 弄丢
- `call_llm_stream` 必须沿用 `_analyze_via_stream` 的逻辑（多字段 fallback：`delta.content` / `delta.text` / `delta.reasoning_content` 等都尝试拼接）

**测试矩阵**（C0 验收前必跑）：
- Anthropic 直连 → 应该一次过
- DeepSeek 官方 OpenAI-compat → 已知工作
- 用户后续接的代理 → 至少 2 个第三方 proxy 验证

---

## §7 工具调用（C1，不在 C0）

### 7.1 工具 schema

```python
TOOLS = [
    {
        "name": "search_narrative",
        "description": "Hybrid (BM25 + bge-m3 dense) search over vault chunks. Use for conceptual questions ('how does X work', 'what's the pattern for Y').",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "get_callers",
        "description": "Get the list of blueprints that call into the given asset (BFS reverse adjacency, depth ≤ 2). Use for 'who calls X' / 'impact analysis'.",
        "parameters": {
            "type": "object",
            "properties": {"asset_path": {"type": "string"}, "max_depth": {"type": "integer", "default": 2}},
            "required": ["asset_path"],
        },
    },
    # get_callees / get_system_members / read_section 同理
]
```

### 7.2 Agent loop

```python
async def run_agent(query: str, max_iter: int = 6):
    messages = [{"role": "system", "content": AGENT_PROMPT}, {"role": "user", "content": query}]
    for step in range(max_iter):
        resp = await call_llm_with_tools(messages, TOOLS)
        if resp.stop_reason == "end_turn":
            return resp.content
        for tool_call in resp.tool_calls:
            result = await dispatch_tool(tool_call.name, tool_call.args)
            messages.append({"role": "tool", "tool_call_id": tool_call.id, "content": result})
    raise AgentMaxIterations(...)
```

**OpenAI-compat 注意**：tool calling 协议在 compat 代理上变种更多——有的代理只支持 OpenAI tools API、有的只支持 Anthropic tool_use blocks。C1 启动时第一周专门 spike 一个"compat tool calling 兼容性扫描"，跟 §22 经验一脉相承。

---

## §8 增量索引（C3）

详细算法见 §4.4。落地点：

```python
# backend/rag/incremental.py
async def reindex_changed(project_root: str):
    current = scan_vault_hashes(project_root)             # {(rel_path, ast_hash)}
    indexed = db.fetch_all_hashes()                        # {(rel_path, ast_hash)}
    to_add = current - indexed
    to_drop = indexed - current

    # rename：检查 ast_hash 不变但 rel_path 变的，不重新嵌入只更新元数据
    rename_pairs = detect_renames(to_add, to_drop)
    to_add -= {(p, h) for _, p, h in rename_pairs}
    to_drop -= {(p, h) for p, _, h in rename_pairs}

    with db.transaction():
        db.update_paths_for_renames(rename_pairs)
        db.delete_chunks_by_path([p for p, _ in to_drop])
        new_chunks = build_chunks_for_paths([p for p, _ in to_add])
        db.insert_chunks(new_chunks)
```

钩子：
- `POST /api/v1/scan/batch` 完成 callback → enqueue 受影响 path 列表
- 用户手动点 reindex → 全跑 `reindex_changed`

---

## §9 4 期里程碑 + 验收

### Phase C0 — MVP（5-7 天）

| 子任务 | 文件 | 验收 |
|---|---|---|
| 切块器 | `backend/rag/chunker.py` | 跑 76 文件 → 输出 ~250 chunks，5 类齐全；snapshot 测试 |
| Embedder | `backend/rag/embedder.py` | bge-m3 加载成功；250 chunks 编码 < 30s（CPU） |
| Store | `backend/rag/store.py` | sqlite-vec + FTS5 表建好；插入/查询都过；reindex idempotent |
| Retriever | `backend/rag/retriever.py` | hybrid search top-5 出结果；RRF 合并正确；多样性 rebalance 工作 |
| QA endpoint | `backend/rag/qa_router.py` + `backend/main.py` mount | `POST /api/v1/qa` SSE 流式工作；引用注入完整 |
| Reindex CLI | `backend/rag/index_vault.py` | `python -m backend.rag.index_vault <project_root>` 全量重建 |
| AIChat 重写 | `UE_mapping_plugin/src/components/chat/AIChat.tsx` | 接 SSE；引用 chip 可点击跳 Lv2；流式逐字显示 |
| 索引状态 UI | Settings 面板加 "RAG index" 区 | 显示 chunk count / 上次索引时间 / Rebuild 按钮 |

**完成判断**：
- 问 "BP_Villager 是干啥的" → 带 3-5 引用的答案，至少命中 BP_Villager#header / #narrative
- 问 "存档系统怎么工作" → 命中 BP_GI / BP_GM / BPI_GI / Systems/persistence.md 多个 chunk，answer 综合
- 引用 chip 点击跳到对应 Lv2 文件

### Phase C1 — Tool calling（4-5 天）

| 子任务 | 验收 |
|---|---|
| 工具 schema 定义（5 个） | OpenAI tool format 正确；compat proxy 接受 |
| Agent loop（max_iter=6） | 防失控测试通过 |
| `get_callers` 等 4 个图工具复用现有 endpoint | 不重复实现；返回格式跟 search_narrative 一致 |
| **OpenAI-compat tool calling spike** | 至少 2 个第三方代理 + Anthropic 都跑通；不通的代理降级到 C0 单轮路径 |
| 多轮 SSE 协议（中间步骤可视化） | 前端能看到 "调用了 get_callers(BPI_GI)" 这种中间提示 |

**完成判断**：问 "如果我改 BP_Villager.Eat 会影响什么" → agent 自动 chained `get_callers` + `search_narrative`，答案带影响清单。

### Phase C2 — Reranker + Eval（3-4 天）

| 子任务 | 验收 |
|---|---|
| bge-reranker-v2-m3 集成（top-30 → top-5） | 加载成功；CPU 上 200ms 内 |
| Eval harness：30-50 对 Q&A 手工策划 | 覆盖 narrative / 图查 / 配置查三类问题 |
| recall@5 + LLM-as-judge answer quality | recall@5 ≥ 0.85；judge avg ≥ 4/5 |
| 切块边界 / 召回数 / 引用数 调优 | 跟基线（无 reranker）对比 ≥ 10% recall 提升 |

### Phase C3 — 增量 + 集成（2-3 天）

| 子任务 | 验收 |
|---|---|
| ast_hash 增量索引 | 改一个 BP 重扫 → 只重嵌该文件 chunks；< 5s |
| 钩 scan/batch 完成事件 | 扫描完自动 reindex；无需用户点按钮 |
| Vault 删文件 → chunk 软删 | 删 BP → 下次问该 BP 不再召回 |
| reindex 进度 SSE 推前端 | 实时进度条 |

---

## §10 文件 / 模块清单

### 10.1 新建（backend）

```
backend/rag/
├── __init__.py
├── chunker.py            # 5 类 chunk 切分
├── embedder.py           # bge-m3 包装
├── store.py              # sqlite-vec + FTS5 schema + CRUD
├── retriever.py          # BM25 + dense + RRF + 多样性
├── reranker.py           # bge-reranker-v2-m3（C2）
├── qa_router.py          # /api/v1/qa SSE endpoint（C0）
├── agent.py              # tool-calling loop（C1）
├── tools.py              # 5 个工具 schema + dispatcher（C1）
├── index_vault.py        # CLI + /api/v1/rag/reindex endpoint
├── incremental.py        # 增量索引（C3）
├── prompts.py            # SYSTEM_PROMPT_QA + AGENT_PROMPT 集中
└── eval/
    ├── __init__.py
    ├── qa_dataset.json   # 30-50 对手工 Q&A（C2）
    └── run_eval.py       # recall@5 + LLM-judge（C2）
```

### 10.2 修改（backend）

| 文件 | 改动 |
|---|---|
| `backend/main.py` | mount `from rag import qa_router, index_vault`；扫描完成钩子 enqueue 增量 reindex（C3） |
| `backend/requirements.txt` | + `sentence-transformers`、`sqlite-vec`、`rank-bm25`（如不用 FTS5）；锁版本 |

### 10.3 修改（frontend）

| 文件 | 改动 |
|---|---|
| `UE_mapping_plugin/src/components/chat/AIChat.tsx` | 完整重写：去 stub，接 `/api/v1/qa` SSE，加 citation chip 渲染 + 跳转 |
| `UE_mapping_plugin/src/services/qaApi.ts` | 新建：SSE 客户端 + types |
| `UE_mapping_plugin/src/components/settings/SettingsModal.tsx` | 加 "RAG Index" 区：chunk count / last reindex / Rebuild 按钮 |
| `UE_mapping_plugin/src/store/useRAGStore.ts` | 新建：索引状态 + reindex action |

### 10.4 配置 / 数据

| 路径 | 用途 |
|---|---|
| `.aicartographer/rag_index.db` | sqlite 数据库（已 gitignore，per-project） |
| `.aicartographer/models/BAAI/bge-m3/` | embedding 模型缓存（首次下载） |
| `.aicartographer/models/BAAI/bge-reranker-v2-m3/` | 重排模型缓存（C2） |

`.gitignore` 已经把 `.aicartographer/` 整个排除掉，无需新增。

---

## §11 依赖

```
# backend/requirements.txt 新增
sentence-transformers==3.3.1     # bge-m3 / reranker 加载，已有大量稳定版本
sqlite-vec==0.1.6                # vec0 虚表
# rank-bm25 不必要——SQLite FTS5 内置 BM25
torch>=2.1                       # sentence-transformers 依赖；CPU-only 即可
```

**安装大小估计**：torch CPU 约 200MB，sentence-transformers 几十 MB，bge-m3 模型本身 ~1.2GB（首次运行下载）。**总磁盘占用 ~1.5GB**，需要在 README 明示。

**禁忌**：
- 不要装 `chromadb` —— 会拽进 50+ 间接依赖
- 不要装 `langchain` / `llama-index` —— 抽象层太厚，配 §6.3 的 compat 怪癖会被框架挡住
- 不要装 `faiss-cpu` —— sqlite-vec 已经够用，多一个本地索引格式没意义

---

## §12 测试与评测

### 12.1 单元测试（C0）

- `tests/test_chunker.py`：snapshot 测试 76 个文件的切块边界稳定
- `tests/test_retriever.py`：固定 query → 期望 chunk_id 命中
- `tests/test_qa_endpoint.py`：mock `call_llm`，验证 SSE 协议格式

### 12.2 评测（C2）

`backend/rag/eval/qa_dataset.json` 草稿（具体问题在 C2 阶段细化）：

```json
[
  {
    "id": "narrative_1",
    "query": "村民系统的工作流程是什么？",
    "expected_citations": ["BP_Villager", "BTT_DefaultBT", "BTT_Work", "BPI_Villager"],
    "kind": "narrative"
  },
  {
    "id": "graph_1",
    "query": "BPI_GI 都被谁调用？",
    "expected_citations": ["BP_BaseCrop", "BP_BuildingBase", "BP_GI", "BP_GM", "BP_Player", "BP_Villager", "UI_EndGame", "UI_MainMenu", "UI_Pause"],
    "kind": "graph"
  },
  {
    "id": "config_1",
    "query": "小麦的生长时间在哪里配置？",
    "expected_citations": ["BP_Crop_Wheat", "BP_BaseCrop"],
    "kind": "config"
  }
]
```

**评测指标**：
- `recall@5`：top-5 结果包含 expected_citations 中至少一个的比例
- `mrr`（mean reciprocal rank）：第一个相关结果的倒数排名
- `answer_quality`：LLM-as-judge 0-5 分（判模型用 Anthropic Sonnet 4.6 + adaptive thinking 单独打分）

---

## §13 风险登记 + 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|:-:|:-:|---|
| **OpenAI-compat tool calling 在某些 proxy 不兼容** | 高 | 高 | C1 第一周专门 spike；不通的代理降级到 C0 单轮 |
| **bge-m3 模型下载失败（防火墙）** | 中 | 高 | 提供镜像源（HF mirror）+ 离线包；README 明示 |
| **首次索引太慢用户放弃** | 中 | 中 | UI 显示进度；建议先扫小 demo；后台跑不阻塞 |
| **sqlite-vec 在大 vault（>5000 chunks）变慢** | 低 | 中 | 升 lancedb（决策 #2 已留路）；也可以 add IVF index |
| **生成模型把不在引用里的 asset_path 编出来** | 中 | 高 | prompt 强约束 + 后置审计（仿 §25 audit_vault.py） |
| **NOTES 段含敏感内容（API key 草稿等）被检索出 → cloud LLM 暴露** | 低 | 高 | embedding 是本地，生成走用户 provider；user 配置 cloud LLM 是知情同意 |
| **AIChat 现有 history / 离线降级逻辑被推平** | 中 | 低 | 重写时保留 BackendOfflineCard 路径 |

---

## §14 跨 session 交接清单

**当下次新 session 接手 Phase C 时按这个顺序读：**

1. 本文 §1（决策锁定） + §2（设计前提） + §3（架构）
2. `HANDOFF.md` §22-§24（OpenAI-compat 鲁棒性教训——决策 #5 的来源）
3. `HANDOFF.md` §25（anti-fab 审计——RAG 答案的 cite 强制设计同款思路）
4. `backend/main.py` 现有 `call_llm` + `_extract_metadata_block` + `_analyze_via_stream`（生成路径必须复用这些）
5. `backend/main.py` `_build_calltrace_index` + `/api/v1/calltrace`（C1 工具会复用）

**先跑哪些验证：**

```bash
# 1. 当前 vault 还在
ls D:/Traeproject/UEMapping/.aicartographer/vault/Systems/*.md | wc -l   # 期望 ≥ 14

# 2. /api/v1/calltrace 还工作（C1 工具基础）
curl "http://localhost:8000/api/v1/calltrace?project_root=D:/Traeproject/UEMapping&root_asset_path=/Game/Blueprint/Core/Save/BPI_GI.BPI_GI&direction=inbound&max_depth=2"

# 3. call_llm 能跑（任何 provider）
# 在 UE 编辑器里点一次 Deep Reasoning 看是否成功

# 4. AIChat 当前能不能正常显示（要重写它，先确认现状）
```

**第一个 commit 期望长这样：**

```
feat(rag/C0): scaffold backend/rag + chunker + embedder + sqlite-vec store

- backend/rag/{chunker,embedder,store,index_vault}.py 落位
- 76 文件 → 250 chunks 切块快照测试通过
- bge-m3 首次下载到 .aicartographer/models/
- POST /api/v1/rag/reindex 全量重建工作
- 暂不接 retriever / qa_router（下个 commit）
```

之后按 §9 的 C0 子任务表逐个 commit。

**绝对不要做的事：**
- ❌ 装 langchain / llama-index / chromadb（§11 已禁忌）
- ❌ 自己写 LLM 调用，绕开 `call_llm`（决策 #5）
- ❌ 切块按 token 数硬切（§4.1 已说明）
- ❌ 把 bge-m3 模型加到 git（已 gitignore，不要绕开）
- ❌ 跳过 OpenAI-compat 兼容性测试（§13 头号风险）

---

## §15 下一步

User greenlight 之后的第一个 worktree session：

1. 安装依赖 `pip install sentence-transformers sqlite-vec`（+ 国内镜像源 `--index-url`）
2. 实现 `backend/rag/chunker.py`，跑 snapshot 测试
3. 实现 `backend/rag/embedder.py`，确认 bge-m3 下载 + 编码可工作（CPU）
4. 实现 `backend/rag/store.py`，建表 + 单元测试 insert/search
5. 单 commit：scaffold + chunker + embedder + store

**问 user：什么时候动？** 当前 worktree 还有 inbound CallTrace + QuickSwitcher 两块没 push（commit `9388bf7`），需要先 push 还是直接进 C0？
