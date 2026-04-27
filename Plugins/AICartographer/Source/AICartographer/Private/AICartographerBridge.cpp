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
#include "HAL/PlatformFileManager.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "GenericPlatform/GenericPlatformFile.h"

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