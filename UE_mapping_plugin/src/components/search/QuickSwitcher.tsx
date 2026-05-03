import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { useT } from '../../utils/i18n';

// Body snippet window: chars BEFORE the hit / chars AFTER the hit (inclusive
// of the query string).  Keeps each result row to one short line so a wide
// result list stays scannable; whitespace gets collapsed so markdown line
// breaks don't blow the layout up.
const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 60;

interface ScoredResult {
  file: { relative_path: string; title: string; subdir: string };
  score: number;
  intent: string;
  bodySnippet: string | null;
}

export const QuickSwitcher: React.FC = () => {
  const t = useT();
  const open = useUIStore((s) => s.searchOpen);
  const close = () => useUIStore.getState().setSearchOpen(false);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const manifest = useVaultStore((s) => s.manifest);
  const contentIndex = useVaultStore((s) => s.contentIndex);
  const indexAllContent = useVaultStore((s) => s.indexAllContent);
  const navigate = useTabsStore((s) => s.navigateActive);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fire the bulk content index on every open.  The store action is
  // idempotent (short-circuits if already 'ready' or 'loading'), so spamming
  // ⌘K doesn't re-load.  Done in the background — the user can search
  // metadata immediately and body matches will appear as files stream in.
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
      void indexAllContent();
    }
  }, [open, indexAllContent]);

  const results: ScoredResult[] = useMemo(() => {
    if (!query) {
      // Empty query — just list the first 30 files.  No scoring; same as
      // before.  Map into the unified shape so the render path stays simple.
      return files.slice(0, 30).map((f) => ({
        file: f, score: 0, intent: '', bodySnippet: null,
      }));
    }
    const q = query.toLowerCase();

    return files
      .map<ScoredResult>((f) => {
        const cached = fileCache[f.relative_path];
        const fm = (cached?.frontmatter ?? {}) as Record<string, unknown>;
        const tags = (fm.tags as string[] | undefined) ?? [];
        const intent = (fm.intent as string | undefined) ?? '';
        const nodeType = (fm.node_type as string | undefined) ?? '';
        const parentClass = (fm.parent_class as string | undefined) ?? '';
        const exportsAll: string[] = [
          ...((fm.exports_functions as string[] | undefined) ?? []),
          ...((fm.exports_events as string[] | undefined) ?? []),
          ...((fm.exports_dispatchers as string[] | undefined) ?? []),
        ];
        // asset_path lives in manifest (cheap, always available) and also
        // in frontmatter once the file is loaded — prefer manifest so we can
        // search by /Game/... path even on un-cached files.
        const assetPath = manifest[f.relative_path]?.asset_path
          ?? (fm.asset_path as string | undefined)
          ?? '';

        let score = 0;
        if (f.title.toLowerCase().includes(q)) score += 10;
        if (f.subdir.toLowerCase().includes(q)) score += 5;
        if (nodeType.toLowerCase().includes(q)) score += 5;
        if (assetPath.toLowerCase().includes(q)) score += 4;
        if (parentClass.toLowerCase().includes(q)) score += 3;
        if (tags.some((tag) => tag.toLowerCase().includes(q))) score += 6;
        if (intent.toLowerCase().includes(q)) score += 4;
        if (exportsAll.some((e) => e.toLowerCase().includes(q))) score += 3;

        // Body / aiSection content match — last-resort scoring but the
        // primary mechanism for "find me notes that mention X".  We search
        // `body` (everything below frontmatter, including NOTES) so user
        // notes are searchable too.
        let bodySnippet: string | null = null;
        const body = cached?.body;
        if (body) {
          const bodyLower = body.toLowerCase();
          const idx = bodyLower.indexOf(q);
          if (idx !== -1) {
            score += 2;
            const start = Math.max(0, idx - SNIPPET_BEFORE);
            const end = Math.min(body.length, idx + q.length + SNIPPET_AFTER);
            const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
            bodySnippet = (start > 0 ? '…' : '') + slice + (end < body.length ? '…' : '');
          }
        }

        return { file: f, score, intent, bodySnippet };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }, [query, files, fileCache, manifest]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  const onPick = (relativePath: string, title: string) => {
    navigate({ level: 'lv2', relativePath }, title);
    close();
  };

  // Indexing footer: only show when actively loading or when fewer than the
  // full set is cached after a 'ready' transition (rare race).  Kept terse
  // so it doesn't compete with results for visual attention.
  const indexingMsg = (() => {
    if (contentIndex.status === 'loading') {
      return t({
        en: `Indexing content ${contentIndex.loadedCount}/${contentIndex.totalCount}…`,
        zh: `正在索引正文 ${contentIndex.loadedCount}/${contentIndex.totalCount}…`,
      });
    }
    return null;
  })();

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="quickswitcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qs-input"
          placeholder={t({
            en: 'Find by title, type, tag, intent, exports, asset path, or body…',
            zh: '按标题、类型、标签、intent、导出项、资源路径或正文搜索…',
          })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { close(); return; }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              const r = results[cursor];
              if (r) onPick(r.file.relative_path, r.file.title);
            }
          }}
        />
        <ul className="qs-results">
          {results.length === 0 && (
            <li className="qs-empty muted">{t({ en: 'No matches', zh: '无匹配结果' })}</li>
          )}
          {results.map((r, i) => (
            <li
              key={r.file.relative_path}
              className={`qs-row ${i === cursor ? 'qs-row-active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(r.file.relative_path, r.file.title)}
            >
              <div className="qs-row-title">{r.file.title}</div>
              <div className="qs-row-sub muted">
                {r.file.subdir}
                {r.intent ? ` · ${r.intent.slice(0, 80)}` : ''}
              </div>
              {r.bodySnippet && (
                <div
                  className="qs-row-snippet muted"
                  style={{ fontSize: 'var(--fs-xs)', fontStyle: 'italic', marginTop: 2 }}
                >
                  {r.bodySnippet}
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="qs-footer muted">
          <span>{t({ en: '↑↓ navigate · ↵ open · Esc close', zh: '↑↓ 选择 · ↵ 打开 · Esc 关闭' })}</span>
          {indexingMsg && (
            <span style={{ marginLeft: 12 }}>· {indexingMsg}</span>
          )}
        </div>
      </div>
    </div>
  );
};
