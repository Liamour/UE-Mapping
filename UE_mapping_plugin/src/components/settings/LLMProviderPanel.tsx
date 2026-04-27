// LLM provider configuration panel surfaced inside SettingsModal.
//
// Owns:
//   - provider selector (Volcengine / Claude)
//   - per-provider config inputs (key, endpoint/model, effort)
//   - global concurrency slider (passed to backend's worker pool)
//   - "Test connection" button (POSTs to /api/v1/llm/test-connection)
//   - "Clear all credentials" destructive action
//
// Storage: useLLMStore writes everything to localStorage under a single
// namespaced key; nothing related to credentials is ever written into the
// project directory.  The tooltip on the panel header makes that promise
// visible to the user so they can hand the project to a teammate without
// fearing a leak.

import React, { useState } from 'react';
import {
  useLLMStore,
  type Provider,
  type ClaudeModel,
  type ClaudeEffort,
  type OutputLanguage,
} from '../../store/useLLMStore';
import { postTestConnection } from '../../services/scanApi';
import { useT } from '../../utils/i18n';

const CLAUDE_MODELS: Array<{ id: ClaudeModel; label: string; sub: string }> = [
  { id: 'opus',   label: 'Opus 4.7',   sub: 'flagship — deepest reasoning, slowest' },
  { id: 'sonnet', label: 'Sonnet 4.6', sub: 'balanced — good default' },
  { id: 'haiku',  label: 'Haiku 4.5',  sub: 'fastest, cheapest' },
];

const EFFORT_LEVELS: Array<{ id: ClaudeEffort; label: string; budget: string }> = [
  { id: 'low',        label: 'Low',         budget: 'no thinking' },
  { id: 'medium',     label: 'Medium',      budget: '4k tokens' },
  { id: 'high',       label: 'High',        budget: '16k tokens' },
  { id: 'extra_high', label: 'Extra High',  budget: '32k tokens' },
  { id: 'max',        label: 'Max',         budget: '64k tokens' },
];

const LANGUAGES: Array<{ id: OutputLanguage; label: string; sub: string }> = [
  { id: 'en', label: 'English',  sub: 'default — narrative + system summaries in English' },
  { id: 'zh', label: '简体中文', sub: '所有 intent / 分析正文 / 系统总览改为中文（标签词保留英文）' },
];

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; provider: string; model: string; latencyMs: number; sample: string; tokens: { in: number; out: number; thinking: number } }
  | { kind: 'error'; message: string };

