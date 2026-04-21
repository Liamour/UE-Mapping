# TaskStatusResponse 导出缺失故障报告
## 基本信息
| 项 | 值 |
| --- | --- |
| Bug ID | BUG-20260417-005 |
| 报告时间 | 2026-04-17 |
| 影响组件 | 前端 llmService.ts / useGraphStore.ts |
| 严重级别 | 致命（P0） |
| 复现概率 | 100% |
| 构建阶段 | 生产构建（npm run build）时必现 |

## 错误描述
```
[MISSING_EXPORT] Error: "TaskStatusResponse" is not exported by "src/services/llmService.ts".
3 │ import { checkHealth, submitBatchScan, pollTaskStatus, TaskStatusResponse } from "../services/llmService";
│                                                        ─────────┬────────
│                                                                 ╰────────── Missing export
```
构建完全失败，无法生成部署包。

## 根因分析
1. **直接原因**：`llmService.ts`文件中缺失`TaskStatusResponse`的`export`声明，`useGraphStore.ts`导入该类型失败。
2. **历史操作原因**：之前重复处理类型导出时，误将文件顶部的`export interface TaskStatusResponse`声明删除，同时也删除了文件中部原来的导出声明，导致整个文件无任何`TaskStatusResponse`导出。
3. **辅助原因**：Rolldown构建器的类型导出校验比TSC更严格，即使TypeScript类型检查通过，只要导出表中无该类型也会直接失败。

## 验证方法
打开`src/services/llmService.ts`文件，检查是否存在如下代码：
```ts
export interface TaskStatusResponse {
  task_id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL_FAIL' | 'FAILED';
  total_nodes: number;
  completed_nodes: number;
  failed_nodes: number;
}
```
**预期：** 文件顶部不存在该导出声明。

## 临时解决方案（无需修改代码）
1. 打开`src/services/llmService.ts`文件
2. 在文件头部（第一行注释下方）手动添加上述`TaskStatusResponse`导出声明
3. 执行`npm run build --force`强制重新构建，所有错误自动消失。

## 永久避免方案
1. 禁止在类型导出文件中重复定义同名类型
2. 导出声明统一放在文件头部，便于排查
3. 提交代码前执行`npm run build`预检查，提前发现导出错误
