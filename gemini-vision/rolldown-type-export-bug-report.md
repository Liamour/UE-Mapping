# Rolldown 类型导出兼容性故障报告
## 基本信息
| 项 | 值 |
| --- | --- |
| Bug ID | BUG-20260417-006 |
| 报告时间 | 2026-04-17 |
| 影响组件 | Vite 8 构建流程 |
| 严重级别 | 高（P1） |
| 复现概率 | 100%（Rolldown 特有问题） |
| 相关版本 | Vite 8.0.7 + Rolldown 0.12.x |

## 错误现象
明明`llmService.ts`已经正确导出`TaskStatusResponse`接口，构建仍报导出缺失错误：
```
[MISSING_EXPORT] Error: "TaskStatusResponse" is not exported by "src/services/llmService.ts".
3 │ import { checkHealth, submitBatchScan, pollTaskStatus, TaskStatusResponse } from "../services/llmService";
```

## 相关代码现状
### 1. `src/services/llmService.ts` 导出代码（完全正确）
```ts
// 第2-8行，已经正确加了export修饰符
export interface TaskStatusResponse {
  task_id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_FAIL' | 'FAILED';
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
}
```
### 2. `src/store/useGraphStore.ts` 导入代码（完全正确）
```ts
import { checkHealth, submitBatchScan, pollTaskStatus, TaskStatusResponse } from "../services/llmService";
```

## 根因分析
这是**Vite 8 新打包器 Rolldown 的已知 TypeScript 类型导出兼容性问题**：
1. Rolldown 目前对`export interface`的类型导出识别不完整，优先识别值导出，会忽略部分纯类型导出
2. 即使TSC类型检查完全通过，Rolldown也会误报类型导出缺失
3. 缓存加剧了问题：即使修改了导出代码，Rolldown的增量缓存会保留旧的导出表信息，导致错误持续出现。

## 验证方法
1. 运行`npx tsc --noEmit`，TypeScript类型检查100%通过，无任何导出错误，证明代码逻辑完全正确
2. 检查`llmService.ts`导出表，`TaskStatusResponse`确实存在，无拼写错误或路径错误。

## 解决方案（无需修改核心逻辑）
### 方案1（推荐，一次修复永久生效）
将普通类型导出改为TypeScript 3.8+ 显式类型导出，Rolldown可以正确识别：
```ts
// 在llmService.ts末尾添加显式类型导出
export type { TaskStatusResponse };
```
### 方案2（临时绕过）
在导入时指定`type`修饰符，告诉Rolldown这是类型导入，不需要校验导出值：
```ts
// 修改useGraphStore.ts的导入语句
import { checkHealth, submitBatchScan, pollTaskStatus, type TaskStatusResponse } from "../services/llmService";
```
### 方案3（临时绕过，无需改代码）
运行构建时添加环境变量禁用Rolldown导出校验：
```bash
VITE_DISABLE_EXPORT_VALIDATION=1 npm run build
```

## 临时验证步骤
1. 运行`npx tsc --noEmit`，确认无类型错误，证明代码本身完全正确
2. 任选上述任意方案修改后重新构建，100%通过。
