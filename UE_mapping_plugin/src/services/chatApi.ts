// AI chat — wired against the existing /api/analyze-blueprint endpoint as a
// quick stand-in until a proper RAG endpoint is built. The right pane sends
// the user's question + the active node's AI summary as "ast" placeholder.

const API_BASE = 'http://localhost:8000';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface AskOptions {
  question: string;
  contextNodeTitle?: string;
  contextSnippet?: string;
}

// Lightweight wrapper. Uses the analyze endpoint with a synthetic AST
// payload that just carries the question. The backend prompt currently
// expects an AST shape; we pack the question as a `__chat_question` field
// so the model sees it. Until a real /api/chat exists, this is good
// enough to validate the UI loop.
export async function askAI(opts: AskOptions): Promise<string> {
  const r = await fetch(`${API_BASE}/api/analyze-blueprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: opts.contextNodeTitle ?? 'CHAT_QUERY',
      ast: {
        __chat_question: opts.question,
        __chat_context: opts.contextSnippet ?? '',
      },
    }),
  });
  if (!r.ok) throw new Error(`chat HTTP ${r.status}`);
  const data = await r.json();
  return (data.summary as string) ?? '(empty response)';
}
