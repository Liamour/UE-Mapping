import {
  bridgeGetStaleEventsSince,
  isStaleListenerAvailable,
} from './bridgeApi';
import { useStaleStore } from '../store/useStaleStore';
import { maybeAutoApply } from './syncEngine';

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
    const beforeCount = useStaleStore.getState().staleByPath.size;
    useStaleStore.getState().applyEvents(result.events, result.latest_counter);
    const afterCount = useStaleStore.getState().staleByPath.size;
    // Only invoke auto-apply when the poll actually surfaced new entries.
    // (afterCount may also drop if dedup retired a renamed pair — that's
    // also fine to ignore since nothing user-actionable was added.)
    if (afterCount > beforeCount || result.events.length > 0) {
      try { await maybeAutoApply(); } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[staleSync] auto-apply failed:', e);
      }
    }
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
