#include "AICartographerBridge.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Class.h"
#include "Engine/Blueprint.h"
#include "Misc/PackageName.h"
#include "AssetRegistry/AssetIdentifier.h"
#include "EdGraph/EdGraphNode.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_CustomEvent.h"

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

void UAICartographerBridge::RequestDeepScan(const FString& NodeId, const FString& AssetPath)
{
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] Received Deep Scan Request. Raw Path: %s"), *AssetPath); 

    // 1. C++ SUBSTRING PURIFIER 
    FString CleanPath = AssetPath; 
    int32 GameIndex = CleanPath.Find(TEXT("/Game/")); 
    
    if (GameIndex != INDEX_NONE) 
    { 
        // Keep everything from /Game/ onwards 
        CleanPath = CleanPath.Mid(GameIndex); 
        
        // Strip any trailing spaces or invalid characters if they exist 
        FString Left, Right; 
        if (CleanPath.Split(TEXT(" "), &Left, &Right)) { 
            CleanPath = Left; 
        } 
    } 
    else 
    { 
        UE_LOG(LogTemp, Error, TEXT("[SYS_ERR] Invalid Asset Path Structure. Missing '/Game/': %s"), *AssetPath); 
        return; 
    } 

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] Purified Path: %s"), *CleanPath); 

    // 1. EXTRACT PACKAGE NAME FOR PRE-FLIGHT 
    FString PackageName = CleanPath; 
    int32 DotIndex; 
    if (CleanPath.FindChar('.', DotIndex)) 
    { 
        // Extract everything to the left of the dot 
        PackageName = CleanPath.Left(DotIndex); 
    } 

    // 2. THE PRE-FLIGHT CHECK 
    FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry"); 
    TArray<FAssetData> AssetDataList; 

    // Use the stripped PackageName for the registry query 
    AssetRegistryModule.Get().GetAssetsByPackageName(FName(*PackageName), AssetDataList); 

    if (AssetDataList.Num() == 0) 
    { 
        UE_LOG(LogTemp, Error, TEXT("[SYS_ERR] Pre-flight aborted. No asset found at package path: %s"), *PackageName); 
        return; 
    } 

    bool bIsBlueprint = false; 
    for (const FAssetData& Asset : AssetDataList) 
    { 
        if (Asset.AssetClassPath.GetAssetName() == TEXT("Blueprint")) 
        { 
            bIsBlueprint = true; 
            break; 
        } 
    } 

    if (!bIsBlueprint) 
    { 
        UE_LOG(LogTemp, Error, TEXT("[SYS_ERR] Pre-flight aborted. Asset is NOT a Blueprint: %s"), *PackageName); 
        return; 
    } 

    // 3. SAFE TO LOAD 
    // CRITICAL: We use the original FULL CleanPath (with the dot) for LoadObject! 
    UBlueprint* LoadedBP = LoadObject<UBlueprint>(nullptr, *CleanPath); 
    if (!LoadedBP) 
    { 
        UE_LOG(LogTemp, Error, TEXT("[SYS_ERR] LoadObject failed despite pre-flight pass: %s"), *CleanPath); 
        return; 
    } 

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] Blueprint Loaded Successfully! Ready for AST Dissection."));

    // 1. Initialize JSON Arrays 
    TArray<TSharedPtr<FJsonValue>> JsonNodes; 
    TArray<TSharedPtr<FJsonValue>> JsonEdges; 

    // 2. Iterate through the main Event Graphs 
    for (UEdGraph* Graph : LoadedBP->UbergraphPages) 
    { 
        if (!Graph) continue; 

        for (UEdGraphNode* Node : Graph->Nodes) 
        { 
            if (!Node) continue; 

            // --- Serialize NODE --- 
            TSharedPtr<FJsonObject> NodeObj = MakeShareable(new FJsonObject()); 
            FString GraphNodeId = FString::Printf(TEXT("%p"), Node); // Use memory address as unique ID (avoid conflict with function parameter NodeId)
            
            NodeObj->SetStringField(TEXT("id"), GraphNodeId); 
            NodeObj->SetStringField(TEXT("label"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString()); 
            NodeObj->SetNumberField(TEXT("x"), Node->NodePosX); 
            NodeObj->SetNumberField(TEXT("y"), Node->NodePosY); 
            
            // --- Serialize PINS & EDGES --- 
            TArray<TSharedPtr<FJsonValue>> JsonPins; 
            for (UEdGraphPin* Pin : Node->Pins) 
            { 
                if (!Pin) continue; 

                FString PinId = FString::Printf(TEXT("%p"), Pin); 
                
                TSharedPtr<FJsonObject> PinObj = MakeShareable(new FJsonObject()); 
                PinObj->SetStringField(TEXT("pinId"), PinId); 
                PinObj->SetStringField(TEXT("pinName"), Pin->PinName.ToString()); 
                PinObj->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output")); 
                JsonPins.Add(MakeShareable(new FJsonValueObject(PinObj))); 

                // Extract Edges (Only process outputs to avoid duplicate edge creation) 
                if (Pin->Direction == EGPD_Output) 
                { 
                    for (UEdGraphPin* LinkedPin : Pin->LinkedTo) 
                    { 
                        if (!LinkedPin) continue; 
                        
                        UEdGraphNode* TargetNode = LinkedPin->GetOwningNode(); 
                        if (!TargetNode) continue; 

                        TSharedPtr<FJsonObject> EdgeObj = MakeShareable(new FJsonObject()); 
                        EdgeObj->SetStringField(TEXT("id"), FString::Printf(TEXT("edge_%p_%p"), Pin, LinkedPin)); 
                        EdgeObj->SetStringField(TEXT("source"), GraphNodeId); 
                        EdgeObj->SetStringField(TEXT("sourceHandle"), PinId); 
                        EdgeObj->SetStringField(TEXT("target"), FString::Printf(TEXT("%p"), TargetNode)); 
                        EdgeObj->SetStringField(TEXT("targetHandle"), FString::Printf(TEXT("%p"), LinkedPin)); 
                        
                        JsonEdges.Add(MakeShareable(new FJsonValueObject(EdgeObj))); 
                    } 
                } 
            } 
            NodeObj->SetArrayField(TEXT("pins"), JsonPins); 
            JsonNodes.Add(MakeShareable(new FJsonValueObject(NodeObj))); 
        } 
    } 

    // 3. Package and Dispatch 
    TSharedPtr<FJsonObject> RootObj = MakeShareable(new FJsonObject()); 
    RootObj->SetArrayField(TEXT("nodes"), JsonNodes); 
    RootObj->SetArrayField(TEXT("edges"), JsonEdges); 

    FString OutputJson; 
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&OutputJson); 
    FJsonSerializer::Serialize(RootObj.ToSharedRef(), Writer); 

    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT] AST Serialization Complete. Nodes: %d, Edges: %d"), JsonNodes.Num(), JsonEdges.Num()); 

    // 4. Broadcast via existing Delegate 
    if (OnDeepScanResult.IsBound())
    {
        OnDeepScanResult.Execute(NodeId, OutputJson);
    }
    else
    {
        UE_LOG(LogTemp, Error, TEXT("DeepScan Error: OnDeepScanResult delegate is not bound!"));
    }
}

FString UAICartographerBridge::PingBridge()
{
    return TEXT("ONLINE");
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