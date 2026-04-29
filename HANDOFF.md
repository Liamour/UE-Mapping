# AICartographer 项目交接文档

> 最后更新：2026-04-29（资深 UE5 视角审视完成 → 战略判断 (B)：去 LLM 抽取，留 LLM 叙事）
> 这份文档把工程状态、架构、未完成任务一次性交给下一个 session。
> **从下到上读**：§18 是最新（资深 UE5 dev 审视，10 条新功能 roadmap + 战略判断），§17（P0/P1/P2 验证通过 + 进度表），§16（worktree → main），§15（4 项功能 + 重构），§13/§14（中文化 + 互动叙事），§1-§12 是历史交接。**新 session 必读 §18.4（战略判断）+ §18.3（功能优先级表）+ §17.2（已完成功能清单）。**

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

---

## 15. Session 2026-04-29 — 批扫丢函数/变量根因 + 4 项功能落地

> 用户反馈「同事打开 BP_GameManager（UE 里有 20 个函数 + 一堆变量），Lv2 图视图显示『内部 0 · 外部 6 · 8 条边』」，并提出 6 项问题：①扫描丢函数变量、②WBP 漏扫、③UE 内跳转、④本地 LLM 替代 API、⑤一键导出 JSON、⑥AI 辅助生成蓝图。
>
> **本节状态**：①②③⑤ 已全部落地并通过 tsc / vite / py_compile 三件套验证；用户尚未在 UE 编辑器内端到端实测（②③ 需先 rebuild C++ 模块）；④⑥ 推迟，理由见 §15.3。下次 session 接手前**必读 §15.9 测试清单**——它是验收每项落地是否真到位的唯一权威。

### 15.1 #1 根因诊断（关键发现，请先读）

用户最初猜测 prompt 错或上下文太长。**两个都不是**。决定性反例是用户给的：「单节点 Deep reasoning 能扫出函数和变量，批扫不行」。两条路径的 payload 形状完全不同：

| 路径 | 前端 ast_data 内容 | 触发文件 |
| --- | --- | --- |
| Lv2 单节点（Deep reasoning） | `{ exports_functions, exports_events, exports_dispatchers, components, edges, ast_hash }` | `Lv2BlueprintFocus.tsx:89-96` |
| 项目批扫 | `{ ast_hash, asset_path }` | `projectScan.ts:123` ← **元凶** |

后端 `main.py:412-417` 把 `node.ast_data` JSON 序列化拼到 user prompt 里，所以单扫的 LLM 能讲具体函数、批扫只能从 BP 名字瞎猜。

**第二层 bug**：`analyze_one_node` 构造 `NodeRecord` 时（`main.py:425-449`）**完全没传** `exports_functions/events/dispatchers/components/variables`，所以 frontmatter 写出来 `exports` 区块永远是空的——单扫看似有效是因为 **markdown 正文叙述里 LLM 提到了函数名**，frontmatter 其实也是空（用户已确认是「方案 A」，即视觉错觉）。

变量则更彻底：C++ 桥 `RequestDeepScan` 根本没 `ExtractVariables`，整条链路从头空到尾。

### 15.2 本次实际落地（已 commit 前的 diff 状态）

#### #1 — 批扫 payload 丢失修复（不需 rebuild C++）

| 改动 | 位置 |
| --- | --- |
| 批扫 payload 把 `r.functions` 拆成 `exports_functions/events/dispatchers`、加 `components` | `UE_mapping_plugin/src/services/projectScan.ts` |
| `analyze_one_node` 从 `node.ast_data` 读出结构化字段 → `NodeRecord` | `backend/main.py:analyze_one_node` |
| `NodeRecord` 加 `components: List[Dict]` 字段；`_build_frontmatter` 写 `components` 段 | `backend/vault_writer.py` |

#### #5 — 一键 JSON 导出（不需 rebuild C++）

| 改动 | 位置 |
| --- | --- |
| 新增 `GET /api/v1/vault/export?project_root=...&scope=all\|l1\|l2`，遍历 vault 把每份 .md（frontmatter + body）打包 | `backend/main.py` |
| `exportVault()` 双通路：bridge 模式本地聚合（`listVault` + `readVaultFile` 拼）；HTTP 模式优先后端端点，端点不存在则降级到本地聚合 | `UE_mapping_plugin/src/services/vaultApi.ts` |
| `downloadJSON()`：`Blob` + `<a download>` 触发 OS 另存对话框，CEF 内嵌也支持 | 同上 |
| Settings 加「导出 vault 为 JSON」段，三按钮（全部 / 仅 L1 / 仅 L2），带导出进度文案 | `UE_mapping_plugin/src/components/settings/SettingsModal.tsx` |

#### #2 — WBP / AnimBP / Library 漏扫（**需要 rebuild C++**）

| 改动 | 位置 |
| --- | --- |
| `ListBlueprintAssets` filter 加 5 个 ClassPath（`WidgetBlueprint` / `AnimBlueprint` / `BlueprintFunctionLibrary` / `BlueprintMacroLibrary`），开 `bRecursiveClasses=true` 拉子类（如 `EditorUtilityWidgetBlueprint`） | `Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp` |
| 用 `kAcceptedClassNames` set 替代旧的硬编码 `!= TEXT("Blueprint")` 校验 | 同上（`ListBlueprintAssets` + `RequestDeepScan` 两处） |
| `ClassifyBlueprintNodeType` 加 `WidgetBlueprint` / `AnimBlueprint` / `FunctionLibrary` / `MacroLibrary` 分类 | 同上 |
| `NODE_TYPE_TO_SUBDIR` 加 4 个新映射（→ `Widgets/` `Anims/` `Libraries/`）；`ensure_vault_layout` 创建对应目录 | `backend/vault_writer.py` |
| 前端 `subdirForType` 同步加映射，框架扫描写 skeleton .md 时落到正确子目录 | `UE_mapping_plugin/src/services/frameworkScan.ts` |

#### #3 — UE 内跳转（**需要 rebuild C++**，跟 #2 一起一次 build）

| 改动 | 位置 |
| --- | --- |
| 新 UFUNCTION `OpenInEditor(AssetPath, FunctionName)` | `Plugins/AICartographer/Source/AICartographer/Public/AICartographerBridge.h` |
| 实现：`UAssetEditorSubsystem::OpenEditorForAsset(BP)` 打开蓝图；FunctionName 非空时再对 `UEdGraph` 调一次 `OpenEditorForAsset` 让对应 tab 聚焦；查图走 `FunctionGraphs` / `UbergraphPages` / `MacroGraphs` 三处 | `Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp` |
| 加 `Editor.h` + `Subsystems/AssetEditorSubsystem.h` 头文件 | 同上 |
| 桥 wrapper `bridgeOpenInEditor` + 探测 `isOpenInEditorAvailable` | `UE_mapping_plugin/src/services/bridgeApi.ts` |
| Lv2 头部加「↗ 在 UE 中打开」按钮（桥不可用时隐藏） | `UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx` |
| Lv3 同样按钮，传 `functionId` 让 UE 直接打开对应函数图 | `UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx` |

#### 重构 — Scan Payload 抽离（用户提出，§15.7 详述）

| 改动 | 位置 |
| --- | --- |
| 新文件，单一来源构建 `ScanBatchNode`：`buildScanNodeFromBridge` / `buildScanNodeFromFrontmatter` + `flattenEdgesToOutbound` 等内部 helper | `UE_mapping_plugin/src/services/scanPayload.ts`（**新建**） |
| 批扫从这里调 `buildScanNodeFromBridge`，原本 inline 的 ~50 行 + `buildOutboundEdges` + `mapEdgeKind` 删除 | `UE_mapping_plugin/src/services/projectScan.ts` |
| 单扫从这里调 `buildScanNodeFromFrontmatter`，顺带修了「Deep reasoning 重跑会清空 frontmatter edges」的潜伏 bug | `UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx` |

