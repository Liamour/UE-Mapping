#include "AICartographerBridge.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Class.h"
#include "Engine/Blueprint.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"
#include "Misc/PackageName.h"
#include "AssetRegistry/AssetIdentifier.h"
#include "EdGraph/EdGraphNode.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_DynamicCast.h"
#include "K2Node_SpawnActorFromClass.h"
#include "K2Node_BaseMCDelegate.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/Crc.h"
#include "GenericPlatform/GenericPlatformFile.h"
#include "Editor.h"
#include "Subsystems/AssetEditorSubsystem.h"

// File-scope JSON helpers — shared by every UFUNCTION body and helper namespace
// in this translation unit.  Hoisted out so the deep-scan code (defined before
// the vault-FS namespace) and the vault code can call the same primitives.
static FString SerializeJson(const TSharedRef<FJsonObject>& Obj)
{
    FString Out;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(Obj, Writer);
    return Out;
}

static FString MakeErrorJson(const FString& Error)
{
    TSharedRef<FJsonObject> Obj = MakeShareable(new FJsonObject());
    Obj->SetBoolField(TEXT("ok"), false);
    Obj->SetStringField(TEXT("error"), Error);
    return SerializeJson(Obj);
}

void UAICartographerBridge::SendLogToUE(const FString& Message)
{
    UE_LOG(LogTemp, Warning, TEXT("[RPC_BRIDGE_JS->UE] %s"), *Message);
}

FString UAICartographerBridge::RequestGraphData()
{
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] Global Scan Triggered from Frontend."));
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] Commencing Deep Asset Scan..."));

    // 1. 获取资产注册表
    FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    TArray<FAssetData> AssetDataList;

    // 2. 建立过滤器：只抓取位于 Game 目录下，且类型为 Blueprint 的资产
    FARFilter Filter;
    Filter.PackagePaths.Add(FName("/Game")); // 扫描整个 Content 目录
    Filter.bRecursivePaths = true;
    // Modern UE5 class path declaration
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
    // STRICT REQUIREMENT 2: Exclude virtual/directory ghost assets 
    Filter.bIncludeOnlyOnDiskAssets = true;
    AssetRegistryModule.Get().GetAssets(Filter, AssetDataList);
    
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] Asset Registry Found %d assets."), AssetDataList.Num());
    if (AssetDataList.Num() == 0) { 
        UE_LOG(LogTemp, Error, TEXT("[ARCHITECT_PROBE] FATAL: Asset Registry found 0 assets. Check your filter paths (e.g., /Game/) or ensure AssetRegistry is loaded.")); 
    }

    // 3. 构建 JSON 树 (适配前端 React Flow 格式)
    TSharedPtr<FJsonObject> RootObject = MakeShareable(new FJsonObject());
    TArray<TSharedPtr<FJsonValue>> NodesArray;

    int32 XOffset = 0;
    int32 YOffset = 0;

    // Assuming you already called AssetRegistryModule.Get().GetAssets(Filter, AssetList); 
    for (const FAssetData& Asset : AssetDataList) 
    { 
        // 1. Valid Metadata Check (No synchronous loading!) 
        if (!Asset.IsValid()) continue; 

        // 2. Strict Class Filtering via Metadata (UE5.1+ standard) 
        // This rejects folders, redirectors, and non-blueprint garbage. 
        if (Asset.AssetClassPath.GetAssetName() != TEXT("Blueprint")) continue; 

        // 3. CRITICAL: Extract the True Object Path 
        // DO NOT use PackagePath. We need the fully qualified path (e.g., /Game/UI/BP_Item.BP_Item) 
        // so LoadObject knows exactly what to target. 
        FString TrueAssetPath = Asset.GetObjectPathString(); 

        // 4. (Optional Safety) If the path somehow still ends with a slash or lacks a dot, skip it 
        if (TrueAssetPath.EndsWith(TEXT("/")) || !TrueAssetPath.Contains(TEXT("."))) continue; 
        
        // 组装单个 Node
        TSharedPtr<FJsonObject> NodeObj = MakeShareable(new FJsonObject());
        NodeObj->SetStringField(TEXT("id"), Asset.PackageName.ToString());
        NodeObj->SetStringField(TEXT("type"), TEXT("system")); // 对应前端 System Node

        // 坐标排版 (极简网格布局)
        TSharedPtr<FJsonObject> PosObj = MakeShareable(new FJsonObject());
        PosObj->SetNumberField(TEXT("x"), XOffset);
        PosObj->SetNumberField(TEXT("y"), YOffset);
        NodeObj->SetObjectField(TEXT("position"), PosObj);

        // 数据 Payload - 严格对齐前端 System Node 契约
        TSharedPtr<FJsonObject> DataObj = MakeShareable(new FJsonObject());
        
        // title: 资产名称
        DataObj->SetStringField(TEXT("title"), Asset.AssetName.ToString());
        
        // type: 统一标记为 Blueprint，以匹配前端样式
        DataObj->SetStringField(TEXT("type"), TEXT("Blueprint"));
        
        // description: 注入完整对象路径，保证可加载
        DataObj->SetStringField(TEXT("description"), TrueAssetPath);
        
        // methods: 预留空数组，防止前端 map 报错
        TArray<TSharedPtr<FJsonValue>> EmptyMethodsArray;
        DataObj->SetArrayField(TEXT("methods"), EmptyMethodsArray);

        NodeObj->SetObjectField(TEXT("data"), DataObj);

        NodesArray.Add(MakeShareable(new FJsonValueObject(NodeObj)));

        // 简单的自动换行排版
        XOffset += 300;
        if (XOffset > 1500) { XOffset = 0; YOffset += 150; }
    }

    RootObject->SetArrayField(TEXT("nodes"), NodesArray);

    // 建立合法节点白名单 
    TSet<FName> ValidPackageNames; 
    for (int32 i = 0; i < AssetDataList.Num(); ++i) 
    { 
        // 防御 1：跳过无效的资产数据 
        if (!AssetDataList[i].IsValid()) continue; 
        ValidPackageNames.Add(AssetDataList[i].PackageName); 
    }

    // 遍历依赖构建 Edges 数组
    TArray<TSharedPtr<FJsonValue>> EdgesArray;
    int32 EdgeIdCounter = 0;

    for (int32 i = 0; i < AssetDataList.Num(); ++i)
    {
        if (!AssetDataList[i].IsValid()) continue;
        
        FName SourceNodeId = AssetDataList[i].PackageName;
        TArray<FAssetIdentifier> DependencyIdentifiers;
        
        AssetRegistryModule.Get().GetDependencies(
            FAssetIdentifier(SourceNodeId),
            DependencyIdentifiers,
            UE::AssetRegistry::EDependencyCategory::All
        );

        for (const FAssetIdentifier& TargetIdentifier : DependencyIdentifiers)
        {
            // ==========================================
            // 绝密防御装甲：拦截所有可能导致 0xC0000005 的垃圾内存
            // 1. IsValid(): 必须是一个有效的标识符
            // 2. !IsValue(): 不能是一个 Value (比如具体属性)，必须是 Package 或 Object
            // 3. PackageName.IsValid() & !PackageName.IsNone(): 包名指针必须有意义
            // ==========================================
            if (!TargetIdentifier.IsValid() || 
                TargetIdentifier.IsValue() || 
                !TargetIdentifier.PackageName.IsValid() || 
                TargetIdentifier.PackageName.IsNone()) 
            { 
                continue; // 发现引擎垃圾引用，直接丢弃 
            }

            FName TargetPackage = TargetIdentifier.PackageName;
            
            // 剔除自身依赖，且确保目标节点在我们的白名单内
            if (TargetPackage != SourceNodeId && ValidPackageNames.Contains(TargetPackage))
            {
                TSharedPtr<FJsonObject> EdgeObj = MakeShareable(new FJsonObject());
                EdgeObj->SetStringField(TEXT("id"), FString::Printf(TEXT("e_%d"), EdgeIdCounter++));
                EdgeObj->SetStringField(TEXT("source"), SourceNodeId.ToString());
                EdgeObj->SetStringField(TEXT("target"), TargetPackage.ToString());
                EdgeObj->SetBoolField(TEXT("animated"), true);

                EdgesArray.Add(MakeShareable(new FJsonValueObject(EdgeObj)));
            }
        }
    }
    RootObject->SetArrayField(TEXT("edges"), EdgesArray);

    // 4. 序列化为 JSON 字符串
    FString OutputString;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&OutputString);
    FJsonSerializer::Serialize(RootObject.ToSharedRef(), Writer);

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] Scan Complete. Generated %d nodes."), AssetDataList.Num());
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] Dispatching JSON payload to Frontend. Length: %d characters."), OutputString.Len());
    return OutputString;
}

