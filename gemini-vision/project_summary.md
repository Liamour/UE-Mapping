# UE AI Cartographer 插件项目结构总结
## 项目架构总览
本项目是UE5编辑器插件 + Web前端混合架构的AI拓扑图绘制工具，分为两大核心模块：
1. **UE编辑器插件层 (AICartographer)**：负责编辑器集成、Web容器托管
2. **Web前端层 (UE_mapping_plugin)**：负责拓扑图渲染、交互逻辑、状态管理

---

## 1. UE插件模块 (AICartographer)
### 文件结构
```
Plugins/AICartographer/
├── AICartographer.uplugin       # 插件配置文件
├── Resources/
│   └── Icon128.png              # 插件图标
└── Source/AICartographer/
    ├── AICartographer.Build.cs  # 构建配置、依赖声明
    ├── AICartographer.h         # 模块类声明
    └── AICartographer.cpp       # 模块实现
```

### 核心依赖
| 依赖模块 | 用途 |
|---------|------|
| Core/CoreUObject/Engine | UE基础框架 |
| Slate/SlateCore | UI框架 |
| WebBrowser | 内嵌Web容器 |
| WorkspaceMenuStructure | 编辑器菜单集成 |

### 核心逻辑
1. **模块生命周期**
   - `StartupModule()`：注册编辑器Tab spawner，菜单项显示为"AICartographer Web UI"
   - `ShutdownModule()`：注销Tab spawner
2. **Tab实现**
   - 创建SDockTab容器，内嵌SWebBrowser控件
   - 默认加载地址：`http://localhost:5173/` (前端开发服务器地址)
   - 禁用浏览器控件，启用透明背景

---

## 2. 前端模块 (UE_mapping_plugin)
### 文件结构
```
UE_mapping_plugin/
├── package.json                  # 依赖配置
├── vite.config.ts                # Vite构建配置
├── tailwind.config.js            # TailwindCSS配置
├── tsconfig.json                 # TypeScript配置
├── index.html                    # 入口HTML
├── public/                       # 静态资源
└── src/
    ├── main.tsx                  # 应用入口
    ├── App.tsx                   # 根组件
    ├── components/
    │   ├── graph/
    │   │   ├── GraphCanvas.tsx   # React Flow画布组件
    │   │   └── nodes/
    │   │       └── SystemNode.tsx # 自定义节点组件
    │   └── layout/
    │       └── Sidebar.tsx       # 侧边栏组件
    ├── store/
    │   └── useGraphStore.ts      # Zustand状态管理
    ├── types/
    │   └── graph.ts              # 类型定义
    └── assets/                   # 静态资源
```

### 技术栈
| 技术 | 版本 | 用途 |
|------|------|------|
| React | 19.x | 前端框架 |
| TypeScript | 6.x | 类型安全 |
| Vite | 8.x | 构建工具 |
| React Flow | 11.x | 拓扑图引擎 |
| Zustand | 5.x | 状态管理 |
| TailwindCSS | 4.x | 样式框架 |

### 核心模块
1. **状态层 (useGraphStore)**
   - 管理画布节点、边、布局等全局状态
   - 提供节点增删改查、布局调整等操作方法
2. **渲染层 (GraphCanvas)**
   - React Flow画布封装
   - 处理节点拖拽、连线、缩放等交互
3. **组件层**
   - SystemNode：自定义节点UI
   - Sidebar：工具栏/资源面板

---

## 3. 调用关系与数据流
### 整体链路
```
┌─────────────────────────────────┐
│ UE Editor                       │
│  ┌───────────────────────────┐  │
│  │ AICartographer Plugin     │  │
│  │  ┌─────────────────────┐  │  │
│  │  │ SWebBrowser         │  │  │
│  │  │  (localhost:5173)   │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└───────────────┬─────────────────┘
                │ HTTP/WebSocket
┌───────────────▼─────────────────┐
│ Web Frontend (React + ReactFlow)│
│  ┌───────────────────────────┐  │
│  │ Zustand Store             │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │ GraphCanvas + Nodes       │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 通信协议
- 当前版本：前端运行在独立开发服务器，UE通过WebBrowser加载
- 后续可通过WebBrowser的ExecuteJavaScript/JSBridge实现UE <-> 前端双向通信

---

## 4. 开发流程
1. **前端开发**：进入UE_mapping_plugin目录，执行`npm run dev`启动开发服务器
2. **UE开发**：编译AICartographer插件，启动UE编辑器，打开"AICartographer Web UI"Tab
3. **生产构建**：执行`npm run build`，将产物打包到UE插件的Resources目录，修改SWebBrowser加载本地文件

---

## 5. 约束与规范
遵循项目根目录`.trae/rules/ueplugin.md`规则：
1. UE层：UE5.3/5.4兼容，C++17/20，编辑器API必须包裹在WITH_EDITOR宏
2. 前端层：严格TypeScript模式，全局状态使用Zustand，大数据解析使用Web Worker
3. 测试要求：C++层使用Unreal Automation Framework，前端层使用Vitest