### 15.3 推迟的 #4 / #6（讨论结论）

- **#4 本地 LLM**：现成 Provider 抽象足够好，加 `LocalProvider`（OpenAI 兼容 API 指 Ollama / llama.cpp / LM Studio）大概 50 行 Python。**真成本不在代码而在质量评估**——必须用同一份 AST 跑 Claude / GPT-4o / qwen2.5-coder:32b / deepseek-coder-v2 出对比，否则没法判断本地模型能不能上生产。先记下来，等 #1-3-5 落地后单开 session 评估。
  - 顺带：测试期间用 Anthropic / OpenAI 的 Batch API 能砍 50% 费用，比折腾本地模型回报更高（至少在测试阶段）
- **#6 AI 辅助生成蓝图**：完整生成不现实——UE 蓝图是二进制 + 复杂 UObject 序列化，没有稳定 JSON-to-blueprint 输入接口，LLM 也没训练过 .uasset。可行的中间形态是「**架构建议器**」：基于 #5 导出的 JSON 喂给 AIChat，AI 给出施工文档（"做 EnemyAI 需要哪些组件 + 谁调用谁 + 参考 BP_X 的 Y 写法"），用户拿文档自己拼。建议 #5 完成后再展开。

### 15.4 验证策略（已通过的代码层验证 + 待跑的 UE 实测）

**代码层（已通过）**：
- `tsc --noEmit`：干净（252 modules）
- `vite build`：513.78 kB / gzip 155.87 kB → 已写入 `Plugins/AICartographer/Resources/WebUI/index.html`
- `python -m py_compile backend/main.py backend/vault_writer.py backend/llm_providers.py`：exit 0

**UE 端到端（待跑）**：见 §15.9 测试清单。

### 15.5 别再踩

- **不要**让 LLM 自己「输出函数列表」——它没看到的东西编不出来。函数/事件/组件**必须由 C++ 桥的 AST 提取走 payload 透传**，LLM 只负责语义层（intent / 风险等级 / 叙述）
- **不要**改 `BridgeDeepScanResult` / `ASTNodePayload` 的现有字段名——前端历史代码、`normalizeFrontmatter`、单扫 payload 都依赖现状。新字段加在原字段旁边
- **不要**在 `Lv2BlueprintFocus.tsx` 或 `projectScan.ts` 里再写 inline 的 `ast_data: {...}` / `outbound_edges: [...]`——所有扫描入口必须经 `services/scanPayload.ts` 的 builder。否则 §15.7 的对称 bug 会卷土重来
- **C++ rebuild** 仍然是 #2/#3 的硬约束（Live Coding 改现有函数体可能行，但加新 UFUNCTION 必须 close UE → VS/Rider build → 重开）

### 15.6 启动状态

新 session 接手时按 §12.SOP 跑环境（Redis 3.0.504 + uvicorn 8000 + UE 编辑器载已 build 的前端 dist）。本节工作已落地 + 验证完，commit 已待发。

### 15.7 追加修复 — 边数据透传 + Scan Payload 抽离（用户提出）

> 用户测试前先对齐时指出两件事：①「设置栏的 LLM 扫描有改吗」②「所有 payload 里有加上 edge 信息吗」③建议把发 LLM 的 payload 封装成单一函数，避免后续改 LLM 逻辑时三个地方都要动。审完代码确实有两个潜伏 bug 没修：

**潜伏 bug 1（batch 路径）**：§15.2 的 #1 修复让批扫的 `ast_data` 带上 `exports_*` 和 `components`，**但忘了带 edges**。`outbound_edges` 字段虽然把 edges 传给后端 vault writer 了，所以 frontmatter 不会丢，**但 LLM prompt 看不到 edges**——`main.py:412-417` 只把 `ast_data` 序列化进 user prompt，跟 `outbound_edges` 字段无关。结果：LLM 知道这个 BP 有哪些函数，但不知道这些函数调用了别的 BP，叙述会很干。

**潜伏 bug 2（single 路径）**：`Lv2BlueprintFocus.tsx` 的 Deep reasoning 按钮把 `fmLocal.edges` 塞进 `ast_data` 让 LLM 能看到 ✅，**但 `outbound_edges: []` 是空的** ❌。后端写 `.md` 时 `node.outbound_edges` 为空 → `NodeRecord.edges_out=[]` → `_build_frontmatter` 不写 `fm["edges"]` → **frontmatter 的 edges 段被清空**。重跑 Deep reasoning 一次，原来好好的 edges 区块就消失了。

两条路径各自残一半，互为镜像。

**修法 — 抽统一 helper**：

新增 `UE_mapping_plugin/src/services/scanPayload.ts`：
- `ScanASTData` 类型：定义 LLM 看到的结构化 AST 形状（包含 edges，nested 格式跟 frontmatter 一致）
- `buildScanASTFromBridge(r, assetPathToName)`：从 C++ 桥结果构建（含 edge 去重 + kind 映射）
- `buildScanASTFromFrontmatter(fm)`：从已写入的 vault frontmatter 构建
- `flattenEdgesToOutbound(edges)`：嵌套 edges → 平 `ScanBatchEdge[]`，给 outbound_edges 用
- `buildScanNodeFromBridge(r, nodeId, idx)` / `buildScanNodeFromFrontmatter(fm, relPath)`：一站式构建 `ScanBatchNode`，**ast_data 和 outbound_edges 同步从同一份 ast 派生**

改造点：
- `services/projectScan.ts:117`：原本 inline 的 payload 组装 + `buildOutboundEdges` + `mapEdgeKind` 全部删除，改成一行 `fresh.map((r) => buildScanNodeFromBridge(r, deriveNodeId(r), assetPathToName))`
- `components/levels/Lv2BlueprintFocus.tsx:79`：原本手写的 `node: { node_id, asset_path, ..., ast_data: {...}, outbound_edges: [] }` 改成一行 `buildScanNodeFromFrontmatter(file.frontmatter, relativePath)`

Settings 面板的批扫走 `ScanOrchestrator` → `runProjectScan` → `projectScan.ts`，所以这次 helper 自动覆盖。L1 扫描（`postL1Scan`）只发 `{ project_root, provider_config }`，后端从 vault 直接读 frontmatter，不存在 payload 组装问题——它**间接依赖** L2 的 frontmatter 写得对，所以 L2 修了 L1 也跟着好。

### 15.8 验证（含 §15.7 后）

- `tsc --noEmit`：干净（252 modules，比之前多 1 = scanPayload.ts）
- `vite build`：513.78 kB / gzip 155.87 kB → `Plugins/AICartographer/Resources/WebUI/index.html`
- `py_compile`：exit 0
- 单一 helper 后，未来加新扫描入口（比如「重新分析当前选中节点」、「定时全量重扫」）只要从 `scanPayload.ts` 选一个 builder 即可，不会再出现「漏字段」类 bug

### 15.9 测试清单（按这个顺序跑能逐项验证）

