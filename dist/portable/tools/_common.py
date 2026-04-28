"""Shared helpers for portable launcher / installer / stop tools.

Stdlib-only — these run before any venv is created.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

# ─── Console colors (Windows 10+ ANSI works in modern terminals) ────────────
RESET = "\033[0m"
BOLD = "\033[1m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
GRAY = "\033[90m"


def _enable_ansi_on_windows() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


_enable_ansi_on_windows()


def step(label: str, msg: str) -> None:
    print(f"{CYAN}[{label}]{RESET} {msg}")


def ok(msg: str) -> None:
    print(f"  {GREEN}OK{RESET}  {msg}")


def warn(msg: str) -> None:
    print(f"  {YELLOW}WARN{RESET}  {msg}")


def err(msg: str) -> None:
    print(f"  {RED}ERROR{RESET}  {msg}")


def info(msg: str) -> None:
    print(f"  {GRAY}--{RESET}  {msg}")


def banner(title: str) -> None:
    bar = "═" * max(40, len(title) + 6)
    print(f"\n{CYAN}{bar}{RESET}")
    print(f"{CYAN}║{RESET} {BOLD}{title}{RESET}")
    print(f"{CYAN}{bar}{RESET}")


# ─── Path resolution ─────────────────────────────────────────────────────────


def script_dir() -> Path:
    """Directory of the executing script (tools/)."""
    return Path(__file__).resolve().parent


def root_dir() -> Path:
    """The portable distribution root — tools/ parent."""
    return script_dir().parent


def runtime_dir() -> Path:
    return root_dir() / "runtime"


def state_path() -> Path:
    return runtime_dir() / ".state.json"


def backend_dir() -> Path:
    """Backend source — try sibling 'backend/' first, fall back to dev layout (../../backend)."""
    portable_layout = root_dir() / "backend"
    if portable_layout.exists():
        return portable_layout
    # Dev layout: dist/portable/tools/_common.py -> repo/backend
    dev_layout = root_dir().parent.parent / "backend"
    return dev_layout


def plugin_src_dir() -> Path:
    """Plugin source — try sibling 'plugin/AICartographer' first, then dev layout."""
    portable_layout = root_dir() / "plugin" / "AICartographer"
    if portable_layout.exists():
        return portable_layout
    dev_layout = root_dir().parent.parent / "Plugins" / "AICartographer"
    return dev_layout


def redis_exe() -> Path | None:
    """Locate a redis-server binary. Prefers bundled portable, falls back to Memurai/PATH."""
    candidates: list[Path] = []
    candidates.append(runtime_dir() / "redis" / "redis-server.exe")
    # Dev-mode: repo's bundled Redis
    candidates.append(root_dir().parent.parent / "Redis-x64-3.0.504" / "redis-server.exe")
    # Memurai default install
    candidates.append(Path(r"C:\Program Files\Memurai\memurai.exe"))
    candidates.append(Path(r"C:\Program Files (x86)\Memurai\memurai.exe"))
    for c in candidates:
        if c.exists():
            return c
    # PATH lookup
    path_hit = shutil.which("redis-server") or shutil.which("memurai")
    if path_hit:
        return Path(path_hit)
    return None


# ─── Process / port helpers ─────────────────────────────────────────────────


def is_port_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on the given TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def write_state(state: dict) -> None:
    runtime_dir().mkdir(parents=True, exist_ok=True)
    state_path().write_text(json.dumps(state, indent=2), encoding="utf-8")


def read_state() -> dict:
    p = state_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def clear_state() -> None:
    p = state_path()
    if p.exists():
        try:
            p.unlink()
        except OSError:
            pass


def kill_pid(pid: int) -> bool:
    """Best-effort taskkill. Returns True if the process was killed (or already gone)."""
    if pid <= 0:
        return False
    try:
        subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except Exception:
        return False


# ─── Python detection ────────────────────────────────────────────────────────


def find_system_python() -> tuple[str, list[str]] | None:
    """Find a system Python 3.11+. Returns (cmd, extra_args) or None."""
    candidates = [
        ("python", []),
        ("python3", []),
        ("py", ["-3"]),
    ]
    for cmd, extra in candidates:
        full = shutil.which(cmd)
        if not full:
            continue
        try:
            out = subprocess.run(
                [cmd, *extra, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (subprocess.SubprocessError, OSError):
            continue
        text = (out.stdout or out.stderr or "").strip()
        # Parse "Python 3.x.y"
        parts = text.split()
        if len(parts) >= 2 and parts[0].lower() == "python":
            try:
                major, minor = parts[1].split(".")[:2]
                if int(major) > 3 or (int(major) == 3 and int(minor) >= 11):
                    return cmd, extra
            except ValueError:
                continue
    return None


def venv_python() -> Path:
    return runtime_dir() / "python-venv" / "Scripts" / "python.exe"


def venv_exists() -> bool:
    return venv_python().exists()
