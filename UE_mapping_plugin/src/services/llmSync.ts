// Stub layer for the post-sync LLM analysis hook.
//
// When auto-LLM is on (useSyncSettingsStore.autoLlmAfterSync === true),
// the sync engine asks this module to deep-analyse each added/updated
// node *after* its skeleton .md has been written.  Right now the RAG +
// LLM pipeline isn't wired up — calls return `{ ok: false, reason: ... }`
// and the toggle in Settings is rendered disabled with a tooltip.
//
// When the real path lands later:
//   1. Flip isLlmAnalysisAvailable() to inspect llmStore + provider config
//   2. Replace the runLlmAnalysisForAsset body with the actual call
//      (typically postSingleScan + a RAG context fetch)
//   3. The Settings toggle and the Apply-all confirm-modal checkbox both
//      go live with no UI changes.
//
// Keep the function signatures stable across the swap — every caller in
// syncEngine.ts treats this module as an opaque boundary.

export interface LlmAnalysisResult {
  ok: boolean;
  reason?: string;
}

// Capability probe — true once RAG+LLM is wired and the user has both a
// configured provider and a reachable backend.  The TopBar confirm modal
// disables its "Run LLM analysis" checkbox when this returns false, and
// uses it to surface a clear "暂未启用" tooltip.
export function isLlmAnalysisAvailable(): boolean {
  return false;
}

export async function runLlmAnalysisForAsset(
  _projectRoot: string,
  _assetPath: string,
): Promise<LlmAnalysisResult> {
  return {
    ok: false,
    reason: 'LLM analysis pipeline not yet wired (placeholder — see services/llmSync.ts).',
  };
}

export async function runLlmAnalysisBatch(
  projectRoot: string,
  assetPaths: string[],
): Promise<{ done: number; failed: number; reasons: string[] }> {
  let done = 0;
  let failed = 0;
  const reasons: string[] = [];
  for (const p of assetPaths) {
    const r = await runLlmAnalysisForAsset(projectRoot, p);
    if (r.ok) done++;
    else { failed++; if (r.reason) reasons.push(`${p}: ${r.reason}`); }
  }
  return { done, failed, reasons };
}
