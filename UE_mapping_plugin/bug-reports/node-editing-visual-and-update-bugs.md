# 节点编辑功能Bug报告
## 问题1：编辑状态下文字变黑不可见
### 现象
双击节点进入编辑状态时，输入框内的文字变为纯黑色，与深色背景融为一体，完全无法看清输入内容。头部标签（Blueprint）和主标题编辑均存在此问题。
### 根因分析
1. **CEF默认样式优先级冲突**：UE内嵌CEF浏览器对textarea表单元素有内置的用户代理样式，默认color为黑色，优先级高于我们设置的Tailwind text-white/text-gray-500类
2. **textarea样式缺失必要重置**：没有显式禁用系统默认表单样式，导致自定义文字颜色被覆盖
3. **潜在focus样式问题**：部分CEF版本中focus状态下的textarea会强制继承系统颜色，忽略自定义样式

---

## 问题2：修改节点名称后显示不更新
### 现象
编辑节点主标题，按下回车或失焦保存后，节点显示的名称仍然是修改前的旧值，没有更新为新输入的内容。
### 根因分析
**解构赋值默认值逻辑错误**：SystemNode组件中标题字段的解构写法存在根本性逻辑错误：
```tsx
// 错误写法
const { title = data.label || 'Unknown Asset' } = data || {};
```
解构赋值的默认值仅在左侧字段（title）为`undefined`时才会生效。而UE扫描生成的节点数据中本身就存在`title`字段（存储原始蓝图名称），因此无论`data.label`怎么修改，`title`变量永远等于原始的`data.title`值，不会响应更新。
编辑保存逻辑中，我们调用`updateNodeMeta`更新的是`data.label`字段，而渲染时使用的是永远不会变化的`title`变量，导致修改后视图无响应。

### 关联验证
- 集群节点（ClusterGroupNode）不存在此问题，因为它直接渲染`data.label`字段，没有使用错误的解构默认值
- 打开React DevTools可以看到节点的data.label字段已经更新为新值，但视图显示仍然是旧的title值

---

## 解决方案参考（无需修改代码时存档）
### 问题1修复方案
1. 给所有编辑用的textarea添加`!text-white`（主标题）和`!text-gray-500`（头部标签）的!important优先级标记，覆盖CEF默认样式
2. 补充`appearance-none`重置系统默认表单样式
3. 可添加`caret-white`设置光标颜色为白色，提升编辑体验

### 问题2修复方案
修改SystemNode中的标题取值逻辑，优先使用用户编辑过的label字段，降级到原始title：
```tsx
// 正确写法：优先取用户自定义label，再取原始title
const displayTitle = data.label || data.title || 'Unknown Asset';
```
编辑保存逻辑无需修改，仅调整渲染时的取值顺序即可解决更新问题。