1. **关 UE → VS / Rider rebuild AICartographer 模块 → 重开**（#2/#3 必需）
2. **删旧 vault**：旧 manifest 里的 hash 算法改了（payload 加字段后 SHA1 变），不删的话 `is_unchanged` 永远命中跳过，看不到新数据
3. **跑 framework scan**：立刻能看到 WBP_* / WBP_HUD 这种 widget 蓝图出现在节点池（#2 验证）
4. **打开任意 BP 的 Lv2 图模式**：「内部 N · 外部 M」N 应该 >0，frontmatter 应该有 `exports`、`components` 段（#1 验证）
5. **点 Lv2 头部「↗ 在 UE 中打开」**：UE 编辑器跳出对应蓝图（#3 验证）
6. **点 Lv3 函数的「↗ 在 UE 中打开」**：UE 编辑器跳到对应函数图 tab（#3 验证）
7. **跑 L2 batch scan**：完成后对比 frontmatter，`exports / components / edges` 应当**仍然存在**（§15.7 修复验证 — 之前会被 LLM 路径清空）
8. **对单个 BP 点 Deep reasoning 重跑两次**：第二次完成后 frontmatter 的 `edges:` 段应该**仍然存在**（§15.7 单扫 edge 清空 bug 验证）
9. **Settings → 「导出 vault 为 JSON」**：浏览器弹另存对话框，拿到 JSON 检查 `systems` / `blueprints` 数组完整（#5 验证）

任何一步失败贴日志回来。

### 15.10 下次 session 起点

> 优先级取代 §14.5 的列表。

1. **用户在 UE 内跑 §15.9 测试清单**（必须先于一切其它工作）
   - 任意一项失败立刻回滚到失败点排查；不要继续往下推 #4/#6
   - 全过 → commit 一次，commit message 建议拆成两段：①4 项功能落地 ②scanPayload 抽离 + 边数据双向修
2. **#4 本地 LLM 接入评估**（commit 后再开）
   - 加 `LocalProvider` 是 30 分钟的事，**真工作量在评测**：用同一份 BP_GameManager 的 ast_data 跑 Claude / GPT-4o / qwen2.5-coder:32b / deepseek-coder-v2，看本地能不能给出可读的 INTENT / EXECUTION FLOW / MEMBER INTERACTIONS
   - 评测产物：一张表格 + 三份生成的 .md 对比，决定本地模型能否进默认推荐
   - 同步 hint 用户：当前阶段用 Anthropic / OpenAI Batch API 砍 50% 是更划算的省钱路径
3. **#6 架构建议器**（基于 #5 导出做）
   - 设计：AIChat 接收用户问句 + 当前 vault 的 JSON 导出（或它的子集）作为上下文
   - 输出：施工文档（不是蓝图本体），点名要参考的现有 BP / 要新建的组件 / 要订阅的事件
   - 不要承诺「完整生成蓝图」，技术上 .uasset 没稳定写入接口
4. **变量提取（§15.1 提到的、还没修的）**
   - C++ 桥加 `ExtractVariables` 走 `BP->NewVariables`（`TArray<FBPVariableDescription>`）
   - 字段透传 `BridgeDeepScanResult.variables` → `ScanASTData.variables` → `NodeRecord.variables` → frontmatter `variables` 段
   - 已经把 `variables` 字段在 `NodeRecord` 和 `ScanASTData` 里预留好，加 C++ 提取一处即可贯通
   - rebuild C++ 还是必须的，可以跟下次任何 C++ 改动拼 build

### 15.11 改动文件一览（Git status 视角，便于 commit 拆分）

```
HANDOFF.md                                                            # 本次交接（§15）
Plugins/AICartographer/Source/AICartographer/Public/AICartographerBridge.h    # +OpenInEditor UFUNCTION
Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp # WBP filter + OpenInEditor 实现
Plugins/AICartographer/Resources/WebUI/index.html                     # vite 构建产物
backend/main.py                                                        # analyze_one_node 透传 + /vault/export
backend/vault_writer.py                                                # NodeRecord.components + 新 subdir 映射
UE_mapping_plugin/src/services/scanPayload.ts                          # ★ 新文件，单一 payload 来源
UE_mapping_plugin/src/services/projectScan.ts                          # 改用 helper，删 ~50 行重复
UE_mapping_plugin/src/services/bridgeApi.ts                            # +bridgeOpenInEditor
UE_mapping_plugin/src/services/vaultApi.ts                             # +exportVault + downloadJSON
UE_mapping_plugin/src/services/frameworkScan.ts                        # subdirForType 同步
UE_mapping_plugin/src/components/settings/SettingsModal.tsx            # +导出按钮组
UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx          # 改用 helper + ↗按钮
UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx            # +↗按钮
```

建议拆 3 个 commit（如果你想细分）：
1. `feat(#1): preserve exports/components/edges through batch scan + extract scanPayload helper`（§15.2 #1 + §15.7 重构 + 边修复）
2. `feat(#2,#3): widen WBP filter + OpenInEditor bridge + jump-to-UE buttons`（§15.2 #2 + #3）
3. `feat(#5): one-click vault JSON export with browser download`（§15.2 #5）

或者一次性 squash 都行，看你测完之后的偏好。

---

## 16. Session 2026-04-29（晚段补丁）— 放弃 worktree，回归 main 单分支

### 16.1 起因 — worktree 状态没同步到主项目

§15 的全部代码改动（C++ bridge + 后端 + 前端 + 新增 `scanPayload.ts`）原本写在 git worktree `claude/admiring-mahavira-38c831` 里，路径 `.claude/worktrees/admiring-mahavira-38c831/`。

用户首次 UE 实测无任何效果：
- 打开了**主项目** `D:\Traeproject\UEMapping\Cropout.sln` 在 VS 里 build
- 在**主项目** `UE_mapping_plugin/` 跑了 `npm run build`
- 结果：「↗ 在 UE 中打开」按钮没出现、Lv2「内部 0」依旧、Deep reasoning 也没改观

诊断：worktree 和 main 是两份独立的 working tree，main 还在 master HEAD（旧代码），用户在 main 上 build 得到的是 §15 之前的产物。

### 16.2 修复动作（已完成，无需重复）

把 worktree 的 14 个改动文件 + 1 个新文件**直接复制**到主项目对应路径：

```
HANDOFF.md
Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp
Plugins/AICartographer/Source/AICartographer/Public/AICartographerBridge.h
UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx
UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx
UE_mapping_plugin/src/components/settings/SettingsModal.tsx
UE_mapping_plugin/src/services/bridgeApi.ts
UE_mapping_plugin/src/services/frameworkScan.ts
UE_mapping_plugin/src/services/projectScan.ts
UE_mapping_plugin/src/services/scanPayload.ts        ← 新增
UE_mapping_plugin/src/services/vaultApi.ts
backend/main.py
backend/vault_writer.py
```

随后在主项目 `UE_mapping_plugin/` 跑了一次 `npm run build`，`Plugins/AICartographer/Resources/WebUI/index.html` 重新生成（513.77 kB / gzip 155.85 kB）。主项目的 `git status` 现在等价于之前 worktree 的 `git status`（13 M + 1 ??）。

C++ 部分仍待用户在 VS 里 rebuild + 关 UE 重启（同 §15.9 第 1 步），WebUI 已就绪。

### 16.3 后续工作流 — 直接在 main 上做（用户决定）

> 这一节取代 §15.10 的「下次起点」，作为新会话的第一参考。

