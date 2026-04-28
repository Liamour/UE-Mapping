"""Copy the AICartographer plugin into a target UE project and enable it.

Workflow:
  1. Ask the user for the path to a `.uproject` file (or detect candidates under
     %USERPROFILE%\\Documents\\Unreal Projects\\)
  2. Validate the file exists and is JSON
  3. Copy plugin/AICartographer/ -> <project>/Plugins/AICartographer/
  4. Patch the .uproject to enable the AICartographer plugin
  5. Open the destination Plugins/ folder in Explorer

Stdlib-only.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

PLUGIN_NAME = "AICartographer"


def detect_uproject_candidates() -> list[Path]:
    """Look for .uproject files under common locations."""
    home = Path.home()
    roots = [
        home / "Documents" / "Unreal Projects",
        home / "Documents" / "Unreal Engine Projects",
        home / "OneDrive" / "Documents" / "Unreal Projects",
    ]
    found: list[Path] = []
    for r in roots:
        if not r.exists():
            continue
        for child in r.iterdir():
            if not child.is_dir():
                continue
            for f in child.glob("*.uproject"):
                found.append(f)
    return sorted(set(found))


def prompt_for_uproject() -> Path:
    candidates = detect_uproject_candidates()
    print()
    if candidates:
        print(f"{C.CYAN}Detected UE projects:{C.RESET}")
        for i, p in enumerate(candidates, 1):
            print(f"  {C.BOLD}{i}{C.RESET}) {p}")
        print(f"  {C.BOLD}m{C.RESET}) enter a path manually")
        print()
        while True:
            choice = input(f"{C.CYAN}Pick a project [1-{len(candidates)} / m]:{C.RESET} ").strip()
            if choice.lower() == "m":
                break
            if choice.isdigit() and 1 <= int(choice) <= len(candidates):
                return candidates[int(choice) - 1]
            print(f"  {C.YELLOW}Invalid choice — try again{C.RESET}")
    print()
    print(f"{C.CYAN}Drag your .uproject file into this window, or paste its full path.{C.RESET}")
    while True:
        raw = input(f"{C.CYAN}Path to .uproject:{C.RESET} ").strip().strip('"').strip("'")
        if not raw:
            continue
        p = Path(raw)
        if p.is_dir():
            inside = list(p.glob("*.uproject"))
            if len(inside) == 1:
                p = inside[0]
            elif len(inside) > 1:
                print(f"  {C.YELLOW}{p} contains multiple .uproject files — pick one explicitly.{C.RESET}")
                continue
        if not p.exists():
            print(f"  {C.RED}Not found: {p}{C.RESET}")
            continue
        if p.suffix.lower() != ".uproject":
            print(f"  {C.RED}Not a .uproject file: {p}{C.RESET}")
            continue
        return p


def copy_plugin(uproject: Path, plugin_src: Path) -> Path:
    project_root = uproject.parent
    plugins_root = project_root / "Plugins"
    dest = plugins_root / PLUGIN_NAME

    if dest.exists():
        print()
        print(f"  {C.YELLOW}Plugin already exists at {dest}{C.RESET}")
        choice = input(f"  Replace it? This will delete the existing folder. [y/N]: ").strip().lower()
        if choice != "y":
            print(f"  {C.YELLOW}Skipping copy — keeping existing plugin folder.{C.RESET}")
            return dest
        C.info("Removing existing plugin folder")
        shutil.rmtree(dest)

    plugins_root.mkdir(parents=True, exist_ok=True)
    C.step("copy", f"{plugin_src} → {dest}")

    def _ignore(_src, names):
        return {n for n in names if n in {"Binaries", "Intermediate", "Saved", "DerivedDataCache", ".vs"}}

    shutil.copytree(plugin_src, dest, ignore=_ignore)
    C.ok(f"Plugin copied ({sum(1 for _ in dest.rglob('*'))} entries)")
    return dest


def patch_uproject(uproject: Path) -> bool:
    """Add AICartographer to .Plugins[]. Returns True if file was modified."""
    raw = uproject.read_text(encoding="utf-8-sig")
    data = json.loads(raw)
    plugins = data.setdefault("Plugins", [])
    for entry in plugins:
        if entry.get("Name") == PLUGIN_NAME:
            entry["Enabled"] = True
            uproject.write_text(json.dumps(data, indent=4), encoding="utf-8")
            C.ok(f"Plugin already listed — set Enabled=true in {uproject.name}")
            return True
    plugins.append({"Name": PLUGIN_NAME, "Enabled": True})
    uproject.write_text(json.dumps(data, indent=4), encoding="utf-8")
    C.ok(f"Added {PLUGIN_NAME} to {uproject.name} Plugins[]")
    return True


def open_in_explorer(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        subprocess.Popen(["explorer", str(path)])
    except OSError:
        pass


def main() -> int:
    C.banner("AICartographer Plugin Installer")

    plugin_src = C.plugin_src_dir()
    if not plugin_src.exists() or not (plugin_src / "AICartographer.uplugin").exists():
        C.err(f"Plugin source not found at {plugin_src}")
        C.info("Expected to find AICartographer.uplugin inside that folder.")
        return 1
    C.info(f"Plugin source: {plugin_src}")

    try:
        uproject = prompt_for_uproject()
    except (KeyboardInterrupt, EOFError):
        print()
        C.warn("Cancelled.")
        return 1
    C.info(f"Target project: {uproject}")

    dest = copy_plugin(uproject, plugin_src)
    patch_uproject(uproject)

    print()
    print(f"{C.CYAN}══════════════════════════════════════════════════════════════════{C.RESET}")
    print(f"{C.CYAN}║{C.RESET} {C.BOLD}Plugin installed.{C.RESET}")
    print(f"{C.CYAN}║{C.RESET}   Project:  {uproject}")
    print(f"{C.CYAN}║{C.RESET}   Plugin:   {dest}")
    print(f"{C.CYAN}║{C.RESET}")
    print(f"{C.CYAN}║{C.RESET} {C.BOLD}Next steps:{C.RESET}")
    print(f"{C.CYAN}║{C.RESET}   1. Make sure START.bat is running (so the backend is live).")
    print(f"{C.CYAN}║{C.RESET}   2. Open the .uproject. UE will rebuild the plugin on first launch")
    print(f"{C.CYAN}║{C.RESET}      (requires Visual Studio with C++ workload).")
    print(f"{C.CYAN}║{C.RESET}   3. In UE, Window → Developer Tools → Misc → AICartographer Web UI")
    print(f"{C.CYAN}║{C.RESET}      (or search 'AICartographer' in the Window menu).")
    print(f"{C.CYAN}║{C.RESET}   4. Settings → Project root → set to the folder of your .uproject.")
    print(f"{C.CYAN}║{C.RESET}   5. Settings → LLM Provider → fill key → Test connection.")
    print(f"{C.CYAN}══════════════════════════════════════════════════════════════════{C.RESET}")

    open_in_explorer(dest.parent)
    return 0


if __name__ == "__main__":
    sys.exit(main())
