#pragma once
#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "AICartographerBridge.generated.h"

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

    // Synchronously load a Blueprint and return its AST fingerprint plus
    // the metadata needed to assemble a ScanOrchestrator payload.
    // Returns JSON envelope:
    //   {
    //     "ok": true,
    //     "asset_path", "ast_hash", "node_type", "name", "parent_class",
    //     "functions": [{"name", "kind"}],          // user functions / events / custom events
    //     "components": [{"name", "class", "parent"}], // SCS hierarchy
    //     "edges": [
    //       {"target_asset", "target_function?", "kind", "from_function"}  // call|cast|spawn|delegate
    //     ]
    //   }
    // ast_hash is a CRC32 over the structural fingerprint of every graph (nodes,
    // pins, link topology) — stable across cosmetic/layout changes, sensitive to
    // any topology edit.  Used by the frontend to dedupe against scan-manifest.
    // The functions/components/edges fields drive the framework-scan force graph
    // and skeleton .md generation (no LLM required for those).
    UFUNCTION(BlueprintCallable, Category = "AICartographer|DeepScan")
    FString RequestDeepScan(const FString& AssetPath);

    // Enumerate every Blueprint asset under /Game/.  ProjectRoot is informational
    // only — the AssetRegistry already knows what's mounted in the loaded project.
    // Returns JSON envelope:
    //   {"ok": true, "assets": [{"asset_path", "name", "parent_class"}, ...]}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|DeepScan")
    FString ListBlueprintAssets(const FString& ProjectRoot);

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

    // Delete a single vault .md file.  Used by the TopBar stale-asset
    // dropdown when the user applies a `removed` event (asset gone in editor
    // → drop the matching note) and by the bridge-side rename path (write
    // new, then delete old).  Path traversal guarded.
    // Returns: {"ok": true, "deleted_relative_path": "..."} or {"ok": false, "error": "..."}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Vault")
    FString DeleteVaultFile(const FString& ProjectRoot, const FString& RelativePath);

    // Synchronously read a single function's graph from a Blueprint asset and
    // return its node/edge structure as JSON. Used by Lv3 function-flow view.
    // Returns:
    //   {"ok": true, "function": "<name>", "nodes": [...], "edges": [...]}
    // Each node: {id, label, kind, x, y, target?, pins:[{pinId,pinName,direction,type}]}
    // Each edge: {id, source, sourceHandle, target, targetHandle, isExec}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|DeepScan")
    FString ReadBlueprintFunctionFlow(const FString& AssetPath, const FString& FunctionName);

    // Open the Blueprint editor for AssetPath (and optionally focus a specific
    // function graph by name).  FunctionName="" opens the asset's default tab
    // (event graph for actor BPs, designer for widgets, etc).  The frontend
    // calls this from Lv2 / Lv3 "Jump to UE" buttons so users can flip from
    // analysis to authoring without alt-tabbing.
    // Returns: {"ok": true, "asset_path": "..."} or {"ok": false, "error": "..."}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Bridge")
    FString OpenInEditor(const FString& AssetPath, const FString& FunctionName);

    // ─── A1: AssetRegistry stale-asset listener (HANDOFF §19.3) ─────────────
    // Frontend polls every 30s passing the highest counter it has seen; we
    // return events with counter > since.  Buffer caps at 1024; if the
    // frontend falls behind, oldest events are silently dropped — frontend
    // detects the gap and treats it as 'rescan everything'.  MVP wires up
    // OnAssetRenamed + OnAssetRemoved only; Added / Updated follow up.
    // Returns: {"ok": true, "latest_counter": N, "events": [{counter, type, path, old_path?, timestamp_sec}]}
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Stale")
    FString GetStaleEventsSince(int64 SinceCounter);

    // ─── A2: Reflection-derived asset summary (HANDOFF §19.3) ──────────────
    // Loads a Blueprint asset and walks UClass via reflection to return
    // exports / properties / components / edges as one JSON envelope.
    // Replaces what the LLM used to fragilely extract from k2node dumps.
    // MVP: BP-only.  DataAsset / WBP / Niagara extensions follow in Phase B.
    // Function parameter signatures are flag-only in MVP; param-type detail
    // joins this endpoint in the same Phase B PR.
    // Returns: §19.3 AssetSummary JSON {asset_path, class_path, parent_class,
    // exports[], properties[], components[], edges{hard_refs,soft_refs,interfaces},
    // ast_hash, scanned_at}.
    UFUNCTION(BlueprintCallable, Category = "AICartographer|Reflection")
    FString GetReflectionAssetSummary(const FString& AssetPath);

private:
    // ── Stale-listener internal state (see GetStaleEventsSince above) ──
    struct FStaleEvent
    {
        int64   Counter = 0;
        FString Type;          // "renamed" | "removed" | (later) "added" | "updated"
        FString Path;
        FString OldPath;
        double  TimestampSec = 0;
    };
    bool bAssetRegistryListenersRegistered = false;
    int64 StaleEventCounter = 0;
    TArray<FStaleEvent> StaleEventBuffer;
    FDelegateHandle OnAssetRenamedHandle;
    FDelegateHandle OnAssetRemovedHandle;

    void EnsureAssetRegistryListenersRegistered();
    void HandleAssetRenamed(const struct FAssetData& AssetData, const FString& OldObjectPath);
    void HandleAssetRemoved(const struct FAssetData& AssetData);

    // 节点净化为AST JSON格式
    TSharedPtr<class FJsonObject> PurifyNodeToAST(class UEdGraphNode* Node);
};