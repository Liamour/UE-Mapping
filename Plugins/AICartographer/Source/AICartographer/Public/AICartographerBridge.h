#pragma once
#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "AICartographerBridge.generated.h"

// 1. Declare the Delegate (Parameters: NodeId, ASTJsonString)
DECLARE_DELEGATE_TwoParams(FOnDeepScanResult, const FString&, const FString&);

UCLASS()
class AICARTOGRAPHER_API UAICartographerBridge : public UObject
{
    GENERATED_BODY()

public:
    // JS 调用 UE: 测试日志
    UFUNCTION()
    void SendLogToUE(const FString& Message);

    // JS 调用 UE: 请求图谱数据 (当前返回 Mock JSON)
    UFUNCTION()
    FString RequestGraphData();

    // JS 调用 UE: 触发蓝图深度扫描
    UFUNCTION(BlueprintCallable, Category = "AICartographer|DeepScan")
    void RequestDeepScan(const FString& NodeId, const FString& AssetPath);

    // JS 调用 UE: 心跳检测桥接状态
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Bridge")
    FString PingBridge();

    // 2. Expose the Delegate instance
    FOnDeepScanResult OnDeepScanResult;

private:
    // 节点净化为AST JSON格式
    TSharedPtr<class FJsonObject> PurifyNodeToAST(class UEdGraphNode* Node);
};