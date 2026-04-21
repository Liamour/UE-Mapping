// 扩展 Window 对象，识别 UE 注入的桥接对象
export interface UECartographerBridge {
    SendLogToUE(Message: string): void;
    RequestGraphData(): Promise<string>; // UE C++ 返回字符串在 JS 中表现为 Promise
}

declare global {
    interface Window {
        // UE 5.4 及以前的旧路径
        ue?: {
            cartographerbridge?: UECartographerBridge;
        };
        // UE 5.7 的新扁平路径
        cartographerbridge?: UECartographerBridge;
    }
}