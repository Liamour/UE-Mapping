1. 项目使用的框架版本及依赖
[虚幻引擎端 - Editor 插件]
引擎版本：Unreal Engine 5.7（强制执行，拒绝任何兼容 UE4 的妥协）。
C++ 标准：C++17/C++20, UE 5.7 官方API接口：https://dev.epicgames.com/documentation/unreal-engine/API
核心依赖模块：Slate, SlateCore, WebBrowser, UnrealEd, AssetRegistry。
[Web 前端端 - 逻辑渲染层],
构建基座：Vite 8.x + React 18.x + TypeScript 5.x（严格模式开启）。
拓扑图引擎：React Flow 11.x。
状态与UI：Zustand（状态机）, TailwindCSS 4 + PostCSS（原子化样式）。
2. 测试框架的详细要求
[双端隔离测试原则]
C++ 层测试：采用 Unreal Automation Framework。必须针对“资产扫描器 (AssetScanner)”和“JSON 序列化器”编写底层自动化测试，确保在千万级项目中不会出现内存泄漏。
前端层测试：采用 Vitest + React Testing Library。
覆盖率红线：禁止为纯 UI 组件写无效测试。必须对 Zustand Store 的状态变更逻辑，以及从 C++ 接收到 JSON 后的“数据清洗函数 (Data Parsers)”做到 100% 的分支测试覆盖率。
3. 绝对禁止使用的 API 与模式
严禁 Runtime 污染：禁止在非 WITH_EDITOR 宏作用域下调用任何编辑器专属 API。
严禁阻塞主线程：禁止在 GameThread 中使用同步 I/O（如 FFileHelper::LoadFileToString）去暴力遍历 Content 文件夹，必须使用 AssetRegistry 异步加载或 FRunnable 拆分任务。
禁止同步渲染阻塞：接收 UE 传来的超大 JSON 时，严禁同步解析。必须使用 Web Worker 或 requestIdleCallback 避免浏览器进程卡死。