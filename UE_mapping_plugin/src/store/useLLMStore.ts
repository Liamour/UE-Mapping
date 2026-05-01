// LLM provider configuration store.
//
// Lives ONLY in browser localStorage — never written to project files.  The
// backend reads the config from the request payload on every scan call and
// discards it; nothing related to the user's API keys ever lands on disk on
// the project side.  When the project is packaged for handoff, no credential
// trace remains.
//
// Storage key is namespaced (`aicartographer.llm.config`) so a future "Clear
// all credentials" action only needs to touch one localStorage entry.

import { create } from 'zustand';

const STORAGE_KEY = 'aicartographer.llm.config';

export type Provider = 'volcengine' | 'claude' | 'openai_compat';
export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'extra_high' | 'max';
// Output language for LLM-generated narrative text (intent / ANALYSIS body /
// system summaries).  Vocabulary tag values stay English regardless — they're
// keys consumed by the frontend.
export type OutputLanguage = 'en' | 'zh';

export interface VolcengineConfig {
  endpoint: string;       // ep-... model endpoint id (Volcengine treats this as the "model")
  apiKey: string;
}

export interface ClaudeConfig {
  apiKey: string;
  model: ClaudeModel;
  effort: ClaudeEffort;
}

// Generic OpenAI-compatible provider — escape hatch for OpenAI itself,
// OpenRouter, DeepSeek, Together, Groq, Fireworks, local LM Studio / Ollama,
// or any server that speaks /v1/chat/completions.  All three fields are
// required by the backend; ProviderConfigPayload is null until they're filled.
export interface OpenAICompatConfig {
  baseUrl: string;        // e.g. https://api.openai.com/v1, https://api.deepseek.com/v1
  apiKey: string;
  model: string;          // e.g. gpt-4o-mini, deepseek-chat, qwen2.5-coder:32b
}

export interface ProviderConfigPayload {
  provider: Provider;
  api_key: string;
  endpoint?: string;
  model?: string;
  effort?: string;
  base_url?: string;      // openai_compat only
  concurrency?: number;
  language?: OutputLanguage;
}

interface LLMState {
  provider: Provider;
  volcengine: VolcengineConfig;
  claude: ClaudeConfig;
  openaiCompat: OpenAICompatConfig;
  concurrency: number;     // batch worker pool override sent to backend
  language: OutputLanguage; // narrative output language (en | zh)

  setProvider: (p: Provider) => void;
  setVolcengine: (patch: Partial<VolcengineConfig>) => void;
  setClaude: (patch: Partial<ClaudeConfig>) => void;
  setOpenAICompat: (patch: Partial<OpenAICompatConfig>) => void;
  setConcurrency: (n: number) => void;
  setLanguage: (lang: OutputLanguage) => void;
  clearAll: () => void;

  // Returns the canonical payload the backend expects in `provider_config`.
  // Returns null when the active provider is missing required fields — caller
  // should prevent the user from kicking off a scan in that case.
  getProviderConfig: () => ProviderConfigPayload | null;
  // True when the active provider has the minimum fields filled in.
  isReady: () => boolean;
}

const DEFAULT_STATE = {
  provider: 'claude' as Provider,
  volcengine: { endpoint: '', apiKey: '' } as VolcengineConfig,
  claude: { apiKey: '', model: 'sonnet' as ClaudeModel, effort: 'medium' as ClaudeEffort } as ClaudeConfig,
  openaiCompat: { baseUrl: '', apiKey: '', model: '' } as OpenAICompatConfig,
  concurrency: 20,
  language: 'en' as OutputLanguage,
};

const VALID_PROVIDERS: Provider[] = ['volcengine', 'claude', 'openai_compat'];

function loadInitial(): typeof DEFAULT_STATE {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      provider: VALID_PROVIDERS.includes(parsed.provider) ? parsed.provider : DEFAULT_STATE.provider,
      volcengine: { ...DEFAULT_STATE.volcengine, ...(parsed.volcengine ?? {}) },
      claude: { ...DEFAULT_STATE.claude, ...(parsed.claude ?? {}) },
      openaiCompat: { ...DEFAULT_STATE.openaiCompat, ...(parsed.openaiCompat ?? {}) },
      concurrency: typeof parsed.concurrency === 'number' ? parsed.concurrency : DEFAULT_STATE.concurrency,
      language: parsed.language === 'zh' || parsed.language === 'en' ? parsed.language : DEFAULT_STATE.language,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(state: typeof DEFAULT_STATE) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: state.provider,
      volcengine: state.volcengine,
      claude: state.claude,
      openaiCompat: state.openaiCompat,
      concurrency: state.concurrency,
      language: state.language,
    }));
  } catch { /* ignore quota / privacy mode failures */ }
}

const initial = loadInitial();

export const useLLMStore = create<LLMState>((set, get) => ({
  provider: initial.provider,
  volcengine: initial.volcengine,
  claude: initial.claude,
  openaiCompat: initial.openaiCompat,
  concurrency: initial.concurrency,
  language: initial.language,

  setProvider: (p) => {
    set({ provider: p });
    persist({ ...get(), provider: p });
  },
  setVolcengine: (patch) => {
    const next = { ...get().volcengine, ...patch };
    set({ volcengine: next });
    persist({ ...get(), volcengine: next });
  },
  setClaude: (patch) => {
    const next = { ...get().claude, ...patch };
    set({ claude: next });
    persist({ ...get(), claude: next });
  },
  setOpenAICompat: (patch) => {
    const next = { ...get().openaiCompat, ...patch };
    set({ openaiCompat: next });
    persist({ ...get(), openaiCompat: next });
  },
  setConcurrency: (n) => {
    const clamped = Math.max(1, Math.min(64, Math.round(n) || 1));
    set({ concurrency: clamped });
    persist({ ...get(), concurrency: clamped });
  },
  setLanguage: (lang) => {
    set({ language: lang });
    persist({ ...get(), language: lang });
  },
  clearAll: () => {
    set({
      provider: DEFAULT_STATE.provider,
      volcengine: { ...DEFAULT_STATE.volcengine },
      claude: { ...DEFAULT_STATE.claude },
      openaiCompat: { ...DEFAULT_STATE.openaiCompat },
      concurrency: DEFAULT_STATE.concurrency,
      language: DEFAULT_STATE.language,
    });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  },

  getProviderConfig: () => {
    const s = get();
    if (s.provider === 'volcengine') {
      if (!s.volcengine.apiKey || !s.volcengine.endpoint) return null;
      return {
        provider: 'volcengine',
        api_key: s.volcengine.apiKey,
        endpoint: s.volcengine.endpoint,
        concurrency: s.concurrency,
        language: s.language,
      };
    }
    if (s.provider === 'openai_compat') {
      const o = s.openaiCompat;
      if (!o.apiKey || !o.baseUrl || !o.model) return null;
      return {
        provider: 'openai_compat',
        api_key: o.apiKey,
        base_url: o.baseUrl,
        model: o.model,
        concurrency: s.concurrency,
        language: s.language,
      };
    }
    if (!s.claude.apiKey) return null;
    return {
      provider: 'claude',
      api_key: s.claude.apiKey,
      model: s.claude.model,
      effort: s.claude.effort,
      concurrency: s.concurrency,
      language: s.language,
    };
  },

  isReady: () => get().getProviderConfig() !== null,
}));
