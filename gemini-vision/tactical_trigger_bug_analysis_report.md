# 战术核按钮故障分析报告
## 基本信息
| 项 | 值 |
| --- | --- |
| Bug ID | BUG-20260417-004 |
| 报告时间 | 2026-04-17 |
| 影响组件 | 前端 Sidebar 组件 |
| 严重级别 | 高（P1） |
| 复现条件 | 前端未重新构建/代码未生效 |

## 问题描述
1. **按钮状态异常**：Redis离线时按钮未变为灰色禁用状态，仍显示旧文字`Execute Volcengine AI`
2. **点击报错**：点击按钮抛出JS错误：`❌ Error: Cannot read properties of undefined (reading 'forEach')`
3. **降级策略失效**：未按预期屏蔽批量扫描功能，仍然执行旧逻辑

## 根因分析
### 根因1：前端代码修改未生效（90%概率）
现有表现（按钮显示旧文字、点击执行旧逻辑）100%匹配前端代码未更新的特征：
- 按钮仍然绑定旧的`handleAIAnalysis`事件处理函数，而非新的`startGlobalScan`
- 按钮未与新状态`isRedisAvailable`/`batchScanStatus`绑定，因此不会自动变灰
- 旧逻辑中的`analyzeArchitecture`接口已经被废弃/修改，返回`undefined`，导致后续`applyClusters(result.clusters)`调用时对`undefined`执行`forEach`抛出报错

### 根因2：健康检查逻辑未初始化
新的批量功能依赖`initHealthCheck()`方法初始化Redis状态，但该方法从未在应用入口（如`App.tsx`的`useEffect`）中被调用，导致`isRedisAvailable`状态永远停留在初始值`false`，无法随Redis状态动态更新。

### 根因3：代码缓存问题
- 前端开发服务器存在缓存，未重新构建加载最新代码
- 浏览器缓存了旧版本JS资源

## 验证方法
1. 检查浏览器控制台Sources面板中`Sidebar.tsx`的代码是否包含新的按钮文案：`[ TACTICAL TRIGGER ] GLOBAL BATCH ANALYSIS`
2. 如果代码是旧版本：确认已执行前端构建流程（`npm run build`或重启`npm run dev`）
3. 如果代码是新版本：检查应用入口`App.tsx`是否包含如下初始化逻辑：
   ```tsx
   useEffect(() => {
     useGraphStore.getState().initHealthCheck();
   }, []);
   ```

## 临时解决方案
无需修改代码，按如下步骤操作即可恢复正常：
1. 终止前端开发服务器
2. 清空浏览器缓存/强制刷新（Ctrl+Shift+R）
3. 重新启动前端开发服务器（`npm run dev`）
4. 确认按钮已经显示新的战术核按钮文案，Redis离线时自动变灰
5. （可选）在`App.tsx`中添加健康检查初始化逻辑，确保Redis状态动态更新

## 修复方案（如需修改代码）
1. 在`App.tsx`应用入口添加健康检查初始化逻辑，确保Redis状态随服务状态动态更新
2. 清理前端构建缓存，强制重新生成最新资源
3. （可选）在`analyzeArchitecture`方法中添加返回值校验，防止空值导致后续报错
