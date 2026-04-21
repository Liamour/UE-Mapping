# RPC Bridge 下线问题 Bug 报告

## 问题概述
RPC Bridge在运行过程中会随机下线，表现为`window.ue.aicartographerbridge`对象虽然存在，但是调用方法无响应或者直接报错，导致C++和前端之前的通信中断。

## 问题分析

### 1. 绑定时机问题 (核心原因)
**代码位置**: `AICartographer.cpp` 第61-69行
```cpp
.OnLoadCompleted(FSimpleDelegate::CreateLambda([this]() 
{
    if (this->WebBrowserWidget.IsValid() && RPCBridge.IsValid()) 
    {
        this->WebBrowserWidget->BindUObject(TEXT("aicartographerbridge"), RPCBridge.Get(), true);
        UE_LOG(LogTemp, Warning, TEXT("[AICARTOGRAPHER_ARCHITECT] RPC Bridge Bound to CEF Context Successfully."));
    }
}));
```
**问题分析**:
- 绑定操作仅在WebView第一次加载完成时触发一次
- 当WebView页面刷新、重新加载、或者V8上下文重建时，之前的绑定会完全失效
- 没有任何重新绑定的逻辑，导致桥接对象虽然在JS上下文中存在，但是已经没有对应的C++后端绑定

### 2. WebView生命周期管理问题
**代码位置**: `AICartographer.cpp` 第36-91行 `OnSpawnPluginTab`函数
**问题分析**:
- WebBrowserWidget是标签页的局部变量，当标签页关闭再重新打开时会创建新的WebView实例
- 虽然RPCBridge是模块级的持久对象，但是每次创建新的WebView时都会重新绑定
- 但是如果是页面内部刷新（比如前端热重载、或者页面主动reload），标签页不会重建，不会重新执行OnSpawnPluginTab函数，也不会触发重新绑定
- 这时候`window.ue`对象可能还残留，但是已经无法和C++通信，表现为"桥接下线"

### 3. 函数调用返回值问题
**代码位置**: `AICartographerBridge.cpp` 第147行 `RequestGraphData`函数返回值
**问题分析**:
- `RequestGraphData`函数返回的是FString类型，在JS调用时会同步返回结果
- 但是当绑定失效时，调用会静默失败，返回`undefined`，前端无法区分是调用失败还是返回空结果
- UE的BindUObject对于有返回值的函数绑定，在上下文失效时没有明确的错误抛出，只会返回默认值

### 4. 缺失绑定状态校验
**问题分析**:
- 前端调用桥接方法时，没有校验方法是否真实存在且可调用
- 只检查了`window.ue && window.ue.aicartographerbridge`对象是否存在，但对象存在不代表绑定有效
- 很多情况下对象残留存在，但是函数指针已经失效，调用无响应

## 重现步骤
1. 打开AICartographer插件窗口，确认桥接正常工作
2. 在DevTools控制台执行`location.reload()`刷新页面
3. 再次尝试调用`window.ue.aicartographerbridge.requestgraphdata()`
4. 调用无响应，UE日志没有任何输出，表现为桥接下线

## 影响范围
- 全局资产扫描功能失效
- 深度扫描功能失效
- 所有C++和前端的双向通信中断
- 前端会静默失败，没有明确错误提示

## 临时规避方案
1. 不要刷新WebView页面
2. 如果桥接失效，关闭插件标签页重新打开即可恢复
3. 前端调用方法前可以增加额外校验，比如调用`sendlogtoue`测试连通性

## 根本解决方案建议
1. 增加WebView内容加载完成事件的持续监听，每次页面加载完成都重新绑定桥接对象
2. 在UE侧增加绑定状态的监控，定期校验绑定是否有效
3. 前端调用方法时增加超时和错误处理逻辑
4. 对于有返回值的调用，增加响应校验，失败时自动重试或者提示用户重新打开标签页