**新规则**：
- 所有后续 feature 工作直接在 `D:\Traeproject\UEMapping\` 主项目 + `master` 分支上写代码、build、测试
- **不**再用 `git worktree add` 开新工作树
- 不在 `.claude/worktrees/` 下做实际开发；那目录里其它已有 worktree（admiring-tu / determined-kepler / pensive-mcnulty）保持冷冻、不动它

**为什么放弃 worktree**：
- 用户的工作流惯性是「打开 Cropout.sln + 打开主项目 npm」，每次切到 worktree 都要手动改路径
- C++ 项目尤其麻烦：UE 项目文件 `Cropout.uproject` 默认从主项目所在路径生成 .sln，worktree 里要单独 Generate VS Project Files
- 对方 1-2 人小团队，worktree 隔离的好处（并行 feature）目前用不上

**依然不变的事项**：
- §15.9 测试清单照跑（关 UE → VS rebuild AICartographer → 重开 → 删旧 vault → framework scan → 验证 4 项功能）
- commit 拆分建议见 §15.11（main 上直接 commit；不用过 worktree 中转）
- 后端 uvicorn + Redis 仍在跑（uvicorn 当前指向 worktree 的 backend，但因为 main 和 worktree 文件已经一致，效果等价；想干净可以杀掉 uvicorn 重启指 main 的 backend，但非必须）

### 16.4 worktree 仍存在 — 只是不再用

`git worktree list` 仍能看到 `admiring-mahavira-38c831`，文件里也还是 §15 完成态那份。**不要 prune**，留作历史快照以防 main 上写崩了要回滚对照。但下次写代码在 main 上写，不要再误打开 `.claude/worktrees/.../UE_mapping_plugin` 改东西 —— 那样改完又得复制一次。

如果未来真的想清理：
```bash
git worktree remove .claude/worktrees/admiring-mahavira-38c831 --force
git branch -D claude/admiring-mahavira-38c831
```
但**先 commit 一次 main**再清，否则没参照系。

### 16.5 下一个 session 起点（替代 §15.10）

1. **用户跑 §15.9 测试清单**（必须在 main 上 build/测）
   - 任意一项失败回报；不要继续往下推
   - 全过 → main 上直接 commit（参考 §15.11 拆分建议）
2. **#4 / #6 / 变量提取** — 同 §15.10 后半段，但 working dir 一律是 `D:\Traeproject\UEMapping\`
3. **如果发现 main 和 worktree 的 §15 文件还有任何 drift**：以 worktree 那份为权威拷过来，因为本次复制是逐文件 cp，理论上字节相同但脚本失误总是可能

---

## 17. Session 2026-04-29（深夜段）— P0/P1/P2 验证通过 + 进入细化阶段

### 17.1 验证结果（用户 UE 实测，截图存档）

用户在主项目 (`D:\Traeproject\UEMapping\`) 完成 C++ rebuild + WebUI rebuild + framework re-scan 后，§15.9 测试清单全部通过。关键证据：

**Lv2 BP_Resource 实测截图**（2026-04-29 深夜）：
- 头部："Blueprints/BP_Resource.md 内部 **4** · 外部 **1** · 2 条边"
- 内部节点（FUNCTION/EVENT 都正确归类）：
  - FUNCTION: `Interact`, `Death`
  - EVENT: `ReceiveBeginPlay`, `Scale UP`
- 外部节点：`BP_Interactable`（继承自）
- 边：`function_call` 红线 + `inheritance` 灰线
- 图例只列出当前图实际存在的节点类（event / function / external）和边类（function_call / inheritance）—— L1 的 legend 自适应也正常

**这一张图证伪了之前所有怀疑**：
- ✅ #1 数据丢失修复：批扫后 frontmatter 的 `exports_functions / exports_events / components / edges` 都被透传到了 .md
- ✅ #2 WBP 漏扫修复：（需要项目里有 WBP 才能直观看到，但 BP_Resource 出现说明 ClassPath 过滤已经通过 Blueprint 类）
- ✅ #3 UE 跳转：用户确认按钮可见且能跳转
- ✅ #5 JSON 导出：用户确认 Settings 面板按钮可用

### 17.2 6 项需求总进度表（细化阶段开始的基线）

| 优先级 | # | 需求 | 状态 | 实现位置 / 备注 |
|---|---|---|---|---|
| **P0** | #1 | L1+L2 扫描丢函数 / 变量 | ✅ **已完成** | `backend/main.py` `analyze_one_node` 透传 ast_data + `vault_writer.py` NodeRecord.components + `services/scanPayload.ts` 抽离 + 前端 `Lv2BlueprintFocus.tsx` `normalizeFrontmatter` 兼容嵌套 / 扁平 |
| **P1** | #2 | WBP / 部分蓝图被漏掉 | ✅ **已完成** | `AICartographerBridge.cpp` ListBlueprintAssets 用 5 个 ClassPaths + bRecursiveClasses=true；ClassifyBlueprintNodeType 新增 WidgetBlueprint / AnimBlueprint / FunctionLibrary / MacroLibrary 分支；vault_writer 新增对应 subdir |
| **P1** | #3 | 在 UE 编辑器内跳转打开 | ✅ **已完成** | C++ `OpenInEditor(AssetPath, FunctionName)` UFUNCTION → UAssetEditorSubsystem→OpenEditorForAsset；前端 `bridgeOpenInEditor` + `isOpenInEditorAvailable` 探测 + Lv2/Lv3 头部 ↗ 按钮 |
| **P2** | #5 | 一键导出项目 JSON | ✅ **已完成** | `vaultApi.ts` `exportVault(scope: all\|l1\|l2)` 智能 fallback（bridge 模式本地聚合 / HTTP 模式优先后端 `/api/v1/vault/export`）；SettingsModal 三按钮 + browser 下载 |
| **P3** | #4 | 本地 LLM 接入 | ⏳ **未开始**（已评估推迟） | 加 LocalProvider 是 30 分钟事，**真工作量在评测**（同一 BP 跑 Claude/GPT-4o/qwen2.5-coder:32b/deepseek-coder-v2 看本地 INTENT 输出质量）。给用户的中间方案：先用 Anthropic / OpenAI Batch API 砍 50% 成本 |
| **P3** | #6 | AI 架构建议器 | ⏳ **未开始**（依赖 #5） | 设计：AIChat 接收用户问句 + #5 导出的 vault JSON 子集 → 输出施工文档（不生成 .uasset）。需要 #5 的导出格式稳定后再开始 |

**附加未完成事项**（之前提过，归在「细枝」类）：
- 🔧 变量提取（C++ `ExtractVariables` 走 `BP->NewVariables`）：字段已在 `NodeRecord.variables` / `ScanASTData.variables` 预留，加 C++ 提取一处即可贯通；可拼下次任意 C++ 改动一起 build

### 17.3 细化阶段起点 — 由资深 UE5 视角驱动

P0/P1/P2 完成后，6 项需求初衷已大半兑现。下一阶段不再机械地按 P3 推 #4/#6，而是**回到产品视角问一句：现在这个工具真的能帮 UE5 开发者梳理项目吗？还缺什么？**

为此本 session 末尾启动了一次「资深 UE5 引擎开发者审视」(由 Agent 子会话给出的批判性反馈)，重点考察：
- 现有 4 级视图 (Lv0 卡墙 / Lv1 系统图 / Lv2 蓝图详情 / Lv3 函数图) 在真实 UE5 项目工作流里**实际能解决什么问题**、**解决不了什么问题**
- 资深 UE 开发者每天在「梳理项目结构 / 排查崩溃 / 评审重构 / 新人 onboard」这些场景里，**会不会真的打开 AICartographer，打开了之后用 5 分钟就关掉还是会留着用**
- 还该补什么核心功能（不是想到啥写啥，要按 UE5 工程实际痛点排序）

子 session 的输出会作为 §18 落地。本 session 不再继续推进，**等用户读完子 session 反馈后再决定 Roadmap 优先级**。

### 17.4 commit 状态

截至本节写入，main 还有以下未 commit 的改动（§15 + §16 + §17 累积）：

```
M HANDOFF.md                                                            (§15 + §16 + §17)
M Plugins/AICartographer/Source/AICartographer/Private/AICartographerBridge.cpp
M Plugins/AICartographer/Source/AICartographer/Public/AICartographerBridge.h
M Plugins/AICartographer/Resources/WebUI/index.html                     (vite build artifact)
M UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx
M UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx
M UE_mapping_plugin/src/components/settings/SettingsModal.tsx
M UE_mapping_plugin/src/services/bridgeApi.ts
M UE_mapping_plugin/src/services/frameworkScan.ts
M UE_mapping_plugin/src/services/projectScan.ts
M UE_mapping_plugin/src/services/vaultApi.ts
M backend/main.py
M backend/vault_writer.py
?? UE_mapping_plugin/src/services/scanPayload.ts
```

建议 commit 顺序（用户决定时机）：
1. `feat(scan): preserve exports/components/edges through batch + extract scanPayload helper`（P0 #1）
2. `feat(bridge): widen WBP filter + OpenInEditor jump-to-UE`（P1 #2 + #3）
3. `feat(export): one-click vault JSON export with browser download`（P2 #5）
4. `docs: HANDOFF §15-§17 — 4 features + worktree merge + verification`

或者一次 squash 都行。**不要在跑 §18 评审建议前 commit，**那样的话评审里如果发现要紧急回退某项功能，rebase 会麻烦。

---

## 18. Session 2026-04-29（深夜段·细化阶段开篇）— 资深 UE5 开发者审视

> 由 Agent 子会话扮演 8 年以上 UE5 引擎层 / 大型蓝图项目经验的资深开发者，对当前 4 项功能 + 4 级视图做批判性 review。原文存档以便后续决策对照，不要二次解读弱化结论。

### 18.1 真实工作流场景代入（场景 → 是否能用）

资深开发者按月度发生频率列出 8 个真命场景，给出工具命中率：

| # | 场景 | 当前工具能用吗 | 频率 |
|---|---|---|---|
| 1 | 系统重构（如 InventorySystem BP→C++）| **会留着开一整天**，但前提是 system 划分准确（LLM 划得准存疑） | 月度 |
| 2 | QA 报 bug 追跨 BP 调用链（IA→Component→Interface） | **5 分钟就关掉**，跨 BP 跳转 4 步太重，UE Ctrl+点击委托更快 | 周度 |
| 3 | 新人入职接 800 BP 项目 | **会留着看一周**然后再也不打开 | 季度 |
| 4 | 性能优化找 Tick 重灾区 | **完全帮不上**，缺 Stat / Spawn 频率热力 | 月度 |
| 5 | Code Review，看老李改了 BP 50 处 | **完全帮不上**，缺 BP diff | 周度 |
| 6 | 决定新技能塞 GAS 还是新做一套 | **会开 30min - 2h**，Lv1+Lv2 看耦合度 | 月度 |
| 7 | 主程离职，接手 200 BP 插件 | **核心场景，会开一整周** | 半年度 |
| 8 | 日常写新功能 | **不会打开** | 每天 |

**关键判断**：3、6、7 是真命场景，1 看实现深度，2/4/5/8 帮不上。**当前定位 = 接手期工具，DAU 注定低**；要么提高交接频率（不可能），**要么扩展到日常场景（必须做）**。

### 18.2 现有实现的硬伤（资深视角找茬）

1. **Lv3 直接读 UEdGraph X/Y 还省略 Knot/Comment/Composite —— 反向误导**
   - 蓝图老手 70% 的信息在 Comment Node 文字注释和 Reroute 走线
   - 拿掉这些只剩 K2Node = 「失去语境的拓扑」，新手看了以为是全貌，**比不画更糟**
   - Composite/MacroInstance 不展开就是黑盒，Tunnel 节点输入输出对不上
   - 要么做全（递归展开 Composite + 保留 Comment/Knot），要么干脆不做留个跳 UE 按钮

2. **AssetRegistry BP-only 的覆盖率，真实项目大概 30-40%**
   - 真项目大量：DataTable / MaterialFunction / Niagara / AnimMontage / GameplayAbility 配置
   - BP-to-BP HardReference 只是冰山一角，UAsset 引用网才是项目结构
   - 把 ClassPaths 再 widen 到 DataAsset / DataTable / NiagaraSystem 是几天的事，**不做这块说「项目梳理」站不住**

3. **C++ → BP 的反向调用是大窟窿**
   - BlueprintCallable / BlueprintImplementableEvent / BlueprintNativeEvent 是 C++/BP 边界核心
   - AAA 项目 GameplayAbility / AbilityTask / Component 大量用，**当前完全看不到**
   - UnrealHeaderTool 生成的 .gen.cpp 有完整反射数据，或直接 walk UClass::FuncMap 挑 BlueprintCallable flag —— **引擎层活，不难**

4. **LLM 互动叙事给老手看是噪音**
   - 三段式 INTENT/EXECUTION FLOW/MEMBER INTERACTIONS 是给新人 / PM / 交接用的
   - 老手要的是「函数签名 + 调用方 + 被调方 + 关键变量」 = doxygen 风格 + 反向引用列表
   - **建议加开关**：Narrative / Reference 两种笔记模式

5. **同步机制是这工具最大隐患（P0 级）**
   - Rename / Move / Delete / Migrate 之后 .md 全是脏数据
   - **开发者一旦发现 vault 信息和工程不符，信任崩塌就再也不打开了**
   - 最低限度要监听 `FAssetRegistryModule::OnAssetRenamed / OnAssetRemoved`，自动 mark stale
   - LLM 重扫贵就只重扫 stale，**但绝不能让用户在不知情时看到陈旧数据**
   - **比新功能优先**

6. **vault 进不进 git —— 直接决定产品形态**
   - 进 git：分享笔记 vs LLM 输出不确定性导致每次 diff 巨大、team merge 爆炸
   - 不进：每开发者本地一份，新人入职体验归零
   - 推荐**ast_hash 决定的结构化 frontmatter 进 git，LLM 正文不进**（或 lfs）
   - **现在就要定，晚了改成本极高**

### 18.3 资深开发者真正想要的功能（按优先级，不是按难度）

| # | 功能 | 痛点 | 实现路径 |
|---|------|------|---------|
| 1 | **AssetRegistry 增量监听 + 自动 mark stale** | vault 一脏全盘失信 | 订阅 `OnAssetRenamed/OnAssetRemoved/OnInMemoryAssetCreated`，更新 ast_hash 比对，stale 的 .md 加红角标 |
| 2 | **C++ ↔ BP 边界视图** | C++ 反调 BP 完全不可见，AAA 项目核心 | walk UClass::FuncMap 取 BlueprintCallable/Implementable/NativeEvent，建反向边 |
| 3 | **跨 BP 调用追踪（Find-Usages 全图版）** | UE 自带 Find-References 是列表，看不出层级和路径 | Lv1 加「以 X 为根、深度 N 的依赖子图」模式，BFS + edge_type filter |
| 4 | **DataAsset / DataTable / GAS 资产纳入图谱** | BP-only 覆盖 30-40%，配置驱动项目几乎完全失明 | FARFilter 扩展到 UDataAsset 子类，HardReference walk |
| 5 | **Diff 模式：两次扫描快照对比** | Code Review / 重构验收无对照 | vault 加版本目录，按 ast_hash structural diff，UI 红绿叠加 |
| 6 | **节点级别的「热度」叠加（Stat / Profiling）** | 鸟瞰图无法定位性能问题 | 接 UE Insights / Stat 数据，按 BP 调用次数染色 Lv1 节点 |
| 7 | **Lv1 SystemGraph 自动分组重构（Modularity）** | 力导向图 100+ 节点全成毛线团 | 跑 Louvain / Leiden 社区检测，自动收成可折叠 Cluster |
| 8 | **Comment Node 内容作为锚点索引** | UE 老项目大量靠 Comment 注释组织代码，搜索不到 | 解析 UEdGraphNode_Comment 的 NodeComment 字段，全 vault 全文搜索入口 |
| 9 | **Inline 跳转：从 .md 笔记反向回 UE 节点** | OpenInEditor 只到 BP 级，要到节点级 | bridge 调 `FKismetEditorUtilities::BringKismetToFocusAttentionOnObject(UEdGraphNode*)` |
| 10 | **「冷资产」检测——长期无引用的 BP/Asset** | 项目膨胀但没人敢删 | AssetRegistry 反向引用计数 = 0 列表，标 candidate 但不自动删 |

排序逻辑：
- **#1, #2, #4 = 堵窟窿**（信任 + 覆盖率），不做这些说「项目梳理」是空话
- **#3, #5 = 日常高频**
- **#6, #7 = 让工具进入日常场景**
- **#8, #9, #10 = 资深开发者会反复用**

### 18.4 战略判断（最关键）

**选择：(B) 4 级视图视角对，但 LLM 抽取这条路在「结构」上不对，在「叙事」上对。**

依据：

#### 结构提取走 LLM 是死路

`ast_hash / exports / components / edges` 这些字段，UE 的 Reflection 系统（UClass / UFunction / FProperty）已经给了 **100% 精确、零幻觉、零成本**的答案。

让 LLM 去抽这些字段 = 让一个**会犯错、要花钱、要联网、产出不稳定**的工具去做编译器已经做完的事。结果：批扫贵、慢、还要人工修，覆盖率反而上不去。

**Reflection + AssetRegistry + UEdGraph 静态分析，是这工具的真地基**，应把所有结构化字段从 LLM 移出来。

#### LLM 的位置应该是叙事和问答，不是抽取

- **叙事**（场景 3、7）：INTENT / EXECUTION FLOW 是 LLM 本职，继续做
- **问答**：「这个项目里谁负责伤害计算」「BP_Player 的 Interact 触发链路」 —— **LLM 真正不可替代的场景，当前完全没做**
- **RAG over vault + 工具调用回 AssetRegistry**，是这工具进入「日常」的唯一路径

#### 4 级视图视角对，但缺第 5 级

**跨 BP 的调用追踪图（Find-Usages 全图版）**：
- 当前 Lv1 是 system 内的，Lv2 是单 BP 出入边
- **没有「以任意函数为根，N 跳内的全工程调用图」**
- 这恰恰是日常 debug / 重构最高频的视图

#### 对 (C) 的回应

调试期局部精确性是另一个产品（UE Insights / RenderDoc 领域），不是这工具该抢的赛道。但**鸟瞰也不能只停在 LLM 叙事，必须有结构精确性兜底**，否则资深开发者一看就关。

#### 下一阶段投资方向

1. **去 LLM 抽取**：所有结构化字段切到 Reflection + 静态分析
2. **LLM 预算全压到问答 + 叙事**
3. **加做跨 BP 调用追踪第 5 级视图**
4. **同时把 P0 的 stale 同步机制做掉**

> **这三件做完，工具从「接手期玩具」升级到「日常必备」。否则继续在 LLM 抽取上加功能，是在沙地上盖楼。**

### 18.5 对当前 6 项需求列表的冲击（必须重新审视）

| 之前的项 | §18 视角下的判断 |
|---|---|
| #1 数据丢失 ✅ 已做 | 治标。**真正的解法是去 LLM 抽取**，让 Reflection / AssetRegistry 直接出 `exports/components/edges`，根本没有「LLM 漏字段」的 bug 类 |
| #2 WBP 漏扫 ✅ 已做 | 方向对，但只走了 1/3。**还要扩到 DataAsset / DataTable / GAS / Niagara / MaterialFunction**（§18.3 #4） |
| #3 UE 跳转 ✅ 已做 | 方向对，但只到 BP 级。**要做到节点级**（§18.3 #9） |
| #5 JSON 导出 ✅ 已做 | OK，但实际价值得跟「问答 RAG」配套才显现 |
| #4 本地 LLM ⏳ | **优先级降低**：如果 LLM 不再做结构抽取，叙事工作量小很多，本地 LLM 性价比反而提升；但仍然不是 P1 |
| #6 架构建议器 ⏳ | **要重定义**：从「接收 JSON 导出」改成「**RAG over vault + AssetRegistry 工具调用**」，这才是 §18.4 设想的「问答」 |

### 18.6 下次 session 起点（替代 §17.3）

Roadmap 重排（按 §18 战略判断）：

#### 阶段 A — 修地基（必须先做）
- **A1. AssetRegistry stale 监听**（§18.3 #1） —— 信任崩塌 P0
- **A2. 结构化字段去 LLM 化**（§18.4 第一项）—— 改 `analyze_one_node`：先用 Reflection 出结构化字段，LLM 只生成 `body`；批扫成本 / 速度 / 准确率全提升
- **A3. 第 5 级视图 — 跨 BP 调用追踪图**（§18.3 #3）—— 日常高频，对 (B) 战略判断的兑现

#### 阶段 B — 扩覆盖率
- **B1. C++ ↔ BP 边界**（§18.3 #2）
- **B2. DataAsset / DataTable / Niagara 入图**（§18.3 #4）
- **B3. 节点级跳转**（§18.3 #9）

#### 阶段 C — 进入日常
- **C1. RAG 问答模式**（§18.4 重定义后的 #6）
- **C2. Diff 模式**（§18.3 #5）
- **C3. Comment Node 索引**（§18.3 #8）
- **C4. Modularity 自动分组**（§18.3 #7）
- **C5. 冷资产检测**（§18.3 #10）

#### 阶段 D — 锦上添花（暂不排期）
- **D1. 性能热度叠加**（§18.3 #6）—— 需要接 UE Insights，工程量大
- **D2. 本地 LLM**（原 #4）—— 等 A2 之后再评估
- **D3. Lv3 完整化（Comment/Knot/Composite）**（§18.2 #1）—— 或者放弃 Lv3 改成纯跳转

#### 必读决策点（用户提，不要 Agent 替决）
1. **vault 是否进 git？** —— 决定 A2 的输出格式（结构化 vs 全量）
2. **当前 Lv3 留还是砍？** —— 决定 D3 投入
3. **接手期 vs 日常工具的产品定位** —— 决定 C 阶段做不做
4. **LLM 预算重新分配**：去 LLM 抽取 = 节省 80% 调用，省下来的预算压去 RAG 问答 / 叙事质量？

### 18.7 commit 时机更新

§17.4 说「不要在 §18 评审前 commit」，现在 §18 完成。**建议 commit 时机**：

- 现在可以做 **第一波 commit**（§15 + §16 + §17 + §18 文档）—— 把验证通过的 P0/P1/P2 + 战略转向决定固化到 git，作为新 roadmap 起点
- **不要在 commit 时把 §18 描述成「未来计划」**，要明确是「战略转向决定」—— 后续 PR 会有大量代码改动，方向要先固化

建议 commit 拆分（替代 §17.4）：
1. `feat(scan): preserve exports/components/edges through batch + extract scanPayload helper`（P0 #1）
2. `feat(bridge): widen WBP filter + OpenInEditor jump-to-UE`（P1 #2 + #3）
3. `feat(export): one-click vault JSON export with browser download`（P2 #5）
4. `docs: HANDOFF §15-§18 — features delivered + senior UE5 review + roadmap pivot to reflection-first`

---

## 19. Session 2026-04-29（深夜段·收官）— 4 项产品决策固化 + 阶段 A 实施清单

> §18.6 抛出的 4 项必读决策点，本节由用户最终拍板。所有后续实施（§19.3 起）以本节定调为准，不再回议。

### 19.1 用户最终决策（原话固化，不要再次解读弱化）

| # | 问题 | 用户回答 | 含义 |
|---|------|---------|------|
| 1 | vault 是否进 git？ | **不进** | 每开发者本地一份。新人入职体验 = 本地跑一次完整扫描。结构化 frontmatter + LLM body 都进 .md，无 merge 冲突顾虑。**README 必须明示这一点**，否则团队会困惑 |
| 2 | 当前 Lv3 留还是砍？ | **暂时不砍**（"要砍也不难"） | D3（补 Comment/Knot/Composite 完整化）保留 roadmap 但不在阶段 A/B/C，等 C 完成后再评估 |
| 3 | 接手期 vs 日常工具的产品定位？ | **C 段一定要做**（"我们要做最牛逼的工具"） | 阶段 C 不是可选，是产品命脉。RAG 问答（C1）= Phase C 首要目标 |
| 4 | LLM 预算重新分配？ | **B + C 组合，预算不是问题**（"重点是真正能帮到用户开发"） | 见 §19.2 — 重新框定 |

### 19.2 决策对 Roadmap 的语义修正

#### A2 的动机修正：从"省钱"改为"正确性"

§18.4 / §18.6 把 A2（去 LLM 抽取）框定为"省 80% 调用量"。**这是错框**。用户决策 #4 明确"预算不是问题"，意味着：

- **A2 仍然必做，但理由换成**：Reflection 输出 100% 精确零幻觉 vs LLM 输出有概率漏字段（§15 已经爆过这个 bug 类）
- **A2 省下的 token 不要"省"，要全部投回 body 质量**（更长 context、双模型 verifier、更细 prompt 模板）
- 新增需求：**body 生成可以接受比当前更慢、更贵的策略**（例如 Anthropic Sonnet 4.6 + extended thinking + 双轮 critique）

#### B 和 C 全力投入，不分先后

用户决策 #4 = "B+C 组合"。落到工作流：
- **B（叙事质量）= A 阶段同期推进**：A2 切换到 Reflection 之后，body prompt 立刻可以重写得更细（结构 ground truth 已经在 prompt 里了，LLM 只剩叙事任务，不再要兼顾"扣字段"）
- **C（RAG 问答）= 阶段 A 完成后立即启动**，不等 B 完整。最迟在 A3 完成、B1 至少试做一个 BP 的同期，C1 可以并行启动

#### 阶段 D（性能热度叠加 / 本地 LLM）继续不排期

预算不是约束之后，本地 LLM（D2）的优先级更降低 —— 用户愿意为最牛逼的工具掏远端 API 钱。

### 19.3 阶段 A 实施清单（下次 session 起点）

**总体执行顺序**：A1 与 A2 可并行（C++ 端 vs Python/Bridge 端不同代码区），A3 必须等 A2 完成（依赖 Reflection endpoint）。

#### A1. AssetRegistry stale 监听（信任 P0）

**目标**：vault 与工程不一致时 UI 自动 mark stale，避免"vault 信息陈旧 → 用户信任崩塌 → 永不打开"（§18.2 #5）。

**C++ 端落点**：`AICartographerBridge.cpp/h`

注册 4 个 AssetRegistry 委托（在 `Initialize` 注册，`Shutdown` 反注册）：
| 事件 | 触发场景 | stale 行为 |
|---|---|---|
| `OnAssetRenamed(FAssetData, FString OldObjectPath)` | 资产改名 / 移动 | 旧路径 stale，新路径 unscanned |
| `OnAssetRemoved(FAssetData)` | 删除 | 旧路径 stale + tombstone（避免误判为 unscanned） |
| `OnAssetAdded(FAssetData)` | 新建 / 首次入 registry | 新路径 unscanned |
| `OnAssetUpdated(FAssetData)` *(UE5.x)* | 资产保存 | 路径加入"增量重扫候选"队列 |

**事件存储**：bridge 内部 ring buffer（容量 1024，FIFO 丢旧），按 monotonic counter 编号。

**新 endpoint**：
- `GET /bridge/stale-events?since=<counter>` → 返回 [{ counter, type, path, old_path? }, ...] + `latest_counter`
- `POST /bridge/stale-events/ack?upto=<counter>` → 标记前端已处理（用于丢弃但不强制）

**前端落点**：`UE_mapping_plugin/src/services/bridgeApi.ts` + 新增 `staleSync.ts`

启动时与每 30s 轮询：
1. 拉 `/bridge/stale-events?since=<localCounter>`
2. 对每个事件：
   - `Renamed` / `Removed` / `Updated` → 命中 vault 的 .md → 标 frontmatter `stale: true` + `stale_reason: "<event_type>"`
   - `Added` → 推入 unscanned list（UI 角标 +N）
3. 更新 `localCounter`

**UI**：
- 每个节点 / 笔记预览右上角红点 + tooltip "工程已变更：<reason>，建议重扫"
- 工具栏按钮 "🔁 只重扫 stale" → 调 `/scan/incremental?paths=[...]`（已存在 batch 扫描，扩 path 过滤即可）

**MVP 收口**：先做 OnAssetRenamed + OnAssetRemoved 两个事件（覆盖最常见的"vault 找不到对应资产"窟窿），OnAssetAdded / OnAssetUpdated 可后置 PR。

#### A2. 结构化字段去 LLM 化（准确性 P0 + 为 B 铺路）

**目标**：`exports / components / edges / properties / ast_hash` 全部由 Reflection + AssetRegistry 计算，LLM 只生成 `body` 叙事。

**新 bridge endpoint**：`GET /reflection/asset-summary?path=<asset_path>`

返回 schema：
```typescript
type AssetSummary = {
  asset_path: string;
  class_path: string;                          // /Script/Engine.Blueprint 等
  parent_class: string | null;                 // 继承
  exports: Array<{
    name: string;
    return_type: string;
    params: Array<{ name: string; type: string; flags: string[] }>;
    flags: ('BlueprintCallable' | 'BlueprintImplementableEvent' | 'BlueprintNativeEvent' | 'Pure' | 'Latent')[];
  }>;
  components: Array<{
    name: string;
    class: string;
    is_default_subobject: boolean;
  }>;
  properties: Array<{
    name: string;
    type: string;
    flags: ('EditAnywhere' | 'BlueprintReadOnly' | 'BlueprintReadWrite' | 'Replicated' | ...)[];
    default_value: string | null;
  }>;
  edges: {
    hard_refs: string[];      // FAssetRegistryDependencyOptions::HardReferences
    soft_refs: string[];
    interfaces: string[];     // implemented interfaces
  };
  ast_hash: string;           // sha256 over sorted(exports + components + properties + edges)
  scanned_at: string;         // ISO timestamp
};
```

**C++ 实现路径**（双策略，根据资产类型选）：
1. **快路径**（不加载资产）：用 `IAssetRegistry::GetAssetsByPath` 拿 `FAssetData`，从 `Tags`（`UBlueprint::GetAssetRegistryTags` 已经塞了大量元数据）解析 exports / parent class
2. **完整路径**（加载 BPGC）：对蓝图资产 `LoadObject<UBlueprintGeneratedClass>` → walk `FuncMap` / `PropertyLink`，对 C++ class 直接 `UClass::FindFunctionByName` 的反向枚举
3. **edges**：恒走 `IAssetRegistry::GetDependencies(asset_path, FAssetRegistryDependencyOptions{HardReferences=true, ...})`

**Python 改造**：`backend/main.py::analyze_one_node()`

旧版（伪码）：
```python
async def analyze_one_node(asset_path):
    prompt = build_prompt(asset_path, k2node_dump)
    raw = await llm.complete(prompt)             # 同时出结构 + 叙事
    parsed = parse_yaml_frontmatter(raw)         # ← 这里出过 §15 的漏字段 bug
    write_md(parsed)
