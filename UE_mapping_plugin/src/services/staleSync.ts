import {
  bridgeGetStaleEventsSince,
  isStaleListenerAvailable,
} from './bridgeApi';
import { useStaleStore } from '../store/useStaleStore';

// Single-flight stale-sync controller (HANDOFF §20.4 P1).  AppShell calls
// startStaleSync() on mount; we poll the bridge every POLL_INTERVAL_MS and
// merge new events into useStaleStore.  Polling pauses gracefully when the
// bridge isn't bound (HTTP-only mode or pre-rebuild plugin) and resumes if
// the bridge later becomes ready.
//
// This is a module-level singleton — startStaleSync() called twice is a
// no-op so React StrictMode double-mounts don't kick off two pollers.

const POLL_INTERVAL_MS = 30_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function pollOnce(): Promise<void> {
  if (inFlight) return;                          // never overlap polls
  if (!isStaleListenerAvailable()) {
    // Bridge not bound (HTTP mode or pre-rebuild plugin).  No-op until the
    // bridge appears; no error logged so the console stays clean.
    return;
  }
  inFlight = true;
  try {
    const since = useStaleStore.getState().latestCounter;
    const result = await bridgeGetStaleEventsSince(since);
    useStaleStore.getState().applyEvents(result.events, result.latest_counter);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useStaleStore.getState().setLastError(msg);
    // eslint-disable-next-line no-console
    console.warn('[staleSync] poll failed:', msg);
  } finally {
    inFlight = false;
  }
}

export function startStaleSync(): void {
  if (intervalHandle !== null) return;           // already running
  useStaleStore.getState().setSyncActive(true);
  // Poll immediately so the user sees current state without a 30s wait,
  // then settle into the regular interval.
  void pollOnce();
  intervalHandle = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopStaleSync(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  useStaleStore.getState().setSyncActive(false);
}

// Force a poll immediately — used by scan-completion handlers that want to
// pick up the latest_counter before clearing local stale flags.
export function pollStaleNow(): Promise<void> {
  return pollOnce();
}
