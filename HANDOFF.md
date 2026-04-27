# AICartographer 项目交接文档

> 最后更新：2026-04-27（晚晚段 — 中文化 + LLM 提示词改造）
> 上一段对话已被 /compact 压缩，这份文档把工程状态、架构、未完成任务一次性交给下一个 session。
> **从下到上读**：§13/§14 是最新增量，§1-§12 是历史交接。新 session 先看 §14。

---

## 1. 项目目标

**AICartographer** 是一个用于可视化 UE5 蓝图工程的 IDE 内嵌插件。它把 LLM 抓取的图谱以分层视图呈现在 UE 编辑器内，让开发者能在编辑蓝图的同时浏览系统级关系、节点详情和函数级执行流。

三个进程共同构成产品：

| 组件 | 路径 | 角色 |
| --- | --- | --- |
| C++ UE5 插件（CEF 宿主） | `D:\Traeproject\UEMapping\Plugins\AICartographer\` | 在编辑器里嵌入 SWebBrowser，通过 BindUObject 暴露 `AICartographerBridge` 给前端 JS |
| React 前端 | `D:\Traeproject\UEMapping\UE_mapping_plugin\` | Vite + ReactFlow + d3-force，提供 Lv0–Lv3 的视图、AIChat 和 Settings |
| Python FastAPI 后端 | `D:\Traeproject\UEMapping\backend\` | LLM 扫描流水线、笔记落盘、backlinks 重建、健康检查 |

桥优先级：bridge 可用就走 bridge（无需启动 Python），否则降级到 `localhost:8000` HTTP。

---

## 2. 前端视觉目标

四级视图，分别对应不同的认知颗粒度：

- **Lv0 CardWall** — 工程总览，大卡片墙列出所有系统/节点；进入 Lv1。
- **Lv1 SystemGraph** — 单个 System 内部的有向图（d3-force 力导向布局）。节点拖动后位置会持久化（ReactFlow 内部 state），边按 type 着色（function_call / interface_call / cast / spawn / listens_to / fallback）。Header 内带「当前实际出现的 edge type」图例。点击节点跳到 Lv2。
- **Lv2 BlueprintFocus** — 单个蓝图详情页：右侧是 Notes 编辑、Metadata（AST hash / scan_at / model）；中央列出 Exports（functions / events / dispatchers）和 Edges。点击 Function 跳到 Lv3。
- **Lv3 FunctionFlow** — 单个蓝图函数的内部执行图，由 C++ bridge `ReadBlueprintFunctionFlow` 直接读 UEdGraph 抽出节点和 pin 关系，再用 ReactFlow 渲染。kind 决定颜色（事件红、调用蓝、分支棕、cast 绿），exec 边动画。

辅助视图：
- **AIChat**：右下浮窗，连后端 LLM；在 bridge-only / 后端离线时降级展示 BackendOfflineCard 而不是报错。
- **SettingsModal**：项目根、桥状态、Rebuild backlinks（仅在后端可达时）、Rebuild MOCs（仅在 bridge writeFile 可用时）。

---

## 3. 后端需求（FastAPI）

后端已存在的 endpoint（`backend/main.py`）：
- `GET /api/health` — 返回版本 + redis 可用性
- `GET /api/v1/vault/list?project_root=…` — 列出 vault 下的 .md 文件 + manifest
- `GET /api/v1/vault/read?project_root=…&relative_path=…` — 返回 frontmatter + 正文
- `PUT /api/v1/vault/notes` — 仅写 NOTES 区段（用户笔记）
- `POST /api/v1/vault/rebuild-backlinks?project_root=…` — 重建反链
- `POST /api/v1/scan/batch` — LLM 扫描入口（需要 asset_path 列表）
- `GET /api/v1/scan/status/{scan_id}` — 轮询扫描状态

**关键约束**：后端写出的 frontmatter 是嵌套结构（`scan: {ast_hash, scanned_at, ...}`、`exports: {functions, events, ...}`、`type: Blueprint`），但前端历史代码读的是扁平字段（`ast_hash`, `scan_at`, `node_type`）。已通过 `normalizeFrontmatter()` 适配，见下文。

**后端 .env**：`OPENAI_API_KEY` 配置在服务端，前端永远不持有。

---

## 4. C++ Bridge 协议

`Plugins/AICartographer/Source/AICartographer/Public/AICartographerBridge.h` 暴露的 UFUNCTION 全部走 BindUObject 让前端 JS 调用（命名会被 CEF 小写化）：

已实现：
- `ListVaultFiles(ProjectRoot)` → JSON 字符串（list 同 HTTP）
- `ReadVaultFile(ProjectRoot, RelativePath)` → JSON `{content, frontmatter}`
- `WriteVaultFile(ProjectRoot, RelativePath, Content)` → JSON `{ok}` ✱新增
- `WriteVaultNotes(ProjectRoot, RelativePath, Content)` → 仅追加 NOTES 段
- `ReadBlueprintFunctionFlow(AssetPath, FunctionName)` → JSON `{nodes, edges}` ✱新增
- `RequestDeepScan(AssetPath)` — 当前是 C++ 的 broadcast 模式，前端 JS **订阅不到**（这是下一步要解决的核心问题）

**重要限制**：UE Live Coding 不能注册新的 `UCLASS / UPROPERTY / UFUNCTION`。每次新加 UFUNCTION 必须**关 UE → 用 VS / Rider 重新构建 AICartographer 模块 → 重新打开编辑器**。SettingsModal 的桥状态行会展示 `partial`（找到桥但缺方法）以提示需要 rebuild。

桥探测路径（`bridgeApi.ts`）：会扫一组候选 window 全局名（如 `AICartographerBridge`、`ueBridge` 等），首次匹配命中就缓存。

路径安全：所有写文件接口必须先 normalize 绝对路径，再 startsWith ProjectRoot 校验，防 traversal。

---

## 5. 已完成的工作

依时间顺序：

1. **AIChat 后端离线降级**（`src/components/chat/AIChat.tsx`）
   - `useEffect` 挂载时探 `/api/health`，得 `online | offline | checking`
   - 发消息中途 500 时翻成 offline
   - `BackendOfflineCard` 区分 bridge-only 文案 vs 完全无后端的文案，带 retry 按钮

2. **Lv3 FunctionFlow 实现**
   - `Plugins/AICartographer/.../AICartographerBridge.cpp::ReadBlueprintFunctionFlow`：清理 `/Game/` 前缀 → 加载蓝图 → 找 FunctionGraphs，找不到再扫 UbergraphPages 的 K2Node_Event → 序列化节点（`ClassifyNodeKind` 分 function_call/custom_event/event/class）和 pin（`PinType.PinCategory == "exec"` → `isExec=true`）→ 边只从输出 pin 发出避免重复
   - `bridgeApi.ts`：新增 `BridgeFunctionFlow*` 类型 + `bridgeReadFunctionFlow` + `isFunctionFlowAvailable()`
   - `Lv3FunctionFlow.tsx`：完全重写，坐标平移 + 0.5/0.6 缩放，按 kind 着色，exec 边动画

3. **MOC 自动生成**（`src/services/mocGenerator.ts` 是新建文件）
   - `rebuildSystemMOCs(projectRoot)`：遍历 vault，跳过 `_systems/` 和 `_meta/`，按 `system/X` tag 分组，生成 markdown，通过 `bridgeWriteVaultFile` 写到 `_systems/{system}.md`
   - `SettingsModal` 加按钮，仅在 `isVaultFileWriteAvailable()` 为 true 时显示

4. **Lv1 d3-force 力导向布局**（`Lv1SystemGraph.tsx`）
   - 替换原 radial 布局；引入 d3-force（forceLink/ManyBody/Center/Collide），跑 240 tick 收敛
   - 边按 (source,target,type) 去重
   - **第一次反馈后**：移除边上的 label（密集图上互相遮挡），改成 header 里的色块图例；图例只列「当前实际出现的 type」
   - **参数调优**（小图密图避免堆叠）：linkDistance 220，repulsion -800，collide 95，opacity 0.75
   - 拖拽位置在 store 里持久化（`useNodesState` 的 posById 合并）

5. **关键 Bug 修复 — Schema 不匹配**（`src/utils/frontmatter.ts` + `src/services/vaultApi.ts`）
   - 现象：Lv2 看不到 Exports 区块，Metadata 里 AST hash / scan time 一直显示 `—`
   - 根因：后端写 `exports.functions`、`scan.ast_hash`、`type: Blueprint`，前端读 `exports_functions`、`scan_at`、`node_type`
   - 解法：新增 `normalizeFrontmatter(fm)` 适配器（嵌套 → 扁平），在 `vaultApi.readVaultFile` 的 bridge 和 HTTP 两条分支都套一层。`parseFrontmatter` 也调用它，所以本地解析也走规范化路径

构建验证：`tsc --noEmit` 干净，`vite build` → 438.44 kB / gzip 133.34 kB。

---

## 6. 当前未提交的改动

`git status` 显示从 initial commit 之后所有工作都还没 commit。删除的旧文件包括 `App.css`、`graph/*`、`layout/Sidebar.tsx` 等，新增的有 `components/{chat,levels,notes,search,settings,shell}/` 和 `services/{bridgeApi,mocGenerator}.ts`。**新 session 启动前可以考虑先 `git commit` 一次保留快照。**

---

## 7. 即将进行的任务

用户的核心诉求是「**开始实际测试真的 UE 项目**」。当前 demo vault 的限制：
- 节点的 `asset_path` 不指向真实 .uasset，所以 Lv3 桥调用没有可读对象
- 没有真实 `exports.functions` 数据用来按按钮跳 Lv3
- 系统 tag 散布够用来验证 #3 #4

所以路径有两条：

### Option A — 用 demo vault 验证 #3 #4（已可立即测）
1. 启动 UE 编辑器，进入插件面板
2. Settings → Project root 填 `D:/Traeproject/UEMapping/backend/__demo_vault`
3. 点 Save → loadIndex
4. 打开 Lv1：观察 d3-force 布局 + 图例
5. Settings → Rebuild MOCs：观察是否在 `_systems/` 下生成 markdown

### Option B — 把扫描链补完（必须做，否则 #2 真项目测不了）

这是新 session 要主攻的方向。预计 1-2 小时。

**步骤**：

1. **C++ 端：让 `RequestDeepScan` 同步返回 JSON**
   - 当前 `RequestDeepScan` 是 broadcast 模式，JS 收不到
   - 改成同步：函数体里直接抓 BP AST hash + 必要 metadata，序列化成 JSON 返回
   - 文件：`Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp`
   - 同时在 `.h` 改 UFUNCTION 签名（注意：又要重新 build 一次模块）

2. **新增桥 wrapper**（`src/services/bridgeApi.ts`）
   - `bridgeListBlueprintAssets(projectRoot)` — 列出工程里所有 BP 资产路径
   - `bridgeRequestDeepScan(assetPath)` — 同步返回该资产的 AST hash + 基础元数据
   - `isDeepScanAvailable()` 探测

3. **「Scan project」UI 编排**
   - 位置：`SettingsModal` 加新按钮，或者起个新组件 `ScanOrchestrator`
   - 流程：
     1. `bridgeListBlueprintAssets` → 拿到 N 个资产路径
     2. 并发（限流 8）`bridgeRequestDeepScan` 每个资产 → 收集 `{asset_path, ast_hash}[]`
     3. POST 一次 `/api/v1/scan/batch` 把列表发给后端 LLM 流水线
     4. 用 returned `scan_id` 轮询 `/api/v1/scan/status/{scan_id}`，进度条展示
     5. 完成后 `loadIndex()` 刷新 vault
   - UI 要有「正在扫描 12/45」之类的进度反馈，错误要能展开看哪个资产失败

4. **真项目验证**
   - 让用户在自己的 UE 项目里跑一遍
   - Lv1 / Lv2 / Lv3 全链路点一遍
   - 出问题贴日志回来调

### 后续（Option B 完成后）
- Lv0 CardWall 的搜索/过滤
- AIChat 真接 LLM 上下文（把当前打开的 Lv2/Lv3 节点喂进去）
- Notes 双向同步（编辑 → 保存 → 触发 backlinks 重建）
- 桥状态变化的实时 UI 反馈（partial → ready 时自动隐藏 banner）

---

## 8. 关键文件速查

| 文件 | 角色 |
| --- | --- |
| `UE_mapping_plugin/src/components/levels/Lv1SystemGraph.tsx` | d3-force + 边图例 |
| `UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx` | Exports 列表 + 跳 Lv3 |
| `UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx` | ReactFlow + 桥 ReadBlueprintFunctionFlow |
| `UE_mapping_plugin/src/services/bridgeApi.ts` | 所有桥 wrapper + 探测 |
| `UE_mapping_plugin/src/services/vaultApi.ts` | HTTP/Bridge 双通路 + normalizeFrontmatter |
| `UE_mapping_plugin/src/services/mocGenerator.ts` | MOC 聚合写入 |
| `UE_mapping_plugin/src/utils/frontmatter.ts` | YAML 子集解析 + 嵌套→扁平规范化 |
| `UE_mapping_plugin/src/components/settings/SettingsModal.tsx` | 项目根 + 桥状态 + MOC 按钮 |
| `Plugins/AICartographer/.../AICartographerBridge.h/cpp` | UFUNCTION 暴露层 |
| `Plugins/AICartographer/Resources/WebUI/index.html` | CEF 装载入口 |
| `backend/main.py` | FastAPI 路由 |
| `backend/__demo_vault/.aicartographer/vault/` | demo 数据，可作 Option A 测试源 |

---

## 9. 启动新 session 时的建议（旧）

1. 先 `git add -A && git commit -m "WIP: Lv1-3 + bridge schema fix"` 把当前进度快照固化
2. 决定走 A 还是 B（用户已倾向 B）
3. 走 B 的话先动 C++（因为要 rebuild），动完 .h/.cpp 让用户在 UE 里 build；同时前端可以把 UI 编排和桥 wrapper 写好等桥就绪后无缝接上
4. 不要碰 LLM key、不要 force push、不要跳 hooks

---

## 10. Session 2026-04-27（晚段）— Markdown 浏览模式 + LLM 厂商接入

> 上一次交接结束后，commit `02fb364` 完成了 Option B 的 Scan 链路（C++ enumerate + AST hash + LLM batch orchestrator）。本次 session 在它之上做了三件事：①双视图模式 ②L1 markdown 视图 ③多厂商 LLM 接入。本节是基于上面 1-9 节的增量，没改的东西不重复说。

### 10.1 双视图模式（活动栏第 4 个图标）

需求：L1/L2 同时支持「纯 markdown 文本浏览」和「力向图浏览」，模式切换时同一个 Tab 重渲。L3 始终是图（没有对应 markdown）。

实现：
- `useUIStore.ts` 加 `viewMode: 'markdown' | 'graph'`，写 localStorage 持久化
- `ActivityBar.tsx` 在 Files / Graph 之间插入 MarkdownIcon；Graph/Markdown 互斥高亮
- `AppShell.tsx` 的 `renderLevel(loc, viewMode)` 按模式分派 L1/L2 到不同组件
  - `<ErrorBoundary key={`${loc.kind}-${viewMode}`}>` 让模式切换强制重挂载
- 所有力向图节点（Lv1/Lv2/Lv3）统一换成 `components/graph/TagNode.tsx`：节点顶部加一条「类型 tag 条」，颜色区分 events/functions/Blueprint/External 等

### 10.2 L1 系统级 markdown（系统简介页）

文件：`Lv1SystemMarkdown.tsx`（新建）+ `frameworkScan.ts`（系统级 .md 写入逻辑）

- 读 `Systems/<id>.md`，渲染由 framework-scan 生成的骨架：
  - `## [ INTRO ]`（占位，等 LLM 补）
  - `## [ SUBSYSTEMS ]`（按文件夹分组的 BP 列表）
  - `## [ MEMBERS ]`（全部 BP 表）
  - `## [ NOTES ]`（用户笔记，跨次扫描保留）
- 复用 MiniMarkdown + NotesEditor；点击相对路径链接走 in-shell 跳转（不会出 webview）
- 没扫描过时显示「请运行 framework scan」的引导

### 10.3 LLM 多厂商抽象（核心改动）

之前后端是写死 ARK_API_KEY + 单 client 的。这次重构：**用户在前端输入 key，每个请求自带 key 走，后端不持久化任何凭据**。

#### 后端

新文件 `backend/llm_providers.py`：
- `LLMProvider` ABC，两个实现：`VolcengineProvider`（沿用 OpenAI SDK，base_url 指 ark.cn-beijing.volces.com）+ `ClaudeProvider`（Anthropic AsyncAnthropic SDK）
- `EFFORT_TO_BUDGET = {low:0, medium:4096, high:16384, extra_high:32768, max:65536}` 把 effort 字符串映射为 extended-thinking 的 `budget_tokens`
- ClaudeProvider 处理 SDK 怪癖：开 thinking 时 `temperature` 必须 = 1，`max_tokens` 必须 > budget
- `build_provider(config_dict)` 工厂；`mask_key(key)` 给日志脱敏

`backend/main.py` 大改（v2.0.0）：
- 移除模块级 `client` 和 `ARK_API_KEY` 环境变量依赖
- `BatchScanRequest` / `SingleScanRequest` / `TestConnectionRequest` 都加 `provider_config: ProviderConfig` 字段
- `process_batch_ast_task` 收到 dict 后即时 `build_provider`，每节点处理在该 provider 上跑
- 新增 `analyze_one_node(provider, node, project_root)` 共享辅助函数，被 batch worker 和 `/scan/single` 同时调用
- 新增端点：
  - `POST /api/v1/llm/test-connection` — 30s 超时 ping 一次
  - `POST /api/v1/scan/single` — 单节点同步分析（给 Lv2 的 Deep reasoning 按钮用）
- 鲁棒性：
  - tenacity 退避重试（4 次，1-30s 指数）
  - `asyncio.wait_for(provider.analyze(...), timeout=90)` 单节点硬超时
  - `asyncio.Semaphore(concurrency)` 限流，默认 20 / 上限 64
  - log 里 key 用 `mask_key()` 脱敏

`requirements.txt` 新增 `anthropic>=0.40` 和 `tenacity>=9.0`。

#### 前端

新文件：
- `store/useLLMStore.ts` — Zustand + localStorage（key `aicartographer.llm.config`）；提供 `getProviderConfig()` 返回后端 payload；`clearAll()` 清空全部凭据
- `components/settings/LLMProviderPanel.tsx` — Settings 模态里的子面板：
  - 厂商 tab 切换（Volcengine / Claude）
  - Volcengine：endpoint id + api key
  - Claude：api key + 模型单选（opus / sonnet / haiku） + effort 五档（low / medium / high / extra_high / max）
  - 全局并发滑条（1-64）
  - 「Test connection」按钮 + 「Clear all credentials」按钮

修改：
- `services/scanApi.ts` — 加 `ProviderConfigPayload` / `postSingleScan` / `postTestConnection`；`ScanBatchRequest` 现在必填 `provider_config`
- `components/settings/SettingsModal.tsx` — 删旧的「服务端 .env API key」段，加 `<LLMProviderPanel />`
- `components/settings/ScanOrchestrator.tsx` — 从 useLLMStore 读 provider config；没填全时禁用按钮；状态条显示「via {provider}」
- `components/levels/Lv2BlueprintFocus.tsx` — 头部加「Deep reasoning」按钮：调 `postSingleScan` 把 frontmatter 当 ast_data 发给后端单节点端点；成功后失效缓存 + 刷新当前文件；带 skeleton/llm 状态 pill

CSS（`theme/components.css`）：新增 `.llm-panel*`、`.llm-provider-tab*`、`.llm-radio-card*`、`.llm-effort-btn*`、`.llm-concurrency-row`、`.tag-node*`、`.bp-graph*`、`.deep-reason-btn*`、`.pill-analysis-{skeleton,llm}`。

### 10.4 验证状态

- `tsc --noEmit` 干净
- `vite build` → 489 kB / gzip 146 kB
- `python -m py_compile backend/main.py backend/llm_providers.py` OK
- 手动测试：用户在 UE webview 里点了 Settings → Test connection → **通了**，又点 batch scan **触发了 Redis 兼容性 bug（见下节 11）**

---

## 11. ⚠️ 已知 Bug — Redis 3.0 不支持多字段 HSET（高优先级）

### 现象

POST `/api/v1/scan/batch` 立即 500：

```
redis.exceptions.ResponseError: wrong number of arguments for 'hset' command
```

trace 指向 `main.py:326` 和 `main.py:563`。

### 根因

仓库自带的 Redis 是 `D:\Traeproject\UEMapping\Redis-x64-3.0.504\`（Microsoft 官方 Win 端口，**2016 年后没更新**）。Redis 3.0 的 `HSET` 命令只接受 `HSET key field value` 三个参数；多 field/value 必须用 `HMSET`。

但 redis-py 7.x 的 `hset(name, mapping={...})` 编译成单条 `HSET key f1 v1 f2 v2 ...`（这是 Redis 4.0+ 才支持的语法），Redis 3.0 收到就报「wrong number of arguments」。

涉及位置：
- `backend/main.py:326` — `process_batch_ast_task` 初始化 task hash
- `backend/main.py:563` — `create_batch_scan_task` endpoint 创建 task hash
- `backend/main.py:573` — `create_batch_scan_task` 初始化 per-node 状态 hash

注意：`hset(name, key, value)` 三参形式（line 310, 311, 349, 356, 368, 375, 398）**不受影响**，那些点正常工作。

### 修复方案（按推荐度）

**A. 改成 pipeline + 单字段 hset（推荐，零依赖变更）**

把三处 `hset(..., mapping={...})` 改成：

```python
async with redis_client.pipeline(transaction=False) as pipe:
    for k, v in mapping_dict.items():
        pipe.hset(name, k, v)
    await pipe.execute()
```

- 一次往返，原子性比原方案弱但本场景不依赖原子
- 兼容 Redis 3.0 / 4.0 / 5.0+
- 不依赖已弃用的 `hmset`

**B. 用 `hmset`（一行修改但有 deprecation warning）**

```python
await redis_client.hmset(f"task:{task_id}", mapping_dict)
```

redis-py 仍保留，但会喷 DeprecationWarning。Redis 3.0 原生支持 HMSET。

**C. 升级 Redis 服务器（治本）**

把 `Redis-x64-3.0.504/` 换掉：
- **Memurai**（Windows 上的 Redis fork，活跃维护，免费版即可）：https://www.memurai.com/
- 或者 WSL2 + 官方 redis-server 7.x：`wsl --install` → `sudo apt install redis-server`

升级后什么都不用改，原代码可用。

### 推荐路径

下一个 session **第一件事**用方案 A 把三处改了，立刻能跑批扫；同时建议把 Redis 升级也做了（Memurai 安装就 5 分钟），以后不会再踩此类老版本兼容坑。

---

## 12. 下一个 session 起点

> 优先级从高到低排：

1. **修 Redis HSET 兼容 bug**（10 分钟）
   - 改 `backend/main.py` 三处 `hset(..., mapping={...})` 为 pipeline 方式（见 §11.A）
   - 重启 uvicorn，重跑 batch scan 验证
   
2. **测 LLM 归纳总结端到端**（用户原本就要测的）
   - Settings → 配 Claude（或 Volcengine）→ Test connection 通过
   - L2 BP 页面点 Deep reasoning 单节点跑一次 → 看 frontmatter 里 `analysis_state` 从 skeleton 变 llm
   - 然后跑一次 batch（修完 §11 之后）观察并发表现
   
3. **环境/PATH 收尾**（5 分钟，让用户自己做也行）
   - `C:\Python314\Scripts` 加到用户 PATH，以后 `uvicorn` / `pip` 直接能用
   - 命令：`[Environment]::SetEnvironmentVariable("PATH", "C:\Python314\Scripts;" + [Environment]::GetEnvironmentVariable("PATH","User"), "User")`，然后开新 PowerShell 窗口生效

4. **commit 当前进度**（看 git status 一大堆未提交，建议分几个 commit）
   - 建议拆分：①后端 LLM 抽象（backend/）②前端 LLM 面板 + store ③视图模式 + L1 markdown ④framework scan 系统级 .md
   - 写 commit 信息时用 `git diff` 自检，**不要**触发任何 hook 跳过

5. **真项目跑 framework scan + LLM 分析**
   - 之前 commit `02fb364` 已经把 C++ enumerate 链路做完，现在 framework-scan 也写出系统级 .md
   - 用户应该可以选他自己的 UE 工程目录，先跑 framework scan（无 LLM）→ 再用 LLM 单节点点几个 → 满意就跑 batch
   - 出问题贴日志回来定位

### 别再碰的东西

- LLM 凭据：永远不写后端 .env，永远不写 vault 文件
- C++ Bridge 签名：每次新加 UFUNCTION 都要让用户重新 build AICartographer 模块，能不动尽量不动
- `Redis-x64-3.0.504/` 目录：里面是个老版本 Redis 二进制，源代码不在我们手里，不要尝试 patch；要么换 Memurai 要么用方案 A 绕开

### 启动命令速查（Win + Python 3.14）

```powershell
# 1. 起 Redis（已有的老版本，先用着）
D:\Traeproject\UEMapping\Redis-x64-3.0.504\redis-server.exe

# 2. 起后端（在新 PowerShell）
cd D:\Traeproject\UEMapping\backend
python -m uvicorn main:app --reload --port 8000
# 注意：不要用 --host 0.0.0.0，会触发防火墙弹窗；默认 127.0.0.1 就够
# 注意：不要直接 `uvicorn` —— Scripts 没在 PATH（除非按 §12.3 配了）

# 3. 起前端 dev server（开发时；UE webview 里测时不用）
cd D:\Traeproject\UEMapping\UE_mapping_plugin
npm run dev

# 4. 起 UE 编辑器（webview 自动挂载已 build 好的前端 dist）
# 直接打开 D:\Traeproject\UEMapping\Cropout.uproject
```

### 端口占用排查（如果再遇到 WinError 10013）

```powershell
netstat -ano | Select-String ":8000\s"
# 拿到 PID 后
Get-Process -Id <PID> | Select Id, ProcessName, StartTime
Stop-Process -Id <PID> -Force
```

---

## 13. Session 2026-04-27（晚段后期）— 自动刷新 / 系统聚合 / 全栈中文化

> 在 §10-§12 之上的增量。本节覆盖白天到傍晚一段连续工作。

### 13.1 扫描完自动刷新（防渲染错误）

文件：`src/store/useScanStore.ts`

现象：扫描完后 vault 不刷新，用户感知是「页面没更新 / 渲染错误」。
根因：之前是先 `setState({ fileCache: {} })` 清缓存再调 `loadIndex()`，中间会出现「文件列表空 + 缓存空」的瞬态，前端组件从 store 拉到空数组就崩。
修复：先 `loadIndex()` 拿到新文件列表，再清 `fileCache`。这样组件始终能拿到一致的 `files` 数组，后续读 cache 时按需 lazy 加载。

### 13.2 Per-system Systems/&lt;axis&gt;.md 写入

文件：`backend/vault_writer.py:write_l1_overview` + `_write_system_md`（新加）

之前 L1 只写一份 `Systems/_overview.md`。前端 Lv1 的 `tags: #system/<axis>` 路由会去找 `Systems/<axis>.md`，找不到就 404。
新增逻辑：L1 跑完后，对 `metadata.systems[]` 每一项写一份 `Systems/<axis>.md`（filename = axis slug）。每份文件包含：
- frontmatter（title / system_id / axis / member_count / hub / risk_level / scan / analysis_state=llm）
- `[ INTRO ]`：从 LLM 的 `### [ {SYSTEM TITLE} ]` 块抽出（regex `_SYS_BLOCK_RE`）
- `[ MEMBERS ]`：解析 `member_meta` 把 asset_path 反查成 `[Title](../Blueprints/Title.md)`，hub 加 ★
- `[ BACKLINKS ]`：占位（系统页本身不参与 backlinks）

`write_l1_overview` 现在接 `member_meta` 参数（即 `collect_l2_metadata` 的输出），用来解析 member 链接。

### 13.3 边类型修复（A/B1/B2）

- **A — useScanStore 自动刷新**：上面 §13.1
- **B1 — projectScan.ts 边连线 + scanApi 类型**：`ScanBatchEdge` interface 补齐，前端聚合时 `outbound_edges` 不再丢字段
- **B2 — C++ ExtractEdges 继承边**：parent class 关系现在会作为 `inheritance` edge 写到 frontmatter，Lv1 d3-force 图能看到继承关系

### 13.4 全栈中文化（最大头）

#### 后端 LLM 输出

文件：`backend/main.py`
- `ProviderConfig.language: Optional[Literal["en", "zh"]]` 字段（默认 None / "en"）
- `_LANGUAGE_DIRECTIVE_ZH` 常量：附加到 system prompt 的中文指令，要求 `intent`/`title`/ANALYSIS 正文用中文，**受控词表 / asset_path / blueprint 名字 / `### [ ... ]` 章节标题保持英文**（因为前端解析这些 key）
- `_apply_language(prompt, language)` 工具：language=="zh" 才追加指令
- 调用点：`analyze_one_node(language=...)` / `process_batch_ast_task` 从 `provider_config_dict["language"]` 读 / `process_l1_task` 同样

#### 前端 UI i18n

新建文件：`src/utils/i18n.ts`
- `useT()` Hook 返回 memoized translator function
- 用法：`t({ en: 'Save', zh: '保存' })` 内联字典，跟 JSX 同位置；不需要全局 catalogue
- `useLang()` 拿当前语言（直接订阅 `useLLMStore.language`）
- 切语言会让所有用 `useT()` 的组件自动重渲（Zustand 订阅）

`src/store/useLLMStore.ts` 加 `language: OutputLanguage` 字段（持久化到 localStorage `aicartographer.llm.config`），`getProviderConfig()` 把它带进 payload。

i18n 已铺设的组件（21 个）：TopBar / ActivityBar / Tabs / Breadcrumb / RightPane / LeftPane / SettingsModal / LLMProviderPanel / ScanOrchestrator / FrameworkScanPanel / Lv0CardWall / Lv1SystemMarkdown / Lv1SystemGraph / L1ScanButton / Lv2BlueprintFocus / Lv2BlueprintGraph / Lv3FunctionFlow / NotesEditor / QuickSwitcher / AIChat / BackendOfflineCard。`ErrorBoundary` 是 class component 错误路径，故意没翻。

注意：`Lv2BlueprintFocus` 内的 `BacklinksSection` 是 sub-component，需要在它自己的函数体顶部 `const t = useT();`，不能在 JSX 内联调用 hook。

#### 中文 Settings 入口

`LLMProviderPanel.tsx`：把原本「Output language」改名为「Language」，加中文提示「会同时影响 UI 与 LLM 输出语言」。下拉项 `LANGUAGES` 常量定义了 en/zh 两项。

### 13.5 验证 + Bundle

- TypeScript：`tsc --noEmit` 干净
- Bundle：`vite build` → 251 modules → 508 kB / gzip 154 kB（写入 `Plugins/AICartographer/Resources/WebUI/index.html`）
- Python：`py_compile main.py vault_writer.py llm_providers.py` OK

### 13.6 已知边界

- 切语言**不会回填**已存在的 .md 文件 — `is_unchanged()` 会跳过 AST 没变的节点。要让旧文件变中文：删 vault 重扫 / 改 AST 触发重扫 / 点 Rebuild backlinks（只更新 BACKLINKS 区段文字）。
- LLM 输出的 `### [ INTENT ]` 这种章节标题**故意保留英文**（前端如有解析依赖会出问题）；正文是中文。

---

## 14. Session 2026-04-27（晚晚段）— Markdown 模板中文化 + 互动叙事提示词

> 用户反馈：①「点了简体中文，markdown 里有些系统页还是英文」②「蓝图分析干巴巴列成员，没意义。L1/L2/L3 都要讲谁调用谁、做了什么事」。本节是这两个的解法。

### 14.1 vault_writer 模板中文化

文件：`backend/vault_writer.py`

之前 §13.4 只翻译了 LLM 输出的 narrative，**vault_writer 自己写出的模板字符串**（heading / fallback / placeholder）还是写死英文。这次加：

- `_STRINGS_EN` / `_STRINGS_ZH` dict：所有用户可见模板（`## [ INTRO ]` / `## [ MEMBERS ]` / `## [ BACKLINKS ]` / `> [!system_risk] ...` / `*(awaiting LLM analysis)*` / `*(no incoming references)*` / `Project Overview` H1 等）
- `_strings(language)` 选表函数
- `language: Optional[str] = None` 参数加到：`write_node_file` / `_render_body_above_notes` / `_render_backlinks_block` / `rebuild_backlinks` / `write_l1_overview` / `_write_system_md`
- **`<!-- backlinks-start -->` / `<!-- backlinks-end -->` 故意不翻译** — 它们是 `_splice_backlinks` 用 regex 匹配的锚点，翻了会破 splice

main.py 全部调用点都改成传 `language=...`：
- `analyze_one_node` → `write_node_file(language=language)`
- `process_batch_ast_task` → `rebuild_backlinks(language=...)`
- `/scan/single` 路由的 rebuild → 同上
- `process_l1_task` → `write_l1_overview(language=...)`
- `/api/v1/vault/rebuild-backlinks` 端点新增 optional `language` query param

前端 `services/vaultApi.ts:rebuildBacklinks(projectRoot, language?)` + `SettingsModal` 调用时传 `useLang()`。

### 14.2 LLM 提示词改造为「互动叙事」

文件：`backend/main.py`

#### L2 `SYSTEM_PROMPT`（per-blueprint）

老版 ANALYSIS 章节：INTENT / EXECUTION FLOW (bullet) / I/O & MUTATIONS / ARCHITECTURAL RISK。问题是 EXECUTION FLOW 写成 bullet，I/O & MUTATIONS 太抽象，跟前端 frontmatter 已有的 Variables/Functions/Events 表重复。

新版：
- **INTENT** — 1 句话讲解决什么 *runtime* 问题
- **EXECUTION FLOW** — **散文叙述**主入口的运行时路径，3-6 句，点名具体 node。明确禁止 bullet list
- **MEMBER INTERACTIONS** — 每个非平凡成员一条 bullet：「它做什么 + 谁调用 / 读 / 写它」。给了具体例子（`OnDamageReceived` 被 `GameMode.HandleDeath` 消费），跳过纯 getter
- **EXTERNAL COUPLING** — bullet 跨蓝图关系，点名其它 BP / interface
- **ARCHITECTURAL RISK** — 同老版

新加规则：「不要重复 AST inventory，frontmatter 已经列了 Variables/Functions/Events」。

#### L1 `L1_SYSTEM_PROMPT`（per-project）

老版 per-system block：`Members: bullet list of node_ids`（干巴巴列成员）。

新版每个系统块：
- **Intent** — 解决什么运行时问题
- **Composition** — 散文，**点名具体成员对**：「BP_PlayerCharacter spawns BP_WeaponBase via EquipWeapon ...」。明确说"skip the inventory"
- **Critical Path** — 跟踪运行时主流程，点名 hub
- **Risk** — 跨成员风险

`CROSS-SYSTEM COUPLING` 章节也改了：要求每条 weight>=2 的 cross_system_edge 描述「edge kind + 两端蓝图名字」。

#### 中文指令更新

`_LANGUAGE_DIRECTIVE_ZH` 加了：
- 明确列出 `### [ ... ]` 章节标题（INTENT / EXECUTION FLOW / MEMBER INTERACTIONS / EXTERNAL COUPLING / ARCHITECTURAL RISK / PROJECT SYSTEM MAP / CROSS-SYSTEM COUPLING）保持英文
- 「叙事要具体——直接点名 BP_X 调用 BP_Y 的 Z 函数，不要写'它会调用相关组件'这种模糊表述」

### 14.3 验证

- `python -c "import ast; ast.parse(...)"` OK
- `tsc --noEmit` 干净
- `vite build` → 251 modules → 508.54 kB / gzip 154 kB

### 14.4 测试方式

旧 vault 的 .md 不会自动重写。完整验证：
1. 删 `<project>/.aicartographer/vault/` 整个目录
2. UE 里关掉再开 Web UI（让 bundle 重新加载）
3. Settings 里语言切到「简体中文」
4. 跑 framework scan → L2 batch scan → L1 scan
5. 检查：Systems/&lt;axis&gt;.md 应该是中文 heading + 中文 intro 叙事；Blueprints/&lt;name&gt;.md 应该有 MEMBER INTERACTIONS 章节描述「谁调用谁」

### 14.5 下一个 session 起点（更新版）

> 优先级取代 §12 的列表

1. **真项目实测今天的中文化 + 互动叙事**（用户原本就要测的）
   - 删旧 vault → 切中文 → 跑全链路 → 看 markdown 是否符合「互动叙事」预期
   - 如果叙事还是太干，可能要进一步细化提示词例子或加 few-shot
2. **Commit 今天的工作**（用户已说好「测试完就备份到 git」）
   - 一个 commit 覆盖：自动刷新 + per-system writer + 边修复 + 语言开关 + 全栈 i18n + 模板中文化 + 提示词改造
3. **如果新的中文叙事在某些蓝图上太啰嗦或漏点**：调 SYSTEM_PROMPT 的 example 举例（现在举的是武器+生命组件，可能不通用）

### 14.6 别再碰

- `BACKLINKS_START` / `BACKLINKS_END` 常量字符串（`vault_writer.py`）— 改一个字所有已存 .md 的 backlinks splice 就崩
- `### [ INTENT ]` / `### [ EXECUTION FLOW ]` 这些 LLM 输出的章节标题保持英文 — 中文指令明确写了，改的话要同步改 `_extract_system_block` 的 regex（虽然现在它只 match 系统标题，不 match 这些）
- `_SYS_BLOCK_RE` regex（vault_writer.py）— 它依赖 `### [ <title> ]` 这个固定格式抽 L1 的 per-system 段落