// ---------------------------------------------------------------------------
// Deep-scan + asset enumeration helpers used by the ScanOrchestrator UI.
// ---------------------------------------------------------------------------

namespace
{
    // /Game/Path/BP.BP   →   /Game/Path/BP.BP   (idempotent, plus trailing-space scrub)
    // /full/disk/.../Game/Path/BP.BP  →  /Game/Path/BP.BP
    // Returns empty string if /Game/ marker is missing.
    static FString PurifyGamePath(const FString& Raw)
    {
        FString Clean = Raw;
        int32 GameIndex = Clean.Find(TEXT("/Game/"));
        if (GameIndex == INDEX_NONE) return FString();
        Clean = Clean.Mid(GameIndex);
        FString Left, Right;
        if (Clean.Split(TEXT(" "), &Left, &Right)) Clean = Left;
        return Clean;
    }

    // Build a structural fingerprint of the Blueprint by walking every graph and
    // recording each node's class + name and each pin's name + linked endpoints.
    // Position fields (NodePosX/Y) are deliberately excluded so cosmetic moves
    // don't invalidate the hash.
    static FString ComputeBlueprintAstHash(UBlueprint* BP)
    {
        if (!BP) return TEXT("");

        FString Buffer;
        Buffer.Reserve(8192);

        auto AppendGraph = [&Buffer](UEdGraph* Graph)
        {
            if (!Graph) return;
            Buffer += Graph->GetName();
            Buffer += TEXT("|");
            for (UEdGraphNode* Node : Graph->Nodes)
            {
                if (!Node) continue;
                Buffer += Node->GetClass()->GetName();
                Buffer += TEXT(":");
                Buffer += Node->GetName();
                Buffer += TEXT("[");
                for (UEdGraphPin* Pin : Node->Pins)
                {
                    if (!Pin) continue;
                    Buffer += Pin->PinName.ToString();
                    Buffer += TEXT(",");
                    for (UEdGraphPin* Linked : Pin->LinkedTo)
                    {
                        if (!Linked || !Linked->GetOwningNode()) continue;
                        Buffer += FString::Printf(TEXT("->%s.%s|"),
                            *Linked->GetOwningNode()->GetName(),
                            *Linked->PinName.ToString());
                    }
                    Buffer += TEXT(";");
                }
                Buffer += TEXT("]");
            }
            Buffer += TEXT("\n");
        };

        for (UEdGraph* G : BP->FunctionGraphs) AppendGraph(G);
        for (UEdGraph* G : BP->UbergraphPages) AppendGraph(G);
        for (UEdGraph* G : BP->MacroGraphs)    AppendGraph(G);
        for (UEdGraph* G : BP->DelegateSignatureGraphs) AppendGraph(G);

        const uint32 Crc = FCrc::StrCrc32<TCHAR>(*Buffer);
        return FString::Printf(TEXT("%08x"), Crc);
    }

    // Coarse classification matching the backend's ASTNodePayload.node_type enum.
    // Order matters: BlueprintType (Interface / FunctionLibrary / MacroLibrary)
    // wins over class-name; Widget/Anim are detected by class to avoid touching
    // BPTYPE_* enum values that may differ across UE versions.
    static FString ClassifyBlueprintNodeType(UBlueprint* BP)
    {
        if (!BP) return TEXT("Blueprint");
        if (BP->BlueprintType == BPTYPE_Interface) return TEXT("Interface");
        if (BP->BlueprintType == BPTYPE_FunctionLibrary) return TEXT("FunctionLibrary");
        if (BP->BlueprintType == BPTYPE_MacroLibrary) return TEXT("MacroLibrary");

        // Widget / Anim BPs are real UBlueprint subclasses (UWidgetBlueprint /
        // UAnimBlueprint).  Compare by class name so we don't pull in UMG /
        // AnimGraph headers just for an isa check.
        if (UClass* Cls = BP->GetClass())
        {
            const FString ClsName = Cls->GetName();
            if (ClsName == TEXT("WidgetBlueprint")) return TEXT("WidgetBlueprint");
            if (ClsName == TEXT("AnimBlueprint")) return TEXT("AnimBlueprint");
        }

        UClass* Parent = BP->ParentClass;
        if (Parent)
        {
            // Walk the parent chain so derived component blueprints still classify.
            for (UClass* Cur = Parent; Cur; Cur = Cur->GetSuperClass())
            {
                if (Cur->GetName() == TEXT("ActorComponent")) return TEXT("Component");
            }
        }
        return TEXT("Blueprint");
    }

    // Resolve a UClass back to the on-disk Blueprint asset path that generated
    // it.  Returns empty string for native engine classes (which have no BP).
    // Used by the framework-scan edge extractor to ignore engine-only references.
    static FString BlueprintAssetPathFromClass(UClass* Cls)
    {
        if (!Cls) return FString();
        UObject* GeneratedBy = Cls->ClassGeneratedBy;
        if (!GeneratedBy) return FString();
        UBlueprint* BP = Cast<UBlueprint>(GeneratedBy);
        if (!BP) return FString();
        // GetPathName() returns "/Game/Path/BP_X.BP_X" — exactly the format the
        // frontend uses for asset_path everywhere else.
        return BP->GetPathName();
    }

    // Helper: name the graph that a node lives in. For functions this is the
    // function name; for ubergraph pages (event graph) we walk up to the page.
    static FString GraphLabel(UEdGraph* Graph)
    {
        if (!Graph) return TEXT("");
        return Graph->GetName();
    }

    // Append every user-visible function/event/custom-event entry into Out.
    // Skips compiler-generated graphs (UbergraphPages contain events but the
    // graph itself isn't a "function" — we surface its events instead).
    static void ExtractFunctions(UBlueprint* BP, TArray<TSharedPtr<FJsonValue>>& Out)
    {
        if (!BP) return;
        TSet<FString> Seen;
        auto AddEntry = [&Out, &Seen](const FString& Name, const FString& Kind)
        {
            const FString Key = Kind + TEXT(":") + Name;
            if (Name.IsEmpty() || Seen.Contains(Key)) return;
            Seen.Add(Key);
            TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
            Entry->SetStringField(TEXT("name"), Name);
            Entry->SetStringField(TEXT("kind"), Kind);
            Out.Add(MakeShareable(new FJsonValueObject(Entry)));
        };

        for (UEdGraph* G : BP->FunctionGraphs)
        {
            if (!G) continue;
            const FString GName = G->GetName();
            // UbergraphPages also surface here in some BP variants; skip the
            // implicit constructor.
            if (GName.Equals(TEXT("UserConstructionScript"), ESearchCase::IgnoreCase)) continue;
            AddEntry(GName, TEXT("function"));
        }
        for (UEdGraph* G : BP->UbergraphPages)
        {
            if (!G) continue;
            for (UEdGraphNode* N : G->Nodes)
            {
                if (!N) continue;
                if (UK2Node_CustomEvent* CE = Cast<UK2Node_CustomEvent>(N))
                {
                    AddEntry(CE->GetFunctionName().ToString(), TEXT("custom_event"));
                }
                else if (UK2Node_Event* Ev = Cast<UK2Node_Event>(N))
                {
                    AddEntry(Ev->GetFunctionName().ToString(), TEXT("event"));
                }
            }
        }
        for (UEdGraph* G : BP->DelegateSignatureGraphs)
        {
            if (!G) continue;
            AddEntry(G->GetName(), TEXT("dispatcher"));
        }
    }

