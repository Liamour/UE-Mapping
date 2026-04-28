"""Cleanly stop services started by launcher.py.

Reads runtime/.state.json to find PIDs, kills them with taskkill, removes the
state file. As a fallback, also probes well-known ports and kills the listening
PID if no state file is present.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common as C  # noqa: E402

PORTS = [6379, 8000]


def pids_listening_on(port: int) -> list[int]:
    """Return PIDs of processes listening on `port` (LISTENING state on Windows)."""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    pids: set[int] = set()
    pattern = re.compile(rf"\s\S+?:{port}\s+\S+\s+LISTENING\s+(\d+)\s*$")
    for line in (out.stdout or "").splitlines():
        m = pattern.search(line)
        if m:
            pids.add(int(m.group(1)))
    return sorted(pids)


def main() -> int:
    C.banner("AICartographer Stop")
    state = C.read_state()

    killed_any = False

    # 1. Kill PIDs from state file
    for label in ("backend_pid", "redis_pid"):
        pid = state.get(label)
        if not pid:
            continue
        C.info(f"Killing {label} = {pid}")
        if C.kill_pid(pid):
            killed_any = True

    # 2. Fallback: anything still bound to known ports
    for port in PORTS:
        for pid in pids_listening_on(port):
            C.info(f"Killing PID {pid} listening on :{port}")
            if C.kill_pid(pid):
                killed_any = True

    C.clear_state()

    if killed_any:
        C.ok("Stopped.")
    else:
        C.info("Nothing to stop — backend and Redis were not running.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
