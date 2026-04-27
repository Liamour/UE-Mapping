import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';

export const QuickSwitcher: React.FC = () => {
  const open = useUIStore((s) => s.searchOpen);
  const close = () => useUIStore.getState().setSearchOpen(false);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const navigate = useTabsStore((s) => s.navigateActive);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    if (!query) return files.slice(0, 30);
    const q = query.toLowerCase();
    return files
      .map((f) => {
        const cached = fileCache[f.relative_path];
        const tags = (cached?.frontmatter.tags as string[]) ?? [];
        const intent = (cached?.frontmatter.intent as string) ?? '';
        let score = 0;
        if (f.title.toLowerCase().includes(q)) score += 10;
        if (intent.toLowerCase().includes(q)) score += 4;
        if (tags.some((t) => t.toLowerCase().includes(q))) score += 6;
        return { file: f, score, intent };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }, [query, files, fileCache]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  const onPick = (relativePath: string, title: string) => {
    navigate({ level: 'lv2', relativePath }, title);
    close();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="quickswitcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qs-input"
          placeholder="Find file by title, tag, or intent…"
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
              const r = ('file' in (results[cursor] ?? {})) ? (results[cursor] as any).file : results[cursor];
              if (r) onPick(r.relative_path, r.title);
            }
          }}
        />
        <ul className="qs-results">
          {results.length === 0 && (
            <li className="qs-empty muted">No matches</li>
          )}
          {results.map((r, i) => {
            const file = ('file' in r) ? (r as any).file : r;
            const intent = ('intent' in r) ? (r as any).intent : '';
            return (
              <li
                key={file.relative_path}
                className={`qs-row ${i === cursor ? 'qs-row-active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(file.relative_path, file.title)}
              >
                <div className="qs-row-title">{file.title}</div>
                <div className="qs-row-sub muted">{file.subdir} {intent ? `· ${intent.slice(0, 80)}` : ''}</div>
              </li>
            );
          })}
        </ul>
        <div className="qs-footer muted">
          <span>↑↓ navigate · ↵ open · Esc close</span>
        </div>
      </div>
    </div>
  );
};