    // Walk the SCS to surface BP-defined components.  Native components added
    // in C++ aren't included here — they show up via the parent class instead.
    // Parent lookup walks every SCS node's ChildNodes list rather than calling
    // FindParentNode so we don't depend on a specific UE-version API surface.
    static void ExtractComponents(UBlueprint* BP, TArray<TSharedPtr<FJsonValue>>& Out)
    {
        USimpleConstructionScript* SCS = BP ? BP->SimpleConstructionScript : nullptr;
        if (!SCS) return;
        const TArray<USCS_Node*>& Nodes = SCS->GetAllNodes();

        // Build child→parent index in O(N) instead of O(N^2) on FindParentNode.
        TMap<USCS_Node*, USCS_Node*> ChildToParent;
        for (USCS_Node* Parent : Nodes)
        {
            if (!Parent) continue;
            for (USCS_Node* Child : Parent->GetChildNodes())
            {
                if (Child) ChildToParent.Add(Child, Parent);
            }
        }

        for (USCS_Node* N : Nodes)
        {
            if (!N) continue;
            TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
            Entry->SetStringField(TEXT("name"), N->GetVariableName().ToString());
            Entry->SetStringField(TEXT("class"), N->ComponentClass ? N->ComponentClass->GetName() : TEXT("Unknown"));
            FString ParentName;
            if (USCS_Node** Parent = ChildToParent.Find(N))
            {
                if (*Parent) ParentName = (*Parent)->GetVariableName().ToString();
            }
            Entry->SetStringField(TEXT("parent"), ParentName);
            Out.Add(MakeShareable(new FJsonValueObject(Entry)));
        }
    }

    // Emit an outbound edge entry, deduped by (target, kind, from_function).
    static void EmitEdge(
        TArray<TSharedPtr<FJsonValue>>& Out,
        TSet<FString>& Seen,
        const FString& TargetAsset,
        const FString& TargetFunction,
        const FString& Kind,
        const FString& FromFunction)
    {
        if (TargetAsset.IsEmpty()) return;
        const FString Key = TargetAsset + TEXT("|") + TargetFunction + TEXT("|") + Kind + TEXT("|") + FromFunction;
        if (Seen.Contains(Key)) return;
        Seen.Add(Key);

        TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
        Entry->SetStringField(TEXT("target_asset"), TargetAsset);
        if (!TargetFunction.IsEmpty()) Entry->SetStringField(TEXT("target_function"), TargetFunction);
        Entry->SetStringField(TEXT("kind"), Kind);
        Entry->SetStringField(TEXT("from_function"), FromFunction);
        Out.Add(MakeShareable(new FJsonValueObject(Entry)));
    }

    // Walk every graph in the Blueprint and emit BP→BP edges for the edge
    // kinds the framework-scan UI cares about.  Engine-class targets are
    // discarded (they would explode the graph and aren't user authored).
    //
    // Also emits a single `inherits` edge for the parent class when the parent
    // resolves to a BP-generated class (so BPC_TownCenter → BP_BuildingBase
    // shows up as a typed edge rather than a frontmatter-only `parent_class`
    // scalar that the L1 force graph never reads).
    static void ExtractEdges(
        UBlueprint* BP,
        const FString& SelfAssetPath,
        TArray<TSharedPtr<FJsonValue>>& Out)
    {
        if (!BP) return;
        TSet<FString> Seen;

        // Inheritance edge — direct parent only.  Walking the full chain would
        // double-count (BP_Crop_Corn → BP_BaseCrop → BP_Interactable) since
        // each BP's own scan emits its parent edge separately.
        UClass* ParentCls = nullptr;
        if (UClass* GenClass = BP->GeneratedClass) ParentCls = GenClass->GetSuperClass();
        if (!ParentCls) ParentCls = BP->ParentClass;
        const FString ParentBP = BlueprintAssetPathFromClass(ParentCls);
        if (!ParentBP.IsEmpty() && ParentBP != SelfAssetPath)
        {
            EmitEdge(Out, Seen, ParentBP, FString(), TEXT("inherits"), TEXT(""));
        }

        auto WalkGraph = [&](UEdGraph* Graph, const FString& FromFunction)
        {
            if (!Graph) return;
            for (UEdGraphNode* Node : Graph->Nodes)
            {
                if (!Node) continue;

                if (UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
                {
                    UClass* Target = Call->FunctionReference.GetMemberParentClass();
                    const FString TargetBP = BlueprintAssetPathFromClass(Target);
                    if (!TargetBP.IsEmpty() && TargetBP != SelfAssetPath)
                    {
                        EmitEdge(Out, Seen, TargetBP, Call->GetFunctionName().ToString(),
                            TEXT("call"), FromFunction);
                    }
                }
                else if (UK2Node_DynamicCast* CastNode = Cast<UK2Node_DynamicCast>(Node))
                {
                    UClass* Target = CastNode->TargetType;
                    const FString TargetBP = BlueprintAssetPathFromClass(Target);
                    if (!TargetBP.IsEmpty() && TargetBP != SelfAssetPath)
                    {
                        EmitEdge(Out, Seen, TargetBP, FString(),
                            TEXT("cast"), FromFunction);
                    }
                }
                else if (UK2Node_SpawnActorFromClass* Spawn = Cast<UK2Node_SpawnActorFromClass>(Node))
                {
                    UClass* Target = Spawn->GetClassToSpawn();
                    const FString TargetBP = BlueprintAssetPathFromClass(Target);
                    if (!TargetBP.IsEmpty() && TargetBP != SelfAssetPath)
                    {
                        EmitEdge(Out, Seen, TargetBP, FString(),
                            TEXT("spawn"), FromFunction);
                    }
                }
                else if (UK2Node_BaseMCDelegate* Del = Cast<UK2Node_BaseMCDelegate>(Node))
                {
                    UClass* Target = Del->DelegateReference.GetMemberParentClass();
                    const FString TargetBP = BlueprintAssetPathFromClass(Target);
                    if (!TargetBP.IsEmpty() && TargetBP != SelfAssetPath)
                    {
                        EmitEdge(Out, Seen, TargetBP,
                            Del->DelegateReference.GetMemberName().ToString(),
                            TEXT("delegate"), FromFunction);
                    }
                }
            }
        };

        for (UEdGraph* G : BP->FunctionGraphs) WalkGraph(G, GraphLabel(G));
        // Ubergraph pages don't have a single "function" — use the page name as
        // a coarse anchor.  The frontend collapses by source BP anyway.
        for (UEdGraph* G : BP->UbergraphPages) WalkGraph(G, GraphLabel(G));
        for (UEdGraph* G : BP->MacroGraphs)    WalkGraph(G, GraphLabel(G));
    }
}

FString UAICartographerBridge::RequestDeepScan(const FString& AssetPath)
{
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] DeepScan request: %s"), *AssetPath);

    const FString CleanPath = PurifyGamePath(AssetPath);
    if (CleanPath.IsEmpty())
        return MakeErrorJson(FString::Printf(TEXT("invalid asset path (missing /Game/): %s"), *AssetPath));

    // Pre-flight: ensure the package exists and is actually a Blueprint before
    // calling LoadObject (which would otherwise log scary errors on miss).
    FString PackageName = CleanPath;
    int32 DotIndex;
    if (CleanPath.FindChar('.', DotIndex))
        PackageName = CleanPath.Left(DotIndex);

    FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    TArray<FAssetData> AssetDataList;
    AssetRegistryModule.Get().GetAssetsByPackageName(FName(*PackageName), AssetDataList);

    if (AssetDataList.Num() == 0)
        return MakeErrorJson(FString::Printf(TEXT("no asset at package path: %s"), *PackageName));

    // Accept every blueprint flavour the AssetRegistry filter in
    // ListBlueprintAssets pulls in.  Keep this set in sync with that filter.
    static const TSet<FName> kAcceptedBPClasses = {
        FName("Blueprint"),
        FName("WidgetBlueprint"),
        FName("EditorUtilityWidgetBlueprint"),
        FName("AnimBlueprint"),
        FName("BlueprintFunctionLibrary"),
        FName("BlueprintMacroLibrary"),
    };
    bool bIsBlueprint = false;
    for (const FAssetData& Asset : AssetDataList)
    {
        if (kAcceptedBPClasses.Contains(Asset.AssetClassPath.GetAssetName()))
        {
            bIsBlueprint = true;
            break;
        }
    }
    if (!bIsBlueprint)
        return MakeErrorJson(FString::Printf(TEXT("asset is not a Blueprint-like type: %s"), *PackageName));

    UBlueprint* LoadedBP = LoadObject<UBlueprint>(nullptr, *CleanPath);
    if (!LoadedBP)
        return MakeErrorJson(FString::Printf(TEXT("LoadObject failed: %s"), *CleanPath));

