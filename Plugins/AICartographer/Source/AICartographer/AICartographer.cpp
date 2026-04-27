#include "AICartographer.h"
#include "Widgets/Docking/SDockTab.h"
#include "SWebBrowser.h"
#include "AICartographerBridge.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Styling/AppStyle.h"
#include "Misc/Paths.h"
#include "Interfaces/IPluginManager.h"

static const FName AICartographerTabName("AICartographer");

void FAICartographerModule::StartupModule()
{
    // 强制挂载到引擎底层的 Developer Tools 目录，无视 UE 5.7 菜单 API 变更
    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        FName("AICartographerTab"),
        FOnSpawnTab::CreateRaw(this, &FAICartographerModule::OnSpawnPluginTab)
    )
    .SetDisplayName(FText::FromString("AICartographer Web UI"))
    .SetTooltipText(FText::FromString("Open AI Cartographer Network Graph"))
    .SetGroup(WorkspaceMenu::GetMenuStructure().GetDeveloperToolsMiscCategory()) // 核心注入点
    .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "LevelEditor.Tabs.Viewports"));
    
    UE_LOG(LogTemp, Error, TEXT("[ARCHITECT_PROBE] AICartographer Tab Spawner Registered in Developer Tools!"));
}

void FAICartographerModule::ShutdownModule()
{
    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(FName("AICartographerTab"));
    UE_LOG(LogTemp, Warning, TEXT("[ARCHITECT_PROBE] AICartographer Module Shutdown."));
}



TSharedRef<SDockTab> FAICartographerModule::OnSpawnPluginTab(const FSpawnTabArgs& SpawnTabArgs)
{
    if (!RPCBridge.IsValid())
    {
        RPCBridge = TStrongObjectPtr<UAICartographerBridge>(NewObject<UAICartographerBridge>());
    }

    bool bIsDevMode = false; // 发布状态改为 false
    FString InitialURL;
    if (bIsDevMode) {
        InitialURL = TEXT("http://localhost:5173");
    } else {
        FString PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("AICartographer"))->GetBaseDir();
        FString HtmlPath = FPaths::Combine(PluginBaseDir, TEXT("Resources"), TEXT("WebUI"), TEXT("index.html"));
        HtmlPath = FPaths::ConvertRelativePathToFull(HtmlPath);
        HtmlPath = HtmlPath.Replace(TEXT("\\"), TEXT("/")); // CEF 反斜杠兼容修复
        InitialURL = FString::Printf(TEXT("file:///%s"), *HtmlPath);
    }

    // 1. Instantiate using the class member
    SAssignNew(this->WebBrowserWidget, SWebBrowser)
        .InitialURL(InitialURL)
        .ShowControls(false)
        .SupportsTransparency(true)
        // 2. Safe Lambda: Capture [this] because WebBrowserWidget is now a member
        .OnLoadCompleted(FSimpleDelegate::CreateLambda([this]() 
        {
            // 3. Access via this->
            if (this->WebBrowserWidget.IsValid() && RPCBridge.IsValid()) 
            {
                this->WebBrowserWidget->BindUObject(TEXT("aicartographerbridge"), RPCBridge.Get(), true);
                UE_LOG(LogTemp, Warning, TEXT("[AICARTOGRAPHER_ARCHITECT] RPC Bridge Bound to CEF Context Successfully."));
            }
        }));

    // RequestDeepScan is now a synchronous JS-callable UFUNCTION returning JSON
    // directly to the caller — no async delegate plumbing required.

    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            WebBrowserWidget.ToSharedRef()
        ];
}

IMPLEMENT_MODULE(FAICartographerModule, AICartographer)
