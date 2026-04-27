# AICartographer 项目交接文档

> 最后更新：2026-04-27（auto-mode session 切换前的快照）
> 上一段对话已被 /compact 压缩，这份文档把工程状态、架构、未完成任务一次性交给下一个 session。

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

## 9. 启动新 session 时的建议

1. 先 `git add -A && git commit -m "WIP: Lv1-3 + bridge schema fix"` 把当前进度快照固化
2. 决定走 A 还是 B（用户已倾向 B）
3. 走 B 的话先动 C++（因为要 rebuild），动完 .h/.cpp 让用户在 UE 里 build；同时前端可以把 UI 编排和桥 wrapper 写好等桥就绪后无缝接上
4. 不要碰 LLM key、不要 force push、不要跳 hooks