    const FString AstHash    = ComputeBlueprintAstHash(LoadedBP);
    const FString NodeType   = ClassifyBlueprintNodeType(LoadedBP);
    const FString Name       = LoadedBP->GetName();
    FString ParentClass;
    if (UClass* GenClass = LoadedBP->GeneratedClass)
    {
        if (UClass* Super = GenClass->GetSuperClass())
            ParentClass = Super->GetName();
    }
    if (ParentClass.IsEmpty() && LoadedBP->ParentClass)
        ParentClass = LoadedBP->ParentClass->GetName();

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    Root->SetStringField(TEXT("asset_path"), CleanPath);
    Root->SetStringField(TEXT("ast_hash"), AstHash);
    Root->SetStringField(TEXT("node_type"), NodeType);
    Root->SetStringField(TEXT("name"), Name);
    Root->SetStringField(TEXT("parent_class"), ParentClass);

    // Framework-scan extras: functions, components, edges. These let the
    // frontend draw the full L1/L2 force graph and write skeleton .md files
    // without going through the LLM.
    TArray<TSharedPtr<FJsonValue>> Functions;
    ExtractFunctions(LoadedBP, Functions);
    Root->SetArrayField(TEXT("functions"), Functions);

    TArray<TSharedPtr<FJsonValue>> Components;
    ExtractComponents(LoadedBP, Components);
    Root->SetArrayField(TEXT("components"), Components);

    TArray<TSharedPtr<FJsonValue>> Edges;
    ExtractEdges(LoadedBP, CleanPath, Edges);
    Root->SetArrayField(TEXT("edges"), Edges);

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] DeepScan: %s hash=%s type=%s parent=%s · %d func / %d comp / %d edge"),
        *Name, *AstHash, *NodeType, *ParentClass,
        Functions.Num(), Components.Num(), Edges.Num());
    return SerializeJson(Root);
}

FString UAICartographerBridge::ListBlueprintAssets(const FString& ProjectRoot)
{
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] ListBlueprintAssets called (project_root=%s)"), *ProjectRoot);

    FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    TArray<FAssetData> AssetDataList;

    FARFilter Filter;
    Filter.PackagePaths.Add(FName("/Game"));
    Filter.bRecursivePaths = true;
    // Pick up every Blueprint flavour the user might author.  Each BP variant
    // is its own UClass living in a different module — Blueprint in /Engine,
    // WidgetBlueprint in /UMG, AnimBlueprint in /Engine, etc.  Without these
    // entries the AssetRegistry filter silently drops them and the user's
    // UI / animation / library blueprints never make it into the scan pool.
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("Blueprint")));
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/UMG"), TEXT("WidgetBlueprint")));
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("AnimBlueprint")));
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("BlueprintFunctionLibrary")));
    Filter.ClassPaths.Add(FTopLevelAssetPath(TEXT("/Script/Engine"), TEXT("BlueprintMacroLibrary")));
    Filter.bIncludeOnlyOnDiskAssets = true;
    Filter.bRecursiveClasses = true; // Pick up subclasses (e.g. EditorUtilityWidgetBlueprint)
    AssetRegistryModule.Get().GetAssets(Filter, AssetDataList);

    // Class names accepted as "blueprint-like" — must mirror the ClassPaths
    // above (plus subclasses we explicitly want).  AssetClassPath holds the
    // actual stored class for each asset; recursive filter pulls in things
    // like EditorUtilityWidgetBlueprint which we still want listed.
    static const TSet<FName> kAcceptedClassNames = {
        FName("Blueprint"),
        FName("WidgetBlueprint"),
        FName("EditorUtilityWidgetBlueprint"),
        FName("AnimBlueprint"),
        FName("BlueprintFunctionLibrary"),
        FName("BlueprintMacroLibrary"),
    };

    TArray<TSharedPtr<FJsonValue>> Assets;
    Assets.Reserve(AssetDataList.Num());

    for (const FAssetData& Asset : AssetDataList)
    {
        if (!Asset.IsValid()) continue;
        if (!kAcceptedClassNames.Contains(Asset.AssetClassPath.GetAssetName())) continue;

        FString TrueAssetPath = Asset.GetObjectPathString();
        if (TrueAssetPath.EndsWith(TEXT("/")) || !TrueAssetPath.Contains(TEXT("."))) continue;

        // Try to surface the parent class from registry tags without loading.
        // UE stores it under "ParentClass" as e.g. "/Script/Engine.Actor".
        FString ParentClassRaw;
        Asset.GetTagValue(FName(TEXT("ParentClass")), ParentClassRaw);
        FString ParentClassName;
        if (!ParentClassRaw.IsEmpty())
        {
            int32 DotIdx;
            if (ParentClassRaw.FindLastChar('.', DotIdx))
                ParentClassName = ParentClassRaw.Mid(DotIdx + 1);
            else
                ParentClassName = ParentClassRaw;
            ParentClassName.RemoveFromEnd(TEXT("'"));
            ParentClassName.RemoveFromStart(TEXT("\""));
            ParentClassName.RemoveFromEnd(TEXT("\""));
        }

        TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
        Entry->SetStringField(TEXT("asset_path"), TrueAssetPath);
        Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
        Entry->SetStringField(TEXT("parent_class"), ParentClassName);
        Assets.Add(MakeShareable(new FJsonValueObject(Entry)));
    }

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    Root->SetArrayField(TEXT("assets"), Assets);

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] ListBlueprintAssets: %d Blueprint(s) found"), Assets.Num());
    return SerializeJson(Root);
}

FString UAICartographerBridge::PingBridge()
{
    return TEXT("ONLINE");
}

// Open the Blueprint editor for AssetPath, optionally focused on a function
// graph.  Path purification mirrors RequestDeepScan so the JS side can pass
// either /Game/X or /Game/X.X — both forms resolve to the same asset.
FString UAICartographerBridge::OpenInEditor(const FString& AssetPath, const FString& FunctionName)
{
    UE_LOG(LogTemp, Warning, TEXT("[BRIDGE] OpenInEditor: %s fn=%s"), *AssetPath, *FunctionName);

    if (!GEditor)
        return MakeErrorJson(TEXT("editor unavailable (running headless?)"));

    // Reuse the same /Game/ path-purification logic as RequestDeepScan
    auto PurifyGamePath = [](const FString& InAssetPath) -> FString
    {
        FString Clean = InAssetPath;
        const int32 GameIdx = Clean.Find(TEXT("/Game/"));
        if (GameIdx == INDEX_NONE) return FString();
        Clean = Clean.RightChop(GameIdx);
        // Ensure ObjectName format: /Game/Path/X.X
        if (!Clean.Contains(TEXT(".")))
        {
            int32 SlashIdx;
            if (Clean.FindLastChar('/', SlashIdx))
            {
                Clean = Clean + TEXT(".") + Clean.RightChop(SlashIdx + 1);
            }
        }
        return Clean;
    };

    const FString CleanPath = PurifyGamePath(AssetPath);
    if (CleanPath.IsEmpty())
        return MakeErrorJson(FString::Printf(TEXT("invalid asset path (missing /Game/): %s"), *AssetPath));

    UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *CleanPath);
    if (!BP)
        return MakeErrorJson(FString::Printf(TEXT("LoadObject failed: %s"), *CleanPath));

    UAssetEditorSubsystem* Subsys = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    if (!Subsys)
        return MakeErrorJson(TEXT("AssetEditorSubsystem unavailable"));

    // Open the BP editor.  bFocusIfOpen=true brings an existing tab forward
    // instead of opening a duplicate.
    Subsys->OpenEditorForAsset(BP);

    // If the caller asked for a specific function graph, look it up and open
    // the graph asset directly — this triggers the BP editor's "open this
    // graph in a tab" path without us needing to talk to FBlueprintEditor.
    bool bFocusedFunction = false;
    if (!FunctionName.IsEmpty())
    {
        UEdGraph* TargetGraph = nullptr;
        for (UEdGraph* G : BP->FunctionGraphs)
        {
            if (G && G->GetName() == FunctionName) { TargetGraph = G; break; }
        }
        if (!TargetGraph)
        {
            for (UEdGraph* G : BP->UbergraphPages)
            {
                if (G && G->GetName() == FunctionName) { TargetGraph = G; break; }
            }
        }
        if (!TargetGraph)
        {
            for (UEdGraph* G : BP->MacroGraphs)
            {
                if (G && G->GetName() == FunctionName) { TargetGraph = G; break; }
            }
        }
        if (TargetGraph)
        {
            Subsys->OpenEditorForAsset(TargetGraph);
            bFocusedFunction = true;
        }
    }

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    Root->SetStringField(TEXT("asset_path"), CleanPath);
    if (!FunctionName.IsEmpty())
    {
        Root->SetStringField(TEXT("function"), FunctionName);
        Root->SetBoolField(TEXT("focused_function"), bFocusedFunction);
    }
    return SerializeJson(Root);
}

