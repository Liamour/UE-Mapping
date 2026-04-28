"""AICartographer portable launcher.

One-click bootstrap + run for end users:

  1. Detect system Python 3.11+
  2. Create runtime/python-venv if missing, install requirements
  3. Start bundled Redis (or Memurai/system redis-server) in background
  4. Start uvicorn in foreground
  5. Track PIDs in runtime/.state.json so STOP.bat can clean up if the user
     closes the console without Ctrl+C

Stdlib-only — bootstraps the venv before any third-party package is needed.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

# Local import — _common.py lives next to this file
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

REDIS_PORT = 6379
BACKEND_PORT = 8000


def ensure_venv() -> Path:
    """Make sure runtime/python-venv exists with requirements installed. Return the venv python.exe."""
    venv_py = C.venv_python()
    backend = C.backend_dir()
    requirements = backend / "requirements.txt"

    if not backend.exists():
        C.err(f"backend folder not found at {backend}")
        sys.exit(1)
    if not requirements.exists():
        C.err(f"requirements.txt not found at {requirements}")
        sys.exit(1)

    if venv_py.exists():
        # Quick sanity check: does fastapi import?
        check = subprocess.run(
            [str(venv_py), "-c", "import fastapi, uvicorn, redis, openai, anthropic"],
            capture_output=True,
            text=True,
        )
        if check.returncode == 0:
            C.ok(f"venv ready at {venv_py.parent.parent}")
            return venv_py
        C.warn("venv exists but dependencies are missing — reinstalling")

    sys_py = C.find_system_python()
    if not sys_py:
        C.err("Python 3.11+ not found on this system.")
        print()
        print("    Install from https://www.python.org/downloads/")
        print('    Make sure to check "Add Python to PATH" during installation.')
        print("    Then re-run START.bat.")
        sys.exit(1)
    cmd, extra = sys_py
    C.info(f"Using system Python: {cmd} {' '.join(extra)}".rstrip())

    venv_dir = C.runtime_dir() / "python-venv"
    if not venv_py.exists():
        C.step("setup", f"Creating virtualenv at {venv_dir}")
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run([cmd, *extra, "-m", "venv", str(venv_dir)])
        if result.returncode != 0 or not venv_py.exists():
            C.err("venv creation failed")
            sys.exit(1)
        C.ok("venv created")

    pip = venv_py.parent / "pip.exe"
    C.step("setup", "Upgrading pip")
    subprocess.run([str(pip), "install", "--upgrade", "pip", "--disable-pip-version-check", "-q"], check=False)

    C.step("setup", f"Installing dependencies from {requirements.name}")
    result = subprocess.run([str(pip), "install", "-r", str(requirements), "--disable-pip-version-check"])
    if result.returncode != 0:
        C.err("pip install failed")
        sys.exit(1)
    C.ok("dependencies installed")
    return venv_py


def start_redis() -> subprocess.Popen | None:
    """Start Redis if 6379 is free and a binary is available. Return Popen handle (or None if already running)."""
    if C.is_port_listening(REDIS_PORT):
        C.ok(f"Redis already listening on :{REDIS_PORT} (reusing)")
        return None

    redis = C.redis_exe()
    if redis is None:
        C.err("Redis binary not found.")
        print()
        print("    Expected locations:")
        print("      runtime\\redis\\redis-server.exe  (portable, shipped in release zip)")
        print("      C:\\Program Files\\Memurai\\memurai.exe")
        print("      anything named redis-server / memurai on PATH")
        print()
        print("    Download Memurai (free Developer edition) from https://www.memurai.com/get-memurai")
        sys.exit(1)

    C.step("redis", f"Starting {redis.name}")
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)

    proc = subprocess.Popen(
        [str(redis)],
        cwd=str(redis.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )

    # Give it 1 second to bind
    for _ in range(20):
        time.sleep(0.05)
        if C.is_port_listening(REDIS_PORT):
            C.ok(f"Redis up (PID {proc.pid})")
            return proc
        if proc.poll() is not None:
            C.err(f"Redis exited immediately (exit code {proc.returncode}) — port {REDIS_PORT} already busy?")
            sys.exit(1)
    C.warn(f"Redis started (PID {proc.pid}) but did not bind to :{REDIS_PORT} yet — continuing")
    return proc


def start_backend(venv_py: Path) -> subprocess.Popen:
    """Start uvicorn as a subprocess so we can manage its lifetime."""
    if C.is_port_listening(BACKEND_PORT):
        C.err(f"Port {BACKEND_PORT} already in use. Run STOP.bat first or check what is bound to it.")
        sys.exit(1)

    backend = C.backend_dir()
    C.step("backend", f"Starting uvicorn on :{BACKEND_PORT}")

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

    proc = subprocess.Popen(
        [str(venv_py), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(BACKEND_PORT)],
        cwd=str(backend),
        creationflags=creationflags,
    )
    return proc


def wait_for_backend(timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if C.is_port_listening(BACKEND_PORT):
            return True
        time.sleep(0.2)
    return False


def main() -> int:
    C.banner("AICartographer Portable Launcher")
    print(f"  Distribution root: {C.GRAY}{C.root_dir()}{C.RESET}")
    print(f"  Backend source:    {C.GRAY}{C.backend_dir()}{C.RESET}")
    print()

    venv_py = ensure_venv()
    redis_proc = start_redis()
    backend_proc = start_backend(venv_py)

    # Persist state so STOP.bat can clean up if user just closes the window
    state = {
        "redis_pid": redis_proc.pid if redis_proc else None,
        "backend_pid": backend_proc.pid,
        "started_at": time.time(),
    }
    C.write_state(state)

    if wait_for_backend():
        C.ok(f"Backend healthy at http://127.0.0.1:{BACKEND_PORT}/api/health")
    else:
        C.warn(f"Backend did not respond on :{BACKEND_PORT} within timeout — see logs above")

    print()
    print(f"{C.CYAN}══════════════════════════════════════════════════════════════════{C.RESET}")
    print(f"{C.CYAN}║{C.RESET} {C.BOLD}AICartographer is running.{C.RESET}")
    print(f"{C.CYAN}║{C.RESET}   Backend: http://127.0.0.1:{BACKEND_PORT}")
    print(f"{C.CYAN}║{C.RESET}   Health:  http://127.0.0.1:{BACKEND_PORT}/api/health")
    print(f"{C.CYAN}║{C.RESET}")
    print(f"{C.CYAN}║{C.RESET}   Open Unreal Engine and use the AICartographer tab.")
    print(f"{C.CYAN}║{C.RESET}   Plugin not installed yet? Run INSTALL-PLUGIN.bat first.")
    print(f"{C.CYAN}║{C.RESET}")
    print(f"{C.CYAN}║{C.RESET}   Press Ctrl+C to stop. Or just close this window and run STOP.bat.")
    print(f"{C.CYAN}══════════════════════════════════════════════════════════════════{C.RESET}")
    print()

    exit_code = 0
    try:
        # Wait for backend to die or user Ctrl+C
        while True:
            rc = backend_proc.poll()
            if rc is not None:
                C.warn(f"Backend exited with code {rc}")
                exit_code = rc
                break
            if redis_proc is not None and redis_proc.poll() is not None:
                C.warn(f"Redis exited unexpectedly with code {redis_proc.returncode}")
                exit_code = 1
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()
        C.info("Ctrl+C received — shutting down")

    # Cleanup
    for label, proc in (("backend", backend_proc), ("redis", redis_proc)):
        if proc is None:
            continue
        if proc.poll() is None:
            C.info(f"Stopping {label} (PID {proc.pid})")
            try:
                if os.name == "nt":
                    proc.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    proc.terminate()
                proc.wait(timeout=4)
            except (subprocess.TimeoutExpired, ValueError, OSError):
                C.kill_pid(proc.pid)

    C.clear_state()
    C.ok("Shut down cleanly.")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
