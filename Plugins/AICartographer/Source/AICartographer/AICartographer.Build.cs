using UnrealBuildTool;
public class AICartographer : ModuleRules
{
    public AICartographer(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "ToolMenus", "Projects", "AssetRegistry", "Json", "JsonUtilities", "BlueprintGraph", "UnrealEd" });
        PrivateDependencyModuleNames.AddRange(new string[] { "Slate", "SlateCore", "WebBrowser", "WorkspaceMenuStructure" });
    }
}