// ---------------------------------------------------------------------------
// Vault FS bridge — file I/O for the .aicartographer/vault tree
// ---------------------------------------------------------------------------

namespace
{
    static FString JoinVaultPath(const FString& ProjectRoot)
    {
        // Convention mirrors the Python backend: vault lives at
        // {ProjectRoot}/.aicartographer/vault
        return FPaths::Combine(ProjectRoot, TEXT(".aicartographer"), TEXT("vault"));
    }

    static FString ToForwardSlashes(const FString& In)
    {
        return In.Replace(TEXT("\\"), TEXT("/"));
    }

    // Visitor that collects every `*.md` under VaultRoot and produces
    // {relative_path, title, subdir, size} entries.
    class FVaultFileVisitor : public IPlatformFile::FDirectoryVisitor
    {
    public:
        TArray<TSharedPtr<FJsonValue>>& Files;
        FString VaultRootAbs;
        explicit FVaultFileVisitor(TArray<TSharedPtr<FJsonValue>>& InFiles, const FString& InVaultRootAbs)
            : Files(InFiles), VaultRootAbs(InVaultRootAbs) {}

        virtual bool Visit(const TCHAR* FilenameOrDirectory, bool bIsDirectory) override
        {
            if (bIsDirectory) return true;
            FString FullPath = ToForwardSlashes(FilenameOrDirectory);
            if (!FullPath.EndsWith(TEXT(".md"), ESearchCase::IgnoreCase)) return true;

            // Compute relative path against vault root
            FString RelPath = FullPath;
            if (RelPath.StartsWith(VaultRootAbs))
            {
                RelPath = RelPath.RightChop(VaultRootAbs.Len());
                if (RelPath.StartsWith(TEXT("/"))) RelPath = RelPath.RightChop(1);
            }

            // Subdir = first path segment, "" if file lives at vault root
            FString Subdir;
            int32 SlashIdx;
            if (RelPath.FindChar('/', SlashIdx)) Subdir = RelPath.Left(SlashIdx);

            // Title = filename stem
            FString FileName = FPaths::GetCleanFilename(RelPath);
            FString Title = FPaths::GetBaseFilename(FileName);

            int64 FileSize = IFileManager::Get().FileSize(FilenameOrDirectory);

            TSharedPtr<FJsonObject> Entry = MakeShareable(new FJsonObject());
            Entry->SetStringField(TEXT("relative_path"), RelPath);
            Entry->SetStringField(TEXT("title"), Title);
            Entry->SetStringField(TEXT("subdir"), Subdir);
            Entry->SetNumberField(TEXT("size"), static_cast<double>(FileSize));
            Files.Add(MakeShareable(new FJsonValueObject(Entry)));
            return true;
        }
    };

    // SerializeJson / MakeErrorJson have been hoisted to file scope (see top of file).

    // Replace the section starting at `## [ NOTES ]` heading (inclusive) with
    // a freshly rendered NOTES block carrying the user's content. If no heading
    // exists, append one. Backend keeps the divider comment so we preserve it.
    static FString RewriteNotesSection(const FString& Original, const FString& UserContent)
    {
        const FString DividerComment = TEXT("<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->");
        const FString Heading = TEXT("## [ NOTES ]");
        const FString NL = TEXT("\n");
        const FString Trimmed = UserContent.TrimStartAndEnd();

        FString NewBlock;
        NewBlock += Heading + NL;
        NewBlock += DividerComment + NL + NL;
        if (Trimmed.IsEmpty())
        {
            NewBlock += FString(TEXT("*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*")) + NL;
        }
        else
        {
            NewBlock += Trimmed + NL;
        }

        // Find existing heading anchored to start-of-line. The original file may
        // use either LF or CRLF endings, so try both.
        int32 Idx = Original.Find(TEXT("\n") + Heading);
        int32 SkipLen = 1;
        if (Idx == INDEX_NONE)
        {
            Idx = Original.Find(TEXT("\r\n") + Heading);
            SkipLen = 2;
        }
        if (Idx != INDEX_NONE)
        {
            return Original.Left(Idx + SkipLen) + NewBlock;
        }
        if (Original.StartsWith(Heading))
        {
            return NewBlock;
        }

        FString Out = Original;
        if (!Out.EndsWith(NL) && !Out.EndsWith(TEXT("\r\n"))) Out += NL;
        Out += NL + NewBlock;
        return Out;
    }
}

FString UAICartographerBridge::ListVaultFiles(const FString& ProjectRoot)
{
    FString VaultRoot = JoinVaultPath(ProjectRoot);
    FString VaultRootAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(VaultRoot));

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetStringField(TEXT("project_root"), ProjectRoot);

    IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
    if (!PlatformFile.DirectoryExists(*VaultRootAbs))
    {
        Root->SetBoolField(TEXT("ok"), true);
        Root->SetBoolField(TEXT("exists"), false);
        TArray<TSharedPtr<FJsonValue>> EmptyFiles;
        Root->SetArrayField(TEXT("files"), EmptyFiles);
        return SerializeJson(Root);
    }

    TArray<TSharedPtr<FJsonValue>> Files;
    FVaultFileVisitor Visitor(Files, VaultRootAbs);
    PlatformFile.IterateDirectoryRecursively(*VaultRootAbs, Visitor);

    Root->SetBoolField(TEXT("ok"), true);
    Root->SetBoolField(TEXT("exists"), true);
    Root->SetArrayField(TEXT("files"), Files);

    // Try to load _meta/scan-manifest.json into manifest field for parity with HTTP API
    FString ManifestPath = FPaths::Combine(VaultRootAbs, TEXT("_meta"), TEXT("scan-manifest.json"));
    FString ManifestText;
    if (FFileHelper::LoadFileToString(ManifestText, *ManifestPath))
    {
        TSharedPtr<FJsonObject> Parsed;
        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ManifestText);
        if (FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid())
        {
            // Translate {asset_hashes: {...}, last_full_scan: ...} into
            // {entries: {nodeId: {ast_hash}}, updated_at}
            TSharedRef<FJsonObject> Manifest = MakeShareable(new FJsonObject());
            FString LastScan;
            if (Parsed->TryGetStringField(TEXT("last_full_scan"), LastScan))
                Manifest->SetStringField(TEXT("updated_at"), LastScan);

            const TSharedPtr<FJsonObject>* HashesObj = nullptr;
            if (Parsed->TryGetObjectField(TEXT("asset_hashes"), HashesObj) && HashesObj && HashesObj->IsValid())
            {
                TSharedRef<FJsonObject> Entries = MakeShareable(new FJsonObject());
                for (const auto& Pair : (*HashesObj)->Values)
                {
                    TSharedRef<FJsonObject> Entry = MakeShareable(new FJsonObject());
                    FString HashStr;
                    if (Pair.Value.IsValid() && Pair.Value->TryGetString(HashStr))
                        Entry->SetStringField(TEXT("ast_hash"), HashStr);
                    Entries->SetObjectField(Pair.Key, Entry);
                }
                Manifest->SetObjectField(TEXT("entries"), Entries);
            }
            Root->SetObjectField(TEXT("manifest"), Manifest);
        }
    }

    return SerializeJson(Root);
}

FString UAICartographerBridge::ReadVaultFile(const FString& ProjectRoot, const FString& RelativePath)
{
    FString VaultRoot = JoinVaultPath(ProjectRoot);
    FString FullPath = FPaths::Combine(VaultRoot, RelativePath);
    FString FullPathAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(FullPath));
    FString VaultRootAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(VaultRoot));

    // Path traversal guard: resolved path must stay within vault root
    if (!FullPathAbs.StartsWith(VaultRootAbs))
        return MakeErrorJson(TEXT("path escapes vault root"));

    FString Content;
    if (!FFileHelper::LoadFileToString(Content, *FullPathAbs))
        return MakeErrorJson(FString::Printf(TEXT("failed to read %s"), *RelativePath));

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    Root->SetStringField(TEXT("relative_path"), RelativePath);
    Root->SetStringField(TEXT("content"), Content);
    // Frontmatter is parsed client-side via the local YAML-subset parser.
    Root->SetObjectField(TEXT("frontmatter"), MakeShareable(new FJsonObject()));
    return SerializeJson(Root);
}

