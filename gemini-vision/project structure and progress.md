# AICartographer 蓝图智能分析工具 项目架构与开发进度总结
## 项目概述
AICartographer是专为Unreal Engine 5打造的蓝图资产智能分析工具，通过C++插件嵌入Web前端的混合架构，实现UE蓝图资产的全局扫描、拓扑可视化、AST智能语义分析等核心功能。当前Sprint 2开发已全部完成，支持完整的蓝图深度钻取与AI架构分析能力。
---
## 整体项目结构
```
D:\Amour\UEproject\Cropout
├── UE_mapping_plugin/          # 前端Web UI
├── Plugins/AICartographer/     # UE C++ 插件
├── backend/                    # 火山引擎AI分析服务
└── gemini-vision/              # 项目文档与资料
```
---
## 1. 前端模块：UE_mapping_plugin
### 技术栈
- **基础框架**：React 18 + TypeScript 5 + Vite 8
- **拓扑引擎**：React Flow 11
- **状态管理**：Zustand
- **样式方案**：Tailwind CSS 4 + PostCSS
### 目录结构
```
UE_mapping_plugin/src
├── components/
│   ├── graph/
│   │   ├── GraphCanvas.tsx          # 主画布组件
│   │   ├── InsightPanel.tsx         # 战术终端洞察面板（可折叠、半透、滚动）
│   │   └── nodes/
│   │       ├── SystemNode.tsx       # 全局蓝图资产节点
│   │       ├── BlueprintNode.tsx    # 蓝图拓扑节点（TE工业风格）
│   │       └── ClusterGroupNode.tsx # 资产分组节点
│   ├── layout/
│   │   └── TacticalBreadcrumb.tsx   # 层级导航面包屑
│   └── sidebar/                      # 侧边栏功能面板
├── services/
│   ├── engineBridge.ts               # UE C++ RPC桥接层（含路径净化、AST格式化）
│   └── llmService.ts                 # LLM分析服务封装
├── store/
│   └── useGraphStore.ts              # 全局状态管理（视图模式、蓝图缓存、AI分析状态）
├── types/
│   └── graph.ts                      # TypeScript类型定义
├── App.tsx                           # 根组件
└── App.css                           # 全局样式（自定义滚动条）
```
### 核心功能模块
| 模块 | 功能说明 |
|------|----------|
| 全局资产扫描 | 调用UE C++接口扫描整个项目所有蓝图资产，自动布局可视化 |
| 深度钻取 | 点击资产节点即可触发C++侧蓝图懒加载，自动解析蓝图AST并渲染拓扑图 |
| 战术洞察面板 | TE工业风格可折叠悬浮面板，展示AI语义分析结果，支持长文本滚动 |
| 蓝图拓扑渲染 | 1:1还原UE编辑器中蓝图节点坐标、引脚、连接关系，和原生编辑器视觉一致 |
| 双视图切换 | 全局资产视图/蓝图拓扑视图一键切换，自动缓存全局资产数据无需重复扫描 |
### 核心特性
- 严格Teenage Engineering工业美学设计：黑橙配色、等宽字体、未来复古风格
- 面板支持点击折叠，最大化画布可视空间
- 自定义极简滚动条，hover时橙色高亮，符合整体设计语言
- 85%半透毛玻璃效果，减少对底层蓝图视图的遮挡
- 全链路异常处理，网络/AI错误友好提示
---
## 2. UE C++ 插件：Plugins/AICartographer
### 技术栈
- Unreal Engine 5.3+ 兼容
- C++17标准
- 依赖模块：Slate, WebBrowser, UnrealEd, AssetRegistry, BlueprintGraph
### 目录结构
```
Plugins/AICartographer
├── Source/AICartographer/
│   ├── Public/
│   │   └── AICartographerBridge.h    # 对外暴露的RPC桥接接口
│   ├── Private/
│   │   ├── AICartographerBridge.cpp  # 桥接接口实现，AST提取净化
│   │   └── AICartographer.cpp        # 插件入口与Slate WebUI初始化
│   └── AICartographer.Build.cs       # 编译配置，依赖声明
└── Resources/
    └── WebUI/
        └── index.html                # 前端构建产物（自动打包生成）
```
### 核心功能
| 模块 | 功能说明 |
|------|----------|
| 全局资产扫描 | 遍历UE项目Content目录下所有蓝图资产，返回资产列表与路径信息 |
| 蓝图懒加载 | 按需加载指定蓝图资源，仅在触发深度扫描时加载，不影响编辑器性能 |
| AST提取净化 | 解析蓝图Ubergraph与FunctionGraph，过滤低价值节点（纯数学运算、getter/setter），仅保留业务节点 |
| JS RPC桥接 | 实现C++和Web前端双向通信，前端调用C++接口，C++主动回调推送AST数据 |
| 坐标映射 | 提取蓝图节点在UE编辑器中的原生坐标，前端1:1还原拓扑布局 |
### 关键实现细节
1. **C++<->JS通信机制**：通过UE WebBrowser的BindUObject绑定桥接实例，前端直接调用`ue.aicartographerbridge`对象上的接口，无需网络请求
2. **AST净化逻辑**：仅保留`CallFunction`/`Event`/`CustomEvent`三类高价值业务节点，过滤冗余视觉节点，避免LLM分析干扰
3. **资产安全扫描**：采用UE官方AssetRegistry接口，仅扫描磁盘上实际存在的资产，排除无效引用与临时对象
4. **弱引用设计**：所有WebBrowser引用采用弱指针，避免内存泄漏与野指针崩溃
---
## 3. 后端服务：backend
### 技术栈
- FastAPI + Uvicorn
- OpenAI SDK（兼容火山引擎方舟接口）
- Python 3.10+
### 目录结构
```
backend
├── main.py               # FastAPI主服务
├── .env                  # 环境变量（火山引擎API密钥、端点ID）
└── dump_AST_*.json       # 运行时自动生成的AST落盘文件
```
### 核心功能
1. **AI语义分析**：接收前端传来的蓝图AST，调用火山引擎大模型生成结构化分析报告
2. **AST物理落盘**：自动保存所有请求的AST数据到本地JSON文件，便于调试与数据集积累
3. **跨域支持**：全局CORS配置，支持UE内置浏览器跨域访问
4. **严格错误处理**：完整异常捕获与日志，AI服务不可用时返回友好错误提示
### 输出格式
严格按照固定结构返回分析结果，前端自动渲染：
```markdown
### [ INTENT ]
蓝图核心功能说明
### [ EXECUTION FLOW ]
- 节点1执行逻辑
- 节点2执行逻辑
### [ I/O & MUTATIONS ]
输入输出与状态变更说明
### [ ARCHITECTURAL RISK ]
风险提示或SYSTEM NOMINAL
```
---
## 开发进度总结
### ✅ 已完成功能
- [x] UE全局蓝图资产扫描与自动拓扑布局
- [x] 蓝图深度钻取与AST 1:1可视化还原
- [x] 火山引擎AI语义分析集成
- [x] TE风格可折叠半透洞察面板
- [x] 双视图无缝切换与状态缓存
- [x] 全链路异常处理与错误提示
- [x] AST数据自动落盘持久化
- [x] UE5.3/5.4全版本兼容
### 🔧 技术亮点
1. **混合架构优势**：C++侧实现高性能资产扫描与AST解析，JS侧实现灵活交互与可视化，兼顾性能与体验
2. **零侵入设计**：作为UE编辑器插件运行，无需修改项目代码，开箱即用
3. **工业级美学**：全界面严格遵循Teenage Engineering设计语言，交互极简高效
4. **高可扩展性**：AST标准化格式，支持对接任意大模型，可扩展更多分析维度
---
## 构建部署说明
### 前端构建
```bash
cd D:\Amour\UEproject\Cropout\ue_mapping_plugin
npm run build
```
自动将产物打包到`../Plugins/AICartographer/Resources/WebUI/index.html`，无需手动拷贝
### C++插件构建
在UE编辑器中点击`编译`按钮，或在VS中编译`CropoutEditor`目标，自动完成插件编译
### 后端启动
```bash
cd D:\Amour\UEproject\Cropout\backend
python main.py
```
默认在`http://0.0.0.0:8000`启动服务，前端自动对接该地址
---
## 后续扩展方向
1. 支持蓝图函数子图钻取
2. 多蓝图架构依赖分析
3. 蓝图性能瓶颈自动检测
4. 自定义扫描规则配置
5. 分析报告批量导出
