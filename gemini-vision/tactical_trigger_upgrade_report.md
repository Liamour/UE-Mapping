# 战术核按钮 (Tactical Trigger) 升级报告
## 基本信息
| 项 | 值 |
| --- | --- |
| 按钮原名称 | EXECUTE VOLCENGINE AI |
| 代码位置 | `D:\Amour\UEproject\Cropout\UE_mapping_plugin\src\components\layout\Sidebar.tsx` |
| 代码行号 | 259-269行 |
| 原绑定事件 | `handleAIAnalysis()` |
| 原功能 | 火山引擎AI语义聚类，自动分类摆放蓝图资产节点 |

## 现有代码分析
```tsx
// 原按钮实现
<button
    onClick={handleAIAnalysis}
    disabled={isAnalyzing}
    className={`w-full font-black uppercase tracking-widest py-3.5 px-4 rounded-2xl transition-all duration-75 border ${
        isAnalyzing 
            ? 'bg-[#333333] border-[#444444]/50 text-[#888888] cursor-not-allowed' 
            : 'bg-gradient-to-b from-[#ff7711] to-[#e65c00] text-[#0a0a0a] shadow-[0_6px_0_0_#b34700,0_8px_15px_rgba(0,0,0,0.5)] hover:shadow-[0_4px_0_0_#b34700,0_5px_10px_rgba(0,0,0,0.5)] hover:translate-y-[2px] active:shadow-[0_0_0_0_#b34700] active:translate-y-[6px] border-[#ff9955]/40'
    } flex items-center justify-center gap-2`}
>
    {isAnalyzing ? 'Deep Reasoning...' : 'Execute Volcengine AI'}
</button>
```
原功能已经被新的批量异步扫描架构完全替代，符合升级改造条件。

## 升级落地方案
### 1. 功能替换
- **事件替换**：将原`handleAIAnalysis`点击事件替换为调用`useGraphStore`中的`startGlobalScan()`方法，触发全量蓝图资产批量异步分析
- **状态关联**：绑定`isRedisAvailable`状态，Redis不可用时自动禁用按钮，提示批量功能离线
- **状态同步**：绑定`batchScanStatus`状态，扫描过程中显示实时进度提示

### 2. UI改造 (保持Teenage Engineering美学)
- **按钮文本**：默认状态改为`[ TACTICAL TRIGGER ] GLOBAL BATCH ANALYSIS`
- **禁用状态**：Redis不可用时显示`[ REDIS OFFLINE ] BATCH MODE DISABLED`，灰色禁用样式
- **扫描状态**：批量分析过程中显示`[ PROCESSING ] {completed}/{total} NODES ANALYZED`，橙色脉冲动画增强

### 3. 代码改造示例
```tsx
// 引入状态
const { isRedisAvailable, batchScanStatus, startGlobalScan } = useGraphStore();

// 替换按钮实现
<button
    onClick={startGlobalScan}
    disabled={!isRedisAvailable || batchScanStatus === 'PROCESSING'}
    className={`w-full font-black uppercase tracking-widest py-3.5 px-4 rounded-2xl transition-all duration-75 border ${
        !isRedisAvailable || batchScanStatus === 'PROCESSING'
            ? 'bg-[#333333] border-[#444444]/50 text-[#888888] cursor-not-allowed' 
            : 'bg-gradient-to-b from-[#ff7711] to-[#e65c00] text-[#0a0a0a] shadow-[0_6px_0_0_#b34700,0_8px_15px_rgba(0,0,0,0.5)] hover:shadow-[0_4px_0_0_#b34700,0_5px_10px_rgba(0,0,0,0.5)] hover:translate-y-[2px] active:shadow-[0_0_0_0_#b34700] active:translate-y-[6px] border-[#ff9955]/40'
    } flex items-center justify-center gap-2`}
>
    {!isRedisAvailable 
        ? '[ REDIS OFFLINE ] BATCH MODE DISABLED'
        : batchScanStatus === 'PROCESSING'
            ? '[ PROCESSING ] GLOBAL ANALYSIS RUNNING'
            : '[ TACTICAL TRIGGER ] GLOBAL BATCH ANALYSIS'
    }
</button>
```

### 4. 兼容方案
- 原有`handleAIAnalysis`功能可以保留作为隐藏入口，或者迁移到设置菜单中
- 完全兼容现有节点状态显示逻辑，无需改动SystemNode组件
- 优雅降级：Redis不可用时按钮自动禁用，不影响单节点深度扫描功能