FString UAICartographerBridge::WriteVaultNotes(const FString& ProjectRoot, const FString& RelativePath, const FString& Content)
{
    FString VaultRoot = JoinVaultPath(ProjectRoot);
    FString FullPath = FPaths::Combine(VaultRoot, RelativePath);
    FString FullPathAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(FullPath));
    FString VaultRootAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(VaultRoot));

    if (!FullPathAbs.StartsWith(VaultRootAbs))
        return MakeErrorJson(TEXT("path escapes vault root"));

    FString Original;
    if (!FFileHelper::LoadFileToString(Original, *FullPathAbs))
        return MakeErrorJson(FString::Printf(TEXT("failed to read %s"), *RelativePath));

    FString Updated = RewriteNotesSection(Original, Content);
    if (!FFileHelper::SaveStringToFile(Updated, *FullPathAbs, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        return MakeErrorJson(FString::Printf(TEXT("failed to write %s"), *RelativePath));

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    return SerializeJson(Root);
}

FString UAICartographerBridge::WriteVaultFile(const FString& ProjectRoot, const FString& RelativePath, const FString& Content)
{
    FString VaultRoot = JoinVaultPath(ProjectRoot);
    FString FullPath = FPaths::Combine(VaultRoot, RelativePath);
    FString FullPathAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(FullPath));
    FString VaultRootAbs = ToForwardSlashes(FPaths::ConvertRelativePathToFull(VaultRoot));

    if (!FullPathAbs.StartsWith(VaultRootAbs))
        return MakeErrorJson(TEXT("path escapes vault root"));

    // Auto-create parent directory (e.g. _systems/) if missing
    FString ParentDir = FPaths::GetPath(FullPathAbs);
    IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
    if (!ParentDir.IsEmpty() && !PlatformFile.DirectoryExists(*ParentDir))
    {
        if (!PlatformFile.CreateDirectoryTree(*ParentDir))
            return MakeErrorJson(FString::Printf(TEXT("failed to create directory %s"), *ParentDir));
    }

    if (!FFileHelper::SaveStringToFile(Content, *FullPathAbs, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        return MakeErrorJson(FString::Printf(TEXT("failed to write %s"), *RelativePath));

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    return SerializeJson(Root);
}

// ---------------------------------------------------------------------------
// Function-flow extraction — used by Lv3 view. Loads the named function graph,
// classifies each node (event/call/branch/cast/macro/etc.), and serializes
// pin-level connectivity so the frontend can render an exec-flow diagram.
// ---------------------------------------------------------------------------

namespace
{
    static FString ClassifyNodeKind(UEdGraphNode* Node)
    {
        if (!Node) return TEXT("unknown");
        if (Cast<UK2Node_CallFunction>(Node)) return TEXT("function_call");
        if (Cast<UK2Node_CustomEvent>(Node)) return TEXT("custom_event");
        if (Cast<UK2Node_Event>(Node)) return TEXT("event");
        // Fall back to the node's class name (e.g. K2Node_IfThenElse) so the
        // frontend at least gets a stable kind tag for branches/casts/etc.
        return Node->GetClass()->GetName();
    }

    static FString PinDirection(UEdGraphPin* Pin)
    {
        return Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output");
    }

    static bool IsExecPin(UEdGraphPin* Pin)
    {
        // K2Schema exec pins use category "exec" — same convention used by all
        // K2 nodes. We compare by string to avoid pulling in the K2Schema header.
        return Pin && Pin->PinType.PinCategory == TEXT("exec");
    }
}

FString UAICartographerBridge::ReadBlueprintFunctionFlow(const FString& AssetPath, const FString& FunctionName)
{
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] Lv3 function flow request: %s :: %s"), *AssetPath, *FunctionName);

    // Reuse the same /Game/ path-purification logic as RequestDeepScan
    FString CleanPath = AssetPath;
    int32 GameIndex = CleanPath.Find(TEXT("/Game/"));
    if (GameIndex == INDEX_NONE)
        return MakeErrorJson(FString::Printf(TEXT("invalid asset path (missing /Game/): %s"), *AssetPath));
    CleanPath = CleanPath.Mid(GameIndex);

    UBlueprint* LoadedBP = LoadObject<UBlueprint>(nullptr, *CleanPath);
    if (!LoadedBP)
        return MakeErrorJson(FString::Printf(TEXT("LoadObject failed: %s"), *CleanPath));

    // Locate the function graph by name. UE stores user-defined functions in
    // FunctionGraphs; the event graph (UbergraphPages) holds events that can
    // also be referenced by "function name" (e.g. BeginPlay). Search both.
    UEdGraph* TargetGraph = nullptr;
    for (UEdGraph* G : LoadedBP->FunctionGraphs)
    {
        if (G && G->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
        {
            TargetGraph = G;
            break;
        }
    }
    if (!TargetGraph)
    {
        // Event-graph fallback: look for an Event node matching FunctionName
        for (UEdGraph* G : LoadedBP->UbergraphPages)
        {
            if (!G) continue;
            for (UEdGraphNode* N : G->Nodes)
            {
                if (UK2Node_Event* Ev = Cast<UK2Node_Event>(N))
                {
                    if (Ev->GetFunctionName().ToString().Equals(FunctionName, ESearchCase::IgnoreCase))
                    {
                        TargetGraph = G;
                        break;
                    }
                }
            }
            if (TargetGraph) break;
        }
    }
    if (!TargetGraph)
        return MakeErrorJson(FString::Printf(TEXT("function '%s' not found in %s"), *FunctionName, *CleanPath));

    TArray<TSharedPtr<FJsonValue>> JsonNodes;
    TArray<TSharedPtr<FJsonValue>> JsonEdges;

    for (UEdGraphNode* Node : TargetGraph->Nodes)
    {
        if (!Node) continue;

        FString GraphNodeId = FString::Printf(TEXT("n_%p"), Node);

        TSharedPtr<FJsonObject> NodeObj = MakeShareable(new FJsonObject());
        NodeObj->SetStringField(TEXT("id"), GraphNodeId);
        NodeObj->SetStringField(TEXT("label"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
        NodeObj->SetStringField(TEXT("kind"), ClassifyNodeKind(Node));
        NodeObj->SetNumberField(TEXT("x"), Node->NodePosX);
        NodeObj->SetNumberField(TEXT("y"), Node->NodePosY);

        // For call nodes, surface the target function name so the frontend can
        // show "Call: DoStuff" instead of just the generic node title.
        if (UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
            NodeObj->SetStringField(TEXT("target"), Call->GetFunctionName().ToString());
        else if (UK2Node_Event* Ev = Cast<UK2Node_Event>(Node))
            NodeObj->SetStringField(TEXT("target"), Ev->GetFunctionName().ToString());

        TArray<TSharedPtr<FJsonValue>> JsonPins;
        for (UEdGraphPin* Pin : Node->Pins)
        {
            if (!Pin) continue;
            FString PinId = FString::Printf(TEXT("p_%p"), Pin);

            TSharedPtr<FJsonObject> PinObj = MakeShareable(new FJsonObject());
            PinObj->SetStringField(TEXT("pinId"), PinId);
            PinObj->SetStringField(TEXT("pinName"), Pin->PinName.ToString());
            PinObj->SetStringField(TEXT("direction"), PinDirection(Pin));
            PinObj->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString());
            PinObj->SetBoolField(TEXT("isExec"), IsExecPin(Pin));
            JsonPins.Add(MakeShareable(new FJsonValueObject(PinObj)));

            // Emit edges from output pins only (each connection is bidirectional
            // in UE's graph but we want one edge entry, not two).
            if (Pin->Direction == EGPD_Output)
            {
                for (UEdGraphPin* LinkedPin : Pin->LinkedTo)
                {
                    if (!LinkedPin) continue;
                    UEdGraphNode* TargetNode = LinkedPin->GetOwningNode();
                    if (!TargetNode) continue;

                    TSharedPtr<FJsonObject> EdgeObj = MakeShareable(new FJsonObject());
                    EdgeObj->SetStringField(TEXT("id"), FString::Printf(TEXT("e_%p_%p"), Pin, LinkedPin));
                    EdgeObj->SetStringField(TEXT("source"), GraphNodeId);
                    EdgeObj->SetStringField(TEXT("sourceHandle"), PinId);
                    EdgeObj->SetStringField(TEXT("target"), FString::Printf(TEXT("n_%p"), TargetNode));
                    EdgeObj->SetStringField(TEXT("targetHandle"), FString::Printf(TEXT("p_%p"), LinkedPin));
                    EdgeObj->SetBoolField(TEXT("isExec"), IsExecPin(Pin) && IsExecPin(LinkedPin));
                    JsonEdges.Add(MakeShareable(new FJsonValueObject(EdgeObj)));
                }
            }
        }
        NodeObj->SetArrayField(TEXT("pins"), JsonPins);
        JsonNodes.Add(MakeShareable(new FJsonValueObject(NodeObj)));
    }

    TSharedRef<FJsonObject> Root = MakeShareable(new FJsonObject());
    Root->SetBoolField(TEXT("ok"), true);
    Root->SetStringField(TEXT("function"), FunctionName);
    Root->SetStringField(TEXT("graph_name"), TargetGraph->GetName());
    Root->SetArrayField(TEXT("nodes"), JsonNodes);
    Root->SetArrayField(TEXT("edges"), JsonEdges);

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] Lv3 function flow: %d nodes, %d edges"), JsonNodes.Num(), JsonEdges.Num());
    return SerializeJson(Root);
}

TSharedPtr<FJsonObject> UAICartographerBridge::PurifyNodeToAST(UEdGraphNode* Node)
{
    if (!Node) return nullptr;

    TSharedPtr<FJsonObject> JsonObj = MakeShareable(new FJsonObject());
    bool bIsHighValueNode = false;

    // Filter Logic: Only retain high-level business logic nodes
    if (UK2Node_CallFunction* CallFuncNode = Cast<UK2Node_CallFunction>(Node))
    {
        bIsHighValueNode = true;
        JsonObj->SetStringField(TEXT("Type"), TEXT("FunctionCall"));
        JsonObj->SetStringField(TEXT("Target"), CallFuncNode->GetFunctionName().ToString());
    }
    else if (UK2Node_Event* EventNode = Cast<UK2Node_Event>(Node))
    {
        bIsHighValueNode = true;
        JsonObj->SetStringField(TEXT("Type"), TEXT("Event"));
        JsonObj->SetStringField(TEXT("Target"), EventNode->GetFunctionName().ToString());
    }
    else if (Cast<UK2Node_CustomEvent>(Node))
    {
        bIsHighValueNode = true;
        JsonObj->SetStringField(TEXT("Type"), TEXT("CustomEvent"));
        JsonObj->SetStringField(TEXT("Target"), Node->GetName());
    }

    // Reject visual/utility nodes (math operations, getters, setters, etc.)
    if (!bIsHighValueNode) return nullptr;

    // Add core node metadata
    JsonObj->SetStringField(TEXT("NodeName"), Node->GetName());
    JsonObj->SetNumberField(TEXT("NodePosX"), Node->NodePosX);
    JsonObj->SetNumberField(TEXT("NodePosY"), Node->NodePosY);

    return JsonObj;
}


// ─── A1: AssetRegistry stale-asset listener (HANDOFF §19.3) ─────────────────
// Lazy-init pattern: register on first GetStaleEventsSince call.  Drop the
// pre-init events (~30s window after editor open) — Phase A1 MVP accepts this.
// AddUObject keeps a weak ref; UE auto-invalidates the binding when this
// UObject is destroyed, so no explicit BeginDestroy unregister is required.

void UAICartographerBridge::EnsureAssetRegistryListenersRegistered()
{
    if (bAssetRegistryListenersRegistered) return;

    FAssetRegistryModule& Module = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    IAssetRegistry& Registry = Module.Get();

    OnAssetRenamedHandle = Registry.OnAssetRenamed().AddUObject(this, &UAICartographerBridge::HandleAssetRenamed);
    OnAssetRemovedHandle = Registry.OnAssetRemoved().AddUObject(this, &UAICartographerBridge::HandleAssetRemoved);

    bAssetRegistryListenersRegistered = true;
    UE_LOG(LogTemp, Log, TEXT("[BRIDGE] AssetRegistry stale listeners registered (renamed + removed)"));
}

void UAICartographerBridge::HandleAssetRenamed(const FAssetData& AssetData, const FString& OldObjectPath)
{
    StaleEventCounter++;
    FStaleEvent Ev;
    Ev.Counter = StaleEventCounter;
    Ev.Type = TEXT("renamed");
    Ev.Path = AssetData.GetObjectPathString();
    Ev.OldPath = OldObjectPath;
    Ev.TimestampSec = FPlatformTime::Seconds();
    StaleEventBuffer.Add(Ev);
    if (StaleEventBuffer.Num() > 1024)
    {
        StaleEventBuffer.RemoveAt(0);
    }
}

void UAICartographerBridge::HandleAssetRemoved(const FAssetData& AssetData)
{
    StaleEventCounter++;
    FStaleEvent Ev;
    Ev.Counter = StaleEventCounter;
    Ev.Type = TEXT("removed");
    Ev.Path = AssetData.GetObjectPathString();
    Ev.TimestampSec = FPlatformTime::Seconds();
    StaleEventBuffer.Add(Ev);
    if (StaleEventBuffer.Num() > 1024)
    {
        StaleEventBuffer.RemoveAt(0);
    }
}

FString UAICartographerBridge::GetStaleEventsSince(int64 SinceCounter)
{
    EnsureAssetRegistryListenersRegistered();

    TSharedRef<FJsonObject> Obj = MakeShareable(new FJsonObject());
    Obj->SetBoolField(TEXT("ok"), true);
    Obj->SetNumberField(TEXT("latest_counter"), static_cast<double>(StaleEventCounter));

    TArray<TSharedPtr<FJsonValue>> Events;
    Events.Reserve(StaleEventBuffer.Num());
    for (const FStaleEvent& Ev : StaleEventBuffer)
    {
        if (Ev.Counter <= SinceCounter) continue;
        TSharedRef<FJsonObject> EvObj = MakeShareable(new FJsonObject());
        EvObj->SetNumberField(TEXT("counter"), static_cast<double>(Ev.Counter));
        EvObj->SetStringField(TEXT("type"), Ev.Type);
        EvObj->SetStringField(TEXT("path"), Ev.Path);
        if (!Ev.OldPath.IsEmpty())
        {
            EvObj->SetStringField(TEXT("old_path"), Ev.OldPath);
        }
        EvObj->SetNumberField(TEXT("timestamp_sec"), Ev.TimestampSec);
        Events.Add(MakeShareable(new FJsonValueObject(EvObj)));
    }
    Obj->SetArrayField(TEXT("events"), Events);
    return SerializeJson(Obj);
}


// ─── A2: Reflection-derived asset summary (HANDOFF §19.3) ───────────────────
// Returns a structurally-precise summary of a BP asset by walking UClass +
// AssetRegistry — no LLM, no fragility.  This is the "去 LLM 抽取" foundation
// from §19.2; the analyze_one_node 3-stage refactor (which calls this) lands
// in a follow-up PR coupled to the Phase B narrative-prompt rewrite.

namespace
{
    // Subset of EFunctionFlags relevant to the narrative prompt.  Frontend
    // treats flags[] as a set; order is informational.
    static TArray<FString> FunctionFlagsToTokens(EFunctionFlags Flags)
    {
        TArray<FString> Out;
        if (Flags & FUNC_BlueprintCallable)  Out.Add(TEXT("BlueprintCallable"));
        if (Flags & FUNC_BlueprintEvent)     Out.Add(TEXT("BlueprintEvent"));
        if (Flags & FUNC_BlueprintPure)      Out.Add(TEXT("BlueprintPure"));
        if (Flags & FUNC_Net)                Out.Add(TEXT("Net"));
        if (Flags & FUNC_NetMulticast)       Out.Add(TEXT("NetMulticast"));
        if (Flags & FUNC_NetServer)          Out.Add(TEXT("Server"));
        if (Flags & FUNC_NetClient)          Out.Add(TEXT("Client"));
        if (Flags & FUNC_NetReliable)        Out.Add(TEXT("Reliable"));
        if (Flags & FUNC_Static)             Out.Add(TEXT("Static"));
        if (Flags & FUNC_Exec)               Out.Add(TEXT("Exec"));
        return Out;
    }

    // Subset of CPF_ flags relevant to read/write surface + replication.
    // BlueprintReadWrite is synthesised: BlueprintVisible & !BlueprintReadOnly.
    static TArray<FString> PropertyFlagsToTokens(uint64 Flags)
    {
        TArray<FString> Out;
        if (Flags & CPF_Edit)                Out.Add(TEXT("EditAnywhere"));
        if (Flags & CPF_BlueprintVisible)    Out.Add(TEXT("BlueprintReadOnly"));
        if (Flags & CPF_BlueprintAssignable) Out.Add(TEXT("BlueprintAssignable"));
        if (Flags & CPF_BlueprintCallable)   Out.Add(TEXT("BlueprintCallable"));
        if ((Flags & CPF_BlueprintVisible) && !(Flags & CPF_BlueprintReadOnly))
                                             Out.Add(TEXT("BlueprintReadWrite"));
        if (Flags & CPF_Net)                 Out.Add(TEXT("Replicated"));
        if (Flags & CPF_Transient)           Out.Add(TEXT("Transient"));
        if (Flags & CPF_SaveGame)            Out.Add(TEXT("SaveGame"));
        return Out;
    }

    // Walk UClass::FuncMap (declared funcs only, no inherited) and emit
    // {name, flags:[...]} per function.  Param signatures (return + args) are
    // deferred to Phase B alongside the narrative-prompt rewrite.
    static void ExtractExportFunctions(UClass* Cls, TArray<TSharedPtr<FJsonValue>>& Out)
    {
        if (!Cls) return;
        for (TFieldIterator<UFunction> It(Cls, EFieldIteratorFlags::ExcludeSuper); It; ++It)
        {
            UFunction* Fn = *It;
            if (!Fn) continue;
            TSharedRef<FJsonObject> Entry = MakeShareable(new FJsonObject());
            Entry->SetStringField(TEXT("name"), Fn->GetName());
            const TArray<FString> FlagTokens = FunctionFlagsToTokens(Fn->FunctionFlags);
            TArray<TSharedPtr<FJsonValue>> Flags;
            Flags.Reserve(FlagTokens.Num());
            for (const FString& F : FlagTokens) Flags.Add(MakeShareable(new FJsonValueString(F)));
            Entry->SetArrayField(TEXT("flags"), Flags);
            Out.Add(MakeShareable(new FJsonValueObject(Entry)));
        }
    }

    // Walk declared FProperty fields (no inherited) and emit {name, type, flags:[...]}.
    static void ExtractDeclaredProperties(UClass* Cls, TArray<TSharedPtr<FJsonValue>>& Out)
    {
        if (!Cls) return;
        for (TFieldIterator<FProperty> It(Cls, EFieldIteratorFlags::ExcludeSuper); It; ++It)
        {
            FProperty* P = *It;
            if (!P) continue;
            TSharedRef<FJsonObject> Entry = MakeShareable(new FJsonObject());
            Entry->SetStringField(TEXT("name"), P->GetName());
            Entry->SetStringField(TEXT("type"), P->GetCPPType());
            const TArray<FString> FlagTokens = PropertyFlagsToTokens(P->PropertyFlags);
            TArray<TSharedPtr<FJsonValue>> Flags;
            Flags.Reserve(FlagTokens.Num());
            for (const FString& F : FlagTokens) Flags.Add(MakeShareable(new FJsonValueString(F)));
            Entry->SetArrayField(TEXT("flags"), Flags);
            Out.Add(MakeShareable(new FJsonValueObject(Entry)));
        }
    }
}

FString UAICartographerBridge::GetReflectionAssetSummary(const FString& AssetPath)
{
    UE_LOG(LogTemp, Log, TEXT("[BRIDGE] GetReflectionAssetSummary: %s"), *AssetPath);

    // Reuse the /Game path purification pattern from RequestDeepScan.
    FString Clean = AssetPath;
    {
        const int32 GameIdx = Clean.Find(TEXT("/Game/"));
        if (GameIdx == INDEX_NONE) return MakeErrorJson(TEXT("asset path missing /Game/"));
        Clean = Clean.Mid(GameIdx);
        FString Left, Right;
        if (Clean.Split(TEXT(" "), &Left, &Right)) Clean = Left;
        if (!Clean.Contains(TEXT("."))) return MakeErrorJson(TEXT("asset path missing object suffix (e.g. /Game/X/BP.BP)"));
    }

    UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *Clean);
    if (!BP) return MakeErrorJson(FString::Printf(TEXT("LoadObject failed: %s"), *Clean));
    UClass* Cls = BP->GeneratedClass;
    if (!Cls) return MakeErrorJson(TEXT("Blueprint has no GeneratedClass (not yet compiled?)"));

    TSharedRef<FJsonObject> Out = MakeShareable(new FJsonObject());
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("asset_path"), Clean);
    Out->SetStringField(TEXT("class_path"), Cls->GetPathName());
    Out->SetStringField(TEXT("parent_class"), BP->ParentClass ? BP->ParentClass->GetPathName() : FString());
    Out->SetStringField(TEXT("ast_hash"), ComputeBlueprintAstHash(BP));
    Out->SetStringField(TEXT("scanned_at"), FDateTime::UtcNow().ToIso8601());

    // exports — UClass FuncMap walk
    TArray<TSharedPtr<FJsonValue>> Exports;
    ExtractExportFunctions(Cls, Exports);
    Out->SetArrayField(TEXT("exports"), Exports);

    // properties — declared FProperty walk
    TArray<TSharedPtr<FJsonValue>> Props;
    ExtractDeclaredProperties(Cls, Props);
    Out->SetArrayField(TEXT("properties"), Props);

    // components — reuse SCS walker from the same translation unit
    TArray<TSharedPtr<FJsonValue>> Components;
    ExtractComponents(BP, Components);
    Out->SetArrayField(TEXT("components"), Components);

    // edges — AssetRegistry hard / soft refs, plus implemented interfaces
    FAssetRegistryModule& Module = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    IAssetRegistry& Registry = Module.Get();
    const FString PackagePath = FPackageName::ObjectPathToPackageName(Clean);
    const FName PackageName(*PackagePath);

    TArray<TSharedPtr<FJsonValue>> Hard, Soft;
    {
        TArray<FName> HardRefs, SoftRefs;
        Registry.GetDependencies(PackageName, HardRefs,
            UE::AssetRegistry::EDependencyCategory::Package,
            UE::AssetRegistry::FDependencyQuery(UE::AssetRegistry::EDependencyQuery::Hard));
        Registry.GetDependencies(PackageName, SoftRefs,
            UE::AssetRegistry::EDependencyCategory::Package,
            UE::AssetRegistry::FDependencyQuery(UE::AssetRegistry::EDependencyQuery::Soft));
        for (const FName& N : HardRefs)
        {
            const FString S = N.ToString();
            if (S.StartsWith(TEXT("/Game/"))) Hard.Add(MakeShareable(new FJsonValueString(S)));
        }
        for (const FName& N : SoftRefs)
        {
            const FString S = N.ToString();
            if (S.StartsWith(TEXT("/Game/"))) Soft.Add(MakeShareable(new FJsonValueString(S)));
        }
    }

    TArray<TSharedPtr<FJsonValue>> Interfaces;
    for (const FBPInterfaceDescription& I : BP->ImplementedInterfaces)
    {
        if (I.Interface) Interfaces.Add(MakeShareable(new FJsonValueString(I.Interface->GetPathName())));
    }

    TSharedRef<FJsonObject> Edges = MakeShareable(new FJsonObject());
    Edges->SetArrayField(TEXT("hard_refs"), Hard);
    Edges->SetArrayField(TEXT("soft_refs"), Soft);
    Edges->SetArrayField(TEXT("interfaces"), Interfaces);
    Out->SetField(TEXT("edges"), MakeShareable(new FJsonValueObject(Edges)));

    return SerializeJson(Out);
}