#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "UObject/StrongObjectPtr.h"

class UAICartographerBridge; // 前置声明

class FAICartographerModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
    TSharedRef<class SDockTab> OnSpawnPluginTab(const class FSpawnTabArgs& SpawnTabArgs);

private:
    TStrongObjectPtr<UAICartographerBridge> RPCBridge;
    TSharedPtr<class SWebBrowser> WebBrowserWidget;
};