```

新版：
```python
async def analyze_one_node(asset_path):
    # 阶段 1：结构（确定性，零 LLM）
    summary = await bridge.get('/reflection/asset-summary', path=asset_path)

    # 阶段 2：叙事（LLM only writes body）
    prompt = build_narrative_prompt(
        structural_truth=summary,                # 给 LLM 结构 ground truth
        k2node_dump=await bridge.get_k2nodes(asset_path),
        narrative_mode='interactive',            # §14 互动叙事模板
    )
    body_md = await llm.complete(prompt)         # 不再要求 LLM 输出 frontmatter

    # 阶段 3：写盘（结构 from bridge，body from LLM）
    write_md(
        frontmatter=summary | { 'stale': False, 'scanned_at': now() },
        body=body_md,
    )
```

**B（叙事质量）落到这里**：因为 LLM 不再扣字段，prompt 可以重写为"假设结构已知，请生成对开发者最有价值的 EXECUTION FLOW / INTERACTIONS / PITFALLS"。预算不限 → 可以同时跑：
- 主模型生成 body
- 第二轮 critique（小模型 / 同模型不同温度）找漏 / 找错
- 必要时第三轮重写

**MVP 收口**：先做 BP 资产的快路径（AssetRegistry tags），完整路径（BPGC load + FuncMap）作为第二个 PR。DataAsset / WBP / Niagara 走 B2 扩展。

#### A3. 第 5 级视图：跨 BP 调用追踪图（兑现 §18.4 战略判断）

**目标**：以任意 `(asset, function)` 为根，BFS N 跳内的全工程调用图。**这是日常 debug / 重构最高频视图**，也是工具从"接手期"进入"日常"的临门一脚。

**数据模型**：
```typescript
type TraceGraph = {
  root: { asset: string; function: string };
  depth: number;                  // 默认 3
  nodes: Array<{
    id: string;                   // asset::function
    asset: string;
    function: string | null;      // null = asset 节点（用于 spawn / 持有关系）
    is_cpp: boolean;              // 跨语言边界标记
    layer: number;                // BFS 层级 0..depth，用于 concentric layout
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: 'call' | 'event' | 'delegate' | 'interface' | 'cast' | 'spawn';
    location: { asset: string; node_guid: string } | null;  // 可跳到 K2Node（依赖 B3）
  }>;
};
```

**新 bridge endpoint**：`GET /trace/from?asset=...&function=...&depth=3&edge_types=call,event,delegate`

**C++ 端实现**：
- 入口：`UBlueprint::UbergraphPages` + 各 FunctionGraph 遍历
- 对每个 `UEdGraphNode`：
  - `UK2Node_CallFunction` → call edge，target 解析 `FunctionReference.GetMemberParentClass()` + `MemberName`
  - `UK2Node_Event` → event 入口（被调端）
  - `UK2Node_DynamicCast` → cast edge（弱关系，可选）
  - `UK2Node_AddDelegate` / `UK2Node_CallDelegate` → delegate edge
  - `UK2Node_InterfaceMessage` → interface edge（跨 BP 强信号）
  - `UK2Node_SpawnActorFromClass` → spawn edge（用于追"谁创建了这个 Actor"）
- BFS：以 root 入队，depth 用尽或达到 max_nodes（默认 200）停

**前端**：
- 新增 `Lv5CallTrace.tsx`（与 Lv1-4 平级）
- 布局：concentric d3-force（root 在中心，按 BFS layer 同心环），允许过滤 edge_types
- 每个边可点击 → 跳到 K2Node（B3 落地后）；当前阶段先实现跳到 BP 资产

**MVP 收口**：
- 只做 `call` + `event` 两种边
- 只做 BP→BP，is_cpp=true 时画灰色"C++ 边界"占位（B1 完成后接通）
- max_depth=3，max_nodes=100

### 19.4 待用户授权事项

#### 4 段 commit 是否现在执行？

§17.4 / §18.7 计划的 4 段 commit 至今未执行。当前主仓 master 有 14 个文件未提交（§19 完成后 HANDOFF.md 也加入待提交）：

```
M  HANDOFF.md                          (§15-§19 文档)
M  Plugins/.../AICartographerBridge.cpp (P1 OpenInEditor + WBP)
M  Plugins/.../AICartographerBridge.h
M  UE_mapping_plugin/src/components/levels/Lv2BlueprintFocus.tsx (跳转 UI)
M  UE_mapping_plugin/src/components/levels/Lv3FunctionFlow.tsx
M  UE_mapping_plugin/src/components/settings/SettingsModal.tsx
M  UE_mapping_plugin/src/services/bridgeApi.ts (跳转 API)
M  UE_mapping_plugin/src/services/frameworkScan.ts (P0 字段保留)
M  UE_mapping_plugin/src/services/projectScan.ts (P0 字段保留)
M  UE_mapping_plugin/src/services/vaultApi.ts (P2 JSON 导出)
?? UE_mapping_plugin/src/services/scanPayload.ts (P0 helper)
M  backend/main.py
M  backend/vault_writer.py
```

建议 commit 拆分（与 §18.7 一致，但 docs 段升到 §15-§19）：
1. `feat(scan): preserve exports/components/edges through batch + extract scanPayload helper`（P0 #1）
2. `feat(bridge): widen WBP filter + OpenInEditor jump-to-UE`（P1 #2 + #3）
3. `feat(export): one-click vault JSON export with browser download`（P2 #5）
4. `docs: HANDOFF §15-§19 — features delivered + senior UE5 review + roadmap + Phase A spec`

**等用户一句"commit"或"先不 commit"再动**。

#### 分支策略

阶段 A 三件事（A1/A2/A3）建议各开一个 PR / 分支：
- `feat/stale-asset-registry-listener`（A1，纯 C++ + 前端轮询）
- `feat/reflection-asset-summary`（A2，bridge endpoint + analyze_one_node 重构）
- `feat/cross-bp-call-trace`（A3，新视图 Lv5）

A1 与 A2 可并行，A3 等 A2。

#### README 更新（决策 #1 影响）

vault 不进 git → README 必须新增章节明示：
- vault/ 目录加入 .gitignore（如未加）
- 新人入职流程："拉代码 → 启 plugin → 按 Scan project → 等扫描完 → 用工具"
- 团队协作：vault 不分享，分享的是 plugin / 后端配置

这条不属于阶段 A，但属于"决策 #1 的副作用"，下次 commit README 时一并改。

### 19.5 下次 session 开工动作（精确）

1. 用户授权后执行 §19.4 的 4 段 commit
2. 在 master 起 `feat/stale-asset-registry-listener` 分支，开始 A1（C++ 端 4 个委托注册 + 1 个新 endpoint）
3. 同期可起 `feat/reflection-asset-summary` 分支开 A2（不冲突）
4. A2 完成后立即重写 narrative prompt（B 投资）→ 跑一次完整扫描验证 body 质量提升
5. A3 等 A2 merge

