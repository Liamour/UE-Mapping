import React, { useEffect, useMemo, useState } from 'react';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useLLMStore } from '../../store/useLLMStore';
import { useUIStore } from '../../store/useUIStore';
import { useStaleStore } from '../../store/useStaleStore';
import { MiniMarkdown } from '../../utils/miniMarkdown';
import type { VaultEdge } from '../../utils/frontmatter';
import { NotesEditor } from '../notes/NotesEditor';
import { postSingleScan, type SingleScanResponse } from '../../services/scanApi';
import { buildScanNodeFromFrontmatter } from '../../services/scanPayload';
import { bridgeOpenInEditor, isOpenInEditorAvailable } from '../../services/bridgeApi';
import { useT } from '../../utils/i18n';

interface Props {
  relativePath: string;
}

export const Lv2BlueprintFocus: React.FC<Props> = ({ relativePath }) => {
  const t = useT();
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const invalidateFile = useVaultStore((s) => s.invalidateFile);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const navigate = useTabsStore((s) => s.navigateActive);
  const activeSystemId = useTabsStore(
    (s) => s.tabs.find((t) => t.id === s.activeId)?.location.systemId,
  );
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const getProviderConfig = useLLMStore((s) => s.getProviderConfig);
  const llmProvider = useLLMStore((s) => s.provider);
  const removeStalePath = useStaleStore((s) => s.removePath);
  const staleByPath = useStaleStore((s) => s.staleByPath);

  useEffect(() => {
    if (!file) loadFile(relativePath);
  }, [relativePath, file, loadFile]);

  // Build a title → relativePath index for [[backlinks]] resolution
  const titleToPath = useMemo(() => {
    const idx: Record<string, string> = {};
    for (const f of files) idx[f.title] = f.relative_path;
    // also use loaded titles
    for (const cached of Object.values(fileCache)) {
      const t = cached.frontmatter.title;
      if (typeof t === 'string') idx[t] = cached.relative_path;
    }
    return idx;
  }, [files, fileCache]);

  const onLinkClick = (target: string) => {
    const path = titleToPath[target];
    if (path) navigate({ level: 'lv2', relativePath: path }, target);
  };

  // Deep-reasoning state — runs the single-node LLM scan against the active
  // provider, then reloads the .md so the new INTENT/ANALYSIS show inline.
  type DeepState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; result: SingleScanResponse }
    | { kind: 'error'; message: string };
  const [deepState, setDeepState] = useState<DeepState>({ kind: 'idle' });

  // "Jump to UE" — opens the BP editor for this asset.  Hidden when the
  // bridge is unavailable (HTTP-only mode) or the C++ binary is too old to
  // have OpenInEditor bound.
  const [openState, setOpenState] = useState<{ kind: 'idle' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const canOpenInUE = isOpenInEditorAvailable();
  const onOpenInUE = async () => {
    if (!file) return;
    const fmLocal = file.frontmatter;
    const assetPath = (fmLocal.asset_path as string) ?? '';
    if (!assetPath) {
      setOpenState({ kind: 'error', message: t({ en: 'No asset_path in frontmatter.', zh: 'frontmatter 中缺少 asset_path。' }) });
      return;
    }
    try {
      await bridgeOpenInEditor(assetPath, '');
      setOpenState({ kind: 'idle' });
    } catch (e) {
      setOpenState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const runDeepReasoning = async () => {
    const cfg = getProviderConfig();
    if (!cfg) {
      setDeepState({
        kind: 'error',
        message: t({
          en: `${llmProvider} is not configured. Open Settings → LLM provider to add credentials.`,
          zh: `${llmProvider} 未配置。请打开 设置 → LLM 服务商 添加凭据。`,
        }),
      });
      return;
    }
    if (!projectRoot) {
      setDeepState({ kind: 'error', message: t({ en: 'No project root set.', zh: '未设置项目根目录。' }) });
      return;
    }
    if (!file) return;
    setDeepState({ kind: 'running' });
    try {
      // Single source of truth: build the LLM payload from the existing
      // frontmatter through the shared helper.  This keeps batch and
      // single-node scans in sync — same ast_data shape, same edge
      // vocabulary, and (critically) outbound_edges is now populated so the
      // vault writer preserves the `edges:` block on rerun.  See §15.7.
      const result = await postSingleScan({
        node: buildScanNodeFromFrontmatter(file.frontmatter, relativePath),
        project_root: projectRoot,
        provider_config: cfg,
      });
      // Refresh from disk so the new aiSection / frontmatter render
      invalidateFile(relativePath);
      await loadFile(relativePath);
      setDeepState({ kind: 'done', result });
      // Single-node scan resolves staleness for this asset.
      const apForClear = (file.frontmatter.asset_path as string) ?? '';
      if (apForClear) removeStalePath(apForClear);
    } catch (e) {
      setDeepState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // ⚠ Hook ordering: every hook (useMemo / useState / useEffect) MUST run
  // before any early return — otherwise the hook count changes between
  // renders when `file` transitions from undefined to loaded, and React
  // throws "Rendered fewer/more hooks than expected" (minified #300 / #310).
  // `staleEntry` previously sat below the `if (!file) return` guard which
  // worked only when the file was always cache-warm; navigating in cold
  // (e.g. Lv4 ↔ Lv2 tab swap) tripped the rule.
  const assetPathForStale = (file?.frontmatter.asset_path as string | undefined) ?? '';
  const staleEntry = useMemo(() => {
    if (!assetPathForStale) return undefined;
    const direct = staleByPath.get(assetPathForStale);
    if (direct) return direct;
    for (const e of staleByPath.values()) {
      if (e.type === 'renamed' && e.previousPath === assetPathForStale) return e;
    }
    return undefined;
  }, [staleByPath, assetPathForStale]);

  if (!file) {
    return <div className="empty-state"><p>{t({ en: 'Loading note…', zh: '正在加载笔记…' })}</p></div>;
  }

  const fm = file.frontmatter;
  const tags = (fm.tags ?? []) as string[];
  const fns = (fm.exports_functions ?? []) as string[];
  const events = (fm.exports_events ?? []) as string[];
  const dispatchers = (fm.exports_dispatchers ?? []) as string[];
  const variables = (fm.variables ?? []) as Array<Record<string, unknown>>;
  const analysisState = (fm.analysis_state as string | undefined) ?? 'skeleton';
  const isCurrentStale = !!staleEntry;

  return (
    <div className="bp-focus">
      <div className="bp-focus-header">
        <div className="bp-focus-titlebar">
          <h1 className="bp-focus-title">{(fm.title as string) ?? relativePath}</h1>
          <div className="bp-focus-meta">
            <Pill kind="type">{(fm.node_type as string) ?? 'Blueprint'}</Pill>
            {fm.parent_class && <Pill kind="parent">{t({ en: 'extends', zh: '继承自' })} {fm.parent_class as string}</Pill>}
            <Pill kind={`risk-${(fm.risk_level as string) ?? 'nominal'}`}>{(fm.risk_level as string) ?? 'nominal'}</Pill>
            <Pill kind={analysisState === 'llm' ? 'analysis-llm' : 'analysis-skeleton'}>
              {analysisState === 'llm'
                ? t({ en: 'LLM analyzed', zh: '已 LLM 分析' })
                : t({ en: 'skeleton', zh: '骨架' })}
            </Pill>
            {isCurrentStale && staleEntry && (() => {
              // Detect which side of a rename this Lv2 is viewing:
              //   - 'to':   vault note still at OLD path (most common — user
              //             renamed in UE, vault hasn't been migrated yet)
              //   - 'from': vault note at NEW path (rare — manual frontmatter edit)
              //   - null:   not a rename (deleted / added / updated)
              const renameDir: 'to' | 'from' | null =
                staleEntry.type === 'renamed'
                  ? (assetPathForStale === staleEntry.previousPath ? 'to' : 'from')
                  : null;
              const newName = staleEntry.path.split('/').pop()?.split('.')[0] ?? '';
              const oldName = (staleEntry.previousPath ?? '').split('/').pop()?.split('.')[0] ?? '';
              const label =
                staleEntry.type === 'removed' ? t({ en: 'Deleted in editor', zh: '编辑器中已删除' }) :
                staleEntry.type === 'renamed' && renameDir === 'to' ? t({ en: `Renamed to ${newName} in editor`, zh: `编辑器中已重命名为 ${newName}` }) :
                staleEntry.type === 'renamed' && renameDir === 'from' ? t({ en: `Renamed from ${oldName} in editor`, zh: `编辑器中已从 ${oldName} 重命名` }) :
                staleEntry.type === 'renamed' ? t({ en: 'Renamed in editor', zh: '编辑器中已重命名' }) :
                t({ en: 'Changed in editor', zh: '编辑器中已变更' });
              return (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 12px',
                    borderRadius: 14,
                    background: '#dc2626',
                    color: '#fff',
                    fontSize: 'var(--fs-sm)',
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    boxShadow: '0 1px 2px rgba(220, 38, 38, 0.4)',
                  }}
                  title={t({
                    en: 'Open the TopBar dropdown to apply this rename in vault, or re-run Deep Reasoning manually',
                    zh: '打开 TopBar 下拉可一键应用 vault 重命名，或手动点击下方"深度推理"',
                  })}
                >
                  ⚠ {label} — {t({ en: 'rescan needed', zh: '需要重扫' })}
                </span>
              );
            })()}
          </div>
          <div className="bp-focus-deep">
            <button
              className={`btn-primary deep-reason-btn ${analysisState === 'llm' ? 'deep-reason-btn-rerun' : ''}`}
              onClick={runDeepReasoning}
              disabled={deepState.kind === 'running'}
              title={analysisState === 'llm'
                ? t({ en: 'Re-run LLM analysis (overwrites the AI section, preserves NOTES)', zh: '重新运行 LLM 分析（覆盖 AI 段，保留 NOTES）' })
                : t({ en: 'Run LLM analysis on this single blueprint — uses the active provider in Settings', zh: '对当前蓝图运行 LLM 分析 — 使用设置中选定的服务商' })}
            >
              {deepState.kind === 'running'
                ? t({ en: 'Reasoning…', zh: '推理中…' })
                : analysisState === 'llm'
                ? t({ en: 'Re-run deep reasoning', zh: '重新深度推理' })
                : t({ en: 'Deep reasoning', zh: '深度推理' })}
            </button>
            <button
              className="btn-text"
              onClick={() => setSettingsOpen(true)}
              title={t({ en: 'Configure LLM provider / API key', zh: '配置 LLM 服务商 / API 密钥' })}
            >
              {t({ en: '⚙ provider', zh: '⚙ 服务商' })}
            </button>
            {canOpenInUE && (
              <button
                className="btn-text"
                onClick={onOpenInUE}
                title={t({
                  en: 'Open this Blueprint in the UE editor (focuses an existing tab if already open)',
                  zh: '在 UE 编辑器中打开此蓝图（已打开则切到已有标签）',
                })}
              >
                {t({ en: '↗ Open in UE', zh: '↗ 在 UE 中打开' })}
              </button>
            )}
            {/*
              Lv4 entry — concentric BFS view of cross-BP call relationships.
              Always shown.  The frontmatter `edges:` block only carries
              OUTBOUND edges, so gating on its presence used to hide the
              button on assets that are pure callees — interfaces (BPI_*),
              query contexts (EQC_*), anim blueprints (ABP_*), libraries
              (BPF_*) — exactly the assets where inbound ("谁调我") is
              most valuable.  Lv4 itself handles empty-state per direction.
              Reads from the existing backend /api/v1/calltrace endpoint
              (HTTP only — no bridge dependency).
            */}
            <button
              className="btn-text"
              onClick={() => navigate(
                { level: 'lv4', relativePath, systemId: activeSystemId },
                t({ en: 'Call trace', zh: '调用链' }),
              )}
              title={t({
                en: 'Open the cross-blueprint call trace (concentric BFS; toggle outbound / inbound)',
                zh: '打开跨蓝图调用链（同心环 BFS；可切出向 / 入向）',
              })}
            >
              {t({ en: '⊙ Call trace', zh: '⊙ 调用链' })}
            </button>
          </div>
        </div>
        {openState.kind === 'error' && (
          <div className="settings-status settings-status-error" style={{ marginTop: 8 }}>
            {openState.message}
          </div>
        )}
        {deepState.kind === 'error' && (
          <div className="settings-status settings-status-error" style={{ marginTop: 8 }}>
            {deepState.message}
          </div>
        )}
        {deepState.kind === 'done' && (
          <div className="settings-status" style={{ marginTop: 8 }}>
            <strong>{t({ en: 'Analysis updated.', zh: '分析已更新。' })}</strong>{' '}
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {t({ en: 'tokens in/out/thinking:', zh: 'token 输入/输出/思考：' })} {deepState.result.tokens_in} / {deepState.result.tokens_out} / {deepState.result.thinking_tokens}
              {deepState.result.parse_ok ? '' : t({ en: ' · METADATA block could not be parsed (defaulted)', zh: ' · METADATA 块解析失败（已使用默认值）' })}
            </span>
          </div>
        )}
        {fm.intent && <p className="bp-focus-intent">{fm.intent as string}</p>}
        {tags.length > 0 && (
          <div className="bp-focus-tags">
            {tags.map((t) => <span key={t} className={`tag tag-${tagAxis(t)}`}>#{t}</span>)}
          </div>
        )}
      </div>

      <div className="bp-focus-body">
        <div className="bp-focus-narrative">
          <MiniMarkdown source={file.aiSection} onLinkClick={onLinkClick} />
        </div>

        <NotesEditor relativePath={relativePath} initial={file.notes} />

        {fns.length + events.length + dispatchers.length > 0 && (
          <section className="bp-focus-section">
            <h3>{t({ en: 'Exports', zh: '导出' })}</h3>
            <div className="exports-grid">
              {fns.length > 0 && (
                <div className="export-col">
                  <div className="export-header">{t({ en: 'Functions', zh: '函数' })} <span className="muted">({fns.length})</span></div>
                  <ul className="export-list">
                    {fns.map((fn) => (
                      <li key={fn}>
                        <button
                          className="fn-link"
                          title={t({ en: 'Open function-level flow (Lv3)', zh: '打开函数级流程图 (Lv3)' })}
                          onClick={() => navigate({ level: 'lv3', relativePath, functionId: fn }, fn)}
                        >
                          {fn}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {events.length > 0 && (
                <div className="export-col">
                  <div className="export-header">{t({ en: 'Events', zh: '事件' })} <span className="muted">({events.length})</span></div>
                  <ul className="export-list">
                    {events.map((ev) => <li key={ev}>{ev}</li>)}
                  </ul>
                </div>
              )}
              {dispatchers.length > 0 && (
                <div className="export-col">
                  <div className="export-header">{t({ en: 'Dispatchers', zh: '事件分发器' })} <span className="muted">({dispatchers.length})</span></div>
                  <ul className="export-list">
                    {dispatchers.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        {variables.length > 0 && (
          <section className="bp-focus-section">
            <h3>{t({ en: 'Variables', zh: '变量' })}</h3>
            <table className="vars-table">
              <thead><tr>
                <th>{t({ en: 'Name', zh: '名称' })}</th>
                <th>{t({ en: 'Type', zh: '类型' })}</th>
                <th>{t({ en: 'Default', zh: '默认值' })}</th>
              </tr></thead>
              <tbody>
                {variables.map((v, i) => (
                  <tr key={i}>
                    <td>{(v.name as string) ?? '?'}</td>
                    <td className="muted">{(v.type as string) ?? ''}</td>
                    <td className="muted">{stringify(v.default)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <ClassDependenciesSection deps={fm.class_dependencies} titleToPath={titleToPath} navigate={navigate} />
        <EdgesSection title={t({ en: 'Outgoing', zh: '出向引用' })} edges={fm.edges} kind="out" titleToPath={titleToPath} navigate={navigate} />
        <BacklinksSection raw={file.raw} titleToPath={titleToPath} navigate={navigate} />
      </div>
    </div>
  );
};

const Pill: React.FC<{ kind: string; children: React.ReactNode }> = ({ kind, children }) => (
  <span className={`pill pill-${kind}`}>{children}</span>
);

const EdgesSection: React.FC<{
  title: string;
  edges: Record<string, VaultEdge[]> | undefined;
  kind: 'out' | 'in';
  titleToPath: Record<string, string>;
  navigate: (loc: any, t?: string) => void;
}> = ({ title, edges, kind, titleToPath, navigate }) => {
  if (!edges || Object.keys(edges).length === 0) return null;
  return (
    <section className="bp-focus-section">
      <h3>{title}</h3>
      {Object.entries(edges).map(([type, list]) => {
        const arr = Array.isArray(list) ? (list as VaultEdge[]) : [];
        if (arr.length === 0) return null;
        return (
        <div key={type} className="edge-group">
          <div className="edge-type">{type}</div>
          <ul className="edge-list">
            {arr.map((e, i) => (
              <li key={i}>
                <button
                  className="edge-target"
                  onClick={() => {
                    const p = titleToPath[e.target];
                    if (p) navigate({ level: 'lv2', relativePath: p }, e.target);
                  }}
                >
                  {e.target}
                </button>
                {e.label && <span className="edge-label muted"> — {e.label}</span>}
                {e.refs && e.refs.length > 0 && (
                  <span className="edge-refs muted"> ({e.refs.join(', ')})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        );
      })}
    </section>
  );
};

// Class dependencies — surfaces the bridge's reflection-walk hard/soft/interface
// refs that vault_writer.py persists into `frontmatter.class_dependencies`
// (§21.5 / Phase B §22.5 #4).  Especially load-bearing for DT / DataAsset
// nodes which have no `edges` block (no UEdGraph → no outbound function calls)
// — without this section the user sees a Lv2 page with no dependency info at
// all even though the bridge already fingerprinted what the data table refs.
const ClassDependenciesSection: React.FC<{
  deps: unknown;
  titleToPath: Record<string, string>;
  navigate: (loc: any, t?: string) => void;
}> = ({ deps, titleToPath, navigate }) => {
  const t = useT();
  if (!deps || typeof deps !== 'object') return null;
  const d = deps as Record<string, unknown>;
  const groups: Array<{ key: string; label: string; refs: string[] }> = [];
  for (const [key, label] of [
    ['hard_refs', t({ en: 'Hard refs', zh: '硬引用' })],
    ['soft_refs', t({ en: 'Soft refs', zh: '软引用' })],
    ['interfaces', t({ en: 'Interfaces', zh: '接口' })],
  ] as const) {
    const v = d[key];
    if (Array.isArray(v) && v.length > 0) {
      groups.push({ key, label, refs: v.map((x) => String(x)) });
    }
  }
  if (groups.length === 0) return null;
  return (
    <section className="bp-focus-section">
      <h3>
        {t({ en: 'Class dependencies', zh: '类依赖' })}{' '}
        <span className="muted" style={{ fontSize: 'var(--fs-xs)', fontWeight: 400 }}>
          {t({
            en: '— from AssetRegistry reflection walk',
            zh: '— 来自 AssetRegistry 反射',
          })}
        </span>
      </h3>
      {groups.map((g) => (
        <div key={g.key} className="edge-group">
          <div className="edge-type">
            {g.label} <span className="muted">({g.refs.length})</span>
          </div>
          <ul className="edge-list">
            {g.refs.map((ref, i) => {
              // Extract the trailing asset name from a /Game/... package path
              // so we can attempt a vault-link resolution.  Falls back to the
              // raw string for non-/Game/ refs (engine classes, plugin
              // classes, native interfaces).
              const segs = ref.split('/');
              const last = segs[segs.length - 1] ?? ref;
              // Some refs end as `Class'/Game/...'`, some as `BP_Foo.BP_Foo`,
              // some as just `BP_Foo`.  Strip the duplicated suffix and any
              // wrapping quotes.
              const cleanName = last.split('.').pop()?.replace(/['"]/g, '') ?? last;
              const targetPath = titleToPath[cleanName];
              const prefix = ref.startsWith('/') && segs.length > 1
                ? segs.slice(0, -1).join('/') + '/'
                : '';
              return (
                <li key={i}>
                  {targetPath ? (
                    <button
                      className="edge-target"
                      onClick={() => navigate({ level: 'lv2', relativePath: targetPath }, cleanName)}
                      title={ref}
                    >
                      {cleanName}
                    </button>
                  ) : (
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{cleanName}</span>
                  )}
                  {prefix && (
                    <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}> · {prefix}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
};

// Backlinks are written into the file as a fenced block by the backend; we
// extract them by finding the BACKLINKS region or a `## Backlinks` heading.
const BacklinksSection: React.FC<{
  raw: string;
  titleToPath: Record<string, string>;
  navigate: (loc: any, t?: string) => void;
}> = ({ raw, titleToPath, navigate }) => {
  const t = useT();
  const links = useMemo(() => extractBacklinks(raw), [raw]);
  if (links.length === 0) return null;
  return (
    <section className="bp-focus-section">
      <h3>{t({ en: 'Backlinks', zh: '反向链接' })} <span className="muted">({links.length})</span></h3>
      <ul className="backlinks-list">
        {links.map((l, i) => (
          <li key={i}>
            <button
              className="backlink"
              onClick={() => {
                const p = titleToPath[l.title] ?? l.relativePath;
                if (p) navigate({ level: 'lv2', relativePath: p }, l.title);
              }}
            >
              {l.title}
            </button>
            {l.note && <span className="muted"> — {l.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};

function extractBacklinks(raw: string): Array<{ title: string; relativePath?: string; note?: string }> {
  const startIdx = raw.indexOf('<!-- backlinks-start');
  const endIdx = raw.indexOf('<!-- backlinks-end');
  if (startIdx < 0 || endIdx < 0) return [];
  const region = raw.slice(startIdx, endIdx);
  const out: Array<{ title: string; relativePath?: string; note?: string }> = [];
  // Match patterns like `- [[Title]]` or `- [Title](path)` or `- Title — note`
  const re = /^-\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\))(?:\s*[—-]\s*(.*))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    if (m[1]) out.push({ title: m[1], note: m[4] });
    else out.push({ title: m[2], relativePath: m[3], note: m[4] });
  }
  return out;
}

function tagAxis(tagRaw: string): string {
  const tag = tagRaw.startsWith('#') ? tagRaw.slice(1) : tagRaw;
  if (tag.startsWith('system/')) return 'system';
  if (tag.startsWith('layer/')) return 'layer';
  if (tag.startsWith('role/')) return 'role';
  return 'other';
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
