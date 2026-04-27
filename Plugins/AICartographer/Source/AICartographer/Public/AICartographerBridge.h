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

    // ---- Vault FS bridge (used when frontend runs inside CEF without a Python backend) ----
    // List markdown files under {ProjectRoot}/.aicartographer-vault. Returns JSON envelope:
    //   {"ok": true, "project_root": "...", "exists": true, "files": [{relative_path,title,subdir,size}], "manifest": {...}}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Vault")
    FString ListVaultFiles(const FString& ProjectRoot);

    // Read a vault file. Returns JSON envelope: {"ok": true, "relative_path": "...", "content": "..."}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Vault")
    FString ReadVaultFile(const FString& ProjectRoot, const FString& RelativePath);

    // Replace the `## [ NOTES ]` section of a vault file with the supplied content.
    // Returns JSON envelope: {"ok": true} or {"ok": false, "error": "..."}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Vault")
    FString WriteVaultNotes(const FString& ProjectRoot, const FString& RelativePath, const FString& Content);

    // Generic vault file write — used by MOC generator (creates / overwrites
    // a full markdown file under the vault tree). Path traversal guarded.
    // Returns JSON envelope: {"ok": true} or {"ok": false, "error": "..."}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Vault")
    FString WriteVaultFile(const FString& ProjectRoot, const FString& RelativePath, const FString& Content);

    // Synchronously read a single function's graph from a Blueprint asset and
    // return its node/edge structure as JSON. Used by Lv3 function-flow view.
    // Returns:
    //   {"ok": true, "function": "<name>", "nodes": [...], "edges": [...]}
    // Each node: {id, label, kind, x, y, target?, pins:[{pinId,pinName,direction,type}]}
    // Each edge: {id, source, sourceHandle, target, targetHandle, isExec}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|DeepScan")
    FString ReadBlueprintFunctionFlow(const FString& AssetPath, const FString& FunctionName);

    // 2. Expose the Delegate instance
    FOnDeepScanResult OnDeepScanResult;

private:
    // 节点净化为AST JSON格式
    TSharedPtr<class FJsonObject> PurifyNodeToAST(class UEdGraphNode* Node);
};