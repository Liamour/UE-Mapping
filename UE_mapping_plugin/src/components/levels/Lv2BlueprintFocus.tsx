import React, { useEffect, useMemo, useState } from 'react';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { MiniMarkdown } from '../../utils/miniMarkdown';
import type { VaultEdge } from '../../utils/frontmatter';
import { NotesEditor } from '../notes/NotesEditor';

interface Props {
  relativePath: string;
}

export const Lv2BlueprintFocus: React.FC<Props> = ({ relativePath }) => {
  const file = useVaultStore((s) => s.fileCache[relativePath]);
  const loadFile = useVaultStore((s) => s.loadFile);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const navigate = useTabsStore((s) => s.navigateActive);

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

  if (!file) {
    return <div className="empty-state"><p>Loading note…</p></div>;
  }

  const fm = file.frontmatter;
  const tags = (fm.tags ?? []) as string[];
  const fns = (fm.exports_functions ?? []) as string[];
  const events = (fm.exports_events ?? []) as string[];
  const dispatchers = (fm.exports_dispatchers ?? []) as string[];
  const variables = (fm.variables ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="bp-focus">
      <div className="bp-focus-header">
        <div className="bp-focus-titlebar">
          <h1 className="bp-focus-title">{(fm.title as string) ?? relativePath}</h1>
          <div className="bp-focus-meta">
            <Pill kind="type">{(fm.node_type as string) ?? 'Blueprint'}</Pill>
            {fm.parent_class && <Pill kind="parent">extends {fm.parent_class as string}</Pill>}
            <Pill kind={`risk-${(fm.risk_level as string) ?? 'nominal'}`}>{(fm.risk_level as string) ?? 'nominal'}</Pill>
          </div>
        </div>
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
            <h3>Exports</h3>
            <div className="exports-grid">
              {fns.length > 0 && (
                <div className="export-col">
                  <div className="export-header">Functions <span className="muted">({fns.length})</span></div>
                  <ul className="export-list">
                    {fns.map((fn) => (
                      <li key={fn}>
                        <button
                          className="fn-link"
                          title="Open function-level flow (Lv3)"
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
                  <div className="export-header">Events <span className="muted">({events.length})</span></div>
                  <ul className="export-list">
                    {events.map((ev) => <li key={ev}>{ev}</li>)}
                  </ul>
                </div>
              )}
              {dispatchers.length > 0 && (
                <div className="export-col">
                  <div className="export-header">Dispatchers <span className="muted">({dispatchers.length})</span></div>
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
            <h3>Variables</h3>
            <table className="vars-table">
              <thead><tr><th>Name</th><th>Type</th><th>Default</th></tr></thead>
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

        <EdgesSection title="Outgoing" edges={fm.edges} kind="out" titleToPath={titleToPath} navigate={navigate} />
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

// Backlinks are written into the file as a fenced block by the backend; we
// extract them by finding the BACKLINKS region or a `## Backlinks` heading.
const BacklinksSection: React.FC<{
  raw: string;
  titleToPath: Record<string, string>;
  navigate: (loc: any, t?: string) => void;
}> = ({ raw, titleToPath, navigate }) => {
  const links = useMemo(() => extractBacklinks(raw), [raw]);
  if (links.length === 0) return null;
  return (
    <section className="bp-focus-section">
      <h3>Backlinks <span className="muted">({links.length})</span></h3>
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