export const LLMProviderPanel: React.FC = () => {
  const t = useT();
  const provider = useLLMStore((s) => s.provider);
  const volcengine = useLLMStore((s) => s.volcengine);
  const claude = useLLMStore((s) => s.claude);
  const concurrency = useLLMStore((s) => s.concurrency);
  const language = useLLMStore((s) => s.language);
  const setProvider = useLLMStore((s) => s.setProvider);
  const setVolcengine = useLLMStore((s) => s.setVolcengine);
  const setClaude = useLLMStore((s) => s.setClaude);
  const setConcurrency = useLLMStore((s) => s.setConcurrency);
  const setLanguage = useLLMStore((s) => s.setLanguage);
  const clearAll = useLLMStore((s) => s.clearAll);
  const getProviderConfig = useLLMStore((s) => s.getProviderConfig);

  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const onTest = async () => {
    const cfg = getProviderConfig();
    if (!cfg) {
      setTest({
        kind: 'error',
        message: t({
          en: 'Fill in the required fields for the selected provider first.',
          zh: '请先填写所选服务商的必填字段。',
        }),
      });
      return;
    }
    setTest({ kind: 'running' });
    try {
      const r = await postTestConnection(cfg);
      setTest({
        kind: 'ok',
        provider: r.provider,
        model: r.model,
        latencyMs: r.latency_ms,
        sample: r.sample_text,
        tokens: { in: r.tokens_in, out: r.tokens_out, thinking: r.thinking_tokens },
      });
    } catch (e) {
      setTest({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onClear = () => {
    if (!confirm(t({
      en: 'Clear all LLM credentials from this browser? This cannot be undone.',
      zh: '清除本浏览器中所有 LLM 凭据？此操作无法撤销。',
    }))) return;
    clearAll();
    setTest({ kind: 'idle' });
  };

  return (
    <div className="llm-panel">
      <p className="muted llm-panel-privacy">
        {t({
          en: "Keys live only in this browser's localStorage and travel with each request. The backend never persists them; nothing about your credentials is written into the project directory.",
          zh: '密钥仅保存在本浏览器的 localStorage 中，每次请求时随附发送。后端永不持久化这些凭据；项目目录中不会写入任何凭据信息。',
        })}
      </p>

      <div className="llm-provider-tabs">
        <ProviderTab id="volcengine" label={t({ en: 'Volcengine (Doubao)', zh: '火山引擎（豆包）' })} current={provider} onClick={setProvider} />
        <ProviderTab id="claude" label={t({ en: 'Anthropic Claude', zh: 'Anthropic Claude' })} current={provider} onClick={setProvider} />
      </div>

      {provider === 'volcengine' && (
        <div className="llm-provider-form">
          <Field label={t({ en: 'Endpoint ID', zh: 'Endpoint ID' })} hint={t({
            en: 'e.g. ep-m-20260426094337-qnwsw — find this in the Volcengine console under your model endpoint.',
            zh: '例如 ep-m-20260426094337-qnwsw — 在火山引擎控制台的模型 endpoint 下可找到。',
          })}>
            <input
              className="settings-input"
              type="text"
              value={volcengine.endpoint}
              placeholder="ep-..."
              onChange={(e) => setVolcengine({ endpoint: e.target.value.trim() })}
              autoComplete="off"
            />
          </Field>
          <Field label={t({ en: 'API key', zh: 'API 密钥' })}>
            <input
              className="settings-input"
              type="password"
              value={volcengine.apiKey}
              placeholder={t({ en: 'paste your ARK API key', zh: '粘贴你的 ARK API 密钥' })}
              onChange={(e) => setVolcengine({ apiKey: e.target.value.trim() })}
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {provider === 'claude' && (
        <div className="llm-provider-form">
          <Field label={t({ en: 'API key', zh: 'API 密钥' })}>
            <input
              className="settings-input"
              type="password"
              value={claude.apiKey}
              placeholder="sk-ant-..."
              onChange={(e) => setClaude({ apiKey: e.target.value.trim() })}
              autoComplete="off"
            />
          </Field>
          <Field label={t({ en: 'Model', zh: '模型' })}>
            <div className="llm-radio-row">
              {CLAUDE_MODELS.map((m) => (
                <label key={m.id} className={`llm-radio-card ${claude.model === m.id ? 'llm-radio-card-active' : ''}`}>
                  <input
                    type="radio"
                    name="claude-model"
                    checked={claude.model === m.id}
                    onChange={() => setClaude({ model: m.id })}
                  />
                  <div>
                    <div className="llm-radio-card-label">{m.label}</div>
                    <div className="llm-radio-card-sub muted">{m.sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </Field>
          <Field label={t({ en: 'Reasoning effort', zh: '推理深度' })} hint={t({
            en: 'Higher effort = larger extended-thinking budget. Slower and more expensive but yields deeper analysis.',
            zh: '深度越高，扩展思考预算越大。更慢更贵，但能得到更深入的分析。',
          })}>
            <div className="llm-effort-row">
              {EFFORT_LEVELS.map((e) => (
                <button
                  key={e.id}
                  className={`llm-effort-btn ${claude.effort === e.id ? 'llm-effort-btn-active' : ''}`}
                  onClick={() => setClaude({ effort: e.id })}
                  title={t({ en: `thinking budget: ${e.budget}`, zh: `思考预算：${e.budget}` })}
                  type="button"
                >
                  <div>{e.label}</div>
                  <div className="llm-effort-btn-sub">{e.budget}</div>
                </button>
              ))}
            </div>
          </Field>
        </div>
      )}

      <Field
        label={language === 'zh' ? '语言' : 'Language'}
        hint={language === 'zh'
          ? '同时影响 UI 文案和 LLM 生成的叙事文本（intent、分析正文、系统总览）。受控词表的取值（system axis、layer、role 等）始终保持英文，因为它们是前端解析的键。'
          : 'Affects both the UI chrome and the LLM-generated narrative text (intent, ANALYSIS body, system summaries). Vocabulary tag values stay English regardless — they are keys consumed by the frontend.'}>
        <div className="llm-radio-row">
          {LANGUAGES.map((l) => (
            <label key={l.id} className={`llm-radio-card ${language === l.id ? 'llm-radio-card-active' : ''}`}>
              <input
                type="radio"
                name="output-language"
                checked={language === l.id}
                onChange={() => setLanguage(l.id)}
              />
              <div>
                <div className="llm-radio-card-label">{l.label}</div>
                <div className="llm-radio-card-sub muted">{l.sub}</div>
              </div>
            </label>
          ))}
        </div>
      </Field>

      <Field label={t({ en: 'Batch concurrency', zh: '批量并发数' })} hint={t({
        en: 'Backend worker pool size — controls how many LLM calls run in parallel during bulk scans. Capped at 64.',
        zh: '后端工作线程池大小 — 控制批量扫描时并行的 LLM 调用数。上限 64。',
      })}>
        <div className="llm-concurrency-row">
          <input
            type="range"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
          <input
            type="number"
            className="settings-input llm-concurrency-num"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
        </div>
      </Field>

      <div className="llm-panel-actions">
        <button className="btn-primary" onClick={onTest} disabled={test.kind === 'running'}>
          {test.kind === 'running' ? t({ en: 'Testing…', zh: '测试中…' }) : t({ en: 'Test connection', zh: '测试连接' })}
        </button>
        <button className="btn-text llm-panel-clear" onClick={onClear}>
          {t({ en: 'Clear all credentials', zh: '清除全部凭据' })}
        </button>
      </div>

      <TestResult state={test} />
    </div>
  );
};

const ProviderTab: React.FC<{
  id: Provider;
  label: string;
  current: Provider;
  onClick: (p: Provider) => void;
}> = ({ id, label, current, onClick }) => (
  <button
    className={`llm-provider-tab ${current === id ? 'llm-provider-tab-active' : ''}`}
    onClick={() => onClick(id)}
  >
    {label}
  </button>
);

const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div className="llm-field">
    <div className="llm-field-label">{label}</div>
    {children}
    {hint && <div className="llm-field-hint muted">{hint}</div>}
  </div>
);

const TestResult: React.FC<{ state: TestState }> = ({ state }) => {
  const t = useT();
  if (state.kind === 'idle') return null;
  if (state.kind === 'running') {
    return <div className="settings-status">{t({ en: 'Pinging provider…', zh: '正在探测服务商…' })}</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="settings-status settings-status-error">
        <div>{t({ en: `Connection failed: ${state.message}`, zh: `连接失败：${state.message}` })}</div>
      </div>
    );
  }
  return (
    <div className="settings-status">
      <div>
        <strong>{t({ en: 'OK', zh: '正常' })}</strong> · {state.provider} ({state.model}) · {state.latencyMs}ms
      </div>
      <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
        {t({ en: 'tokens in/out/thinking:', zh: 'token 输入/输出/思考：' })} {state.tokens.in} / {state.tokens.out} / {state.tokens.thinking}
      </div>
      {state.sample && (
        <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {t({ en: 'reply:', zh: '回复：' })} <code>{state.sample}</code>
        </div>
      )}
    </div>
  );
};
