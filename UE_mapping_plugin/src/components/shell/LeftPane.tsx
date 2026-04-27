import React, { useEffect, useMemo, useState } from 'react';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { summarize, groupBySystem, nodeColor } from '../../utils/vaultIndex';
import { useT } from '../../utils/i18n';

export const LeftPane: React.FC = () => {
  const t = useT();
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const loadFile = useVaultStore((s) => s.loadFile);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const loading = useVaultStore((s) => s.loading);
  const error = useVaultStore((s) => s.error);

  const navigate = useTabsStore((s) => s.navigateActive);
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));

  const [filter, setFilter] = useState('');
  const [groupMode, setGroupMode] = useState<'system' | 'type'>('system');

  // Fire-and-forget: warm cache for files in the listing so frontmatter-driven grouping works.
  useEffect(() => {
    if (files.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (cancelled) return;
        if (!fileCache[f.relative_path]) {
          await loadFile(f.relative_path);
        }
      }
    })();
    return () => { cancelled = true; };
    // we deliberately don't depend on fileCache: that'd thrash
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const summaries = useMemo(() => {
    return files.map((f) => summarize(f, fileCache[f.relative_path]));
  }, [files, fileCache]);

  const filtered = useMemo(() => {
    if (!filter) return summaries;
    const q = filter.toLowerCase();
    return summaries.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.systems.some((sys) => sys.toLowerCase().includes(q)) ||
      (s.intent ?? '').toLowerCase().includes(q)
    );
  }, [summaries, filter]);

  const onPick = (relativePath: string, title: string) => {
    navigate(
      { level: 'lv2', relativePath, systemId: activeTab?.location.systemId },
      title,
    );
  };

  if (!projectRoot) {
    return (
      <aside className="leftpane">
        <div className="leftpane-empty">
          <p>{t({ en: 'No vault loaded.', zh: '未加载 vault。' })}</p>
          <p className="muted" dangerouslySetInnerHTML={{
            __html: t({
              en: 'Set a project root in <strong>Settings</strong>.',
              zh: '请在<strong>设置</strong>中配置项目根目录。',
            }),
          }} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="leftpane">
      <div className="leftpane-header">
        <input
          type="text"
          className="leftpane-search"
          placeholder={t({ en: 'Filter…', zh: '筛选…' })}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="leftpane-mode">
          <button
            className={`mode-btn ${groupMode === 'system' ? 'mode-btn-active' : ''}`}
            onClick={() => setGroupMode('system')}
          >{t({ en: 'Systems', zh: '系统' })}</button>
          <button
            className={`mode-btn ${groupMode === 'type' ? 'mode-btn-active' : ''}`}
            onClick={() => setGroupMode('type')}
          >{t({ en: 'Types', zh: '类型' })}</button>
        </div>
      </div>

      {loading && <div className="leftpane-status">{t({ en: 'Loading…', zh: '加载中…' })}</div>}
      {error && <div className="leftpane-status leftpane-error">{error}</div>}
      {!loading && !error && summaries.length === 0 && (
        <div className="leftpane-empty">
          <p>{t({ en: 'Vault is empty.', zh: 'Vault 为空。' })}</p>
          <p className="muted">{t({ en: 'Run a scan from UE to populate notes.', zh: '在 UE 中运行扫描以生成笔记。' })}</p>
        </div>
      )}

      <div className="leftpane-tree">
        {groupMode === 'system' && groupBySystem(filtered).map((bucket) => (
          <SystemGroup
            key={bucket.systemId}
            systemId={bucket.systemId}
            count={bucket.count}
            children={bucket.nodes.map((n) => (
              <NodeRow
                key={n.relativePath}
                title={n.title}
                nodeType={n.nodeType}
                active={activeTab?.location.relativePath === n.relativePath}
                onClick={() => onPick(n.relativePath, n.title)}
              />
            ))}
          />
        ))}
        {groupMode === 'type' && groupByType(filtered).map((bucket) => (
          <TypeGroup
            key={bucket.type}
            type={bucket.type}
            count={bucket.count}
            children={bucket.nodes.map((n) => (
              <NodeRow
                key={n.relativePath}
                title={n.title}
                nodeType={n.nodeType}
                active={activeTab?.location.relativePath === n.relativePath}
                onClick={() => onPick(n.relativePath, n.title)}
              />
            ))}
          />
        ))}
      </div>
    </aside>
  );
};

const SystemGroup: React.FC<{ systemId: string; count: number; children: React.ReactNode }> = ({ systemId, count, children }) => {
  const t = useT();
  const [open, setOpen] = useState(true);
  const label = systemId === '_unassigned' ? t({ en: 'Unassigned', zh: '未归类' }) : systemId;
  return (
    <div className="tree-group">
      <button className="tree-group-header" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▼' : '▶'}</span>
        <span className="tree-group-label">{label}</span>
        <span className="tree-group-count">{count}</span>
      </button>
      {open && <div className="tree-group-body">{children}</div>}
    </div>
  );
};

const TypeGroup: React.FC<{ type: string; count: number; children: React.ReactNode }> = ({ type, count, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="tree-group">
      <button className="tree-group-header" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▼' : '▶'}</span>
        <span className="tree-group-label">{type}</span>
        <span className="tree-group-count">{count}</span>
      </button>
      {open && <div className="tree-group-body">{children}</div>}
    </div>
  );
};

const NodeRow: React.FC<{ title: string; nodeType: string; active: boolean; onClick: () => void }> = ({ title, nodeType, active, onClick }) => (
  <button className={`tree-row ${active ? 'tree-row-active' : ''}`} onClick={onClick}>
    <span className="tree-row-dot" style={{ background: nodeColor(nodeType) }} />
    <span className="tree-row-title">{title}</span>
  </button>
);

function groupByType(nodes: ReturnType<typeof summarize>[]): Array<{ type: string; count: number; nodes: typeof nodes }> {
  const map = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const arr = map.get(n.nodeType) ?? [];
    arr.push(n);
    map.set(n.nodeType, arr);
  }
  return Array.from(map.entries())
    .map(([type, nodes]) => ({ type, count: nodes.length, nodes }))
    .sort((a, b) => b.count - a.count);
}
