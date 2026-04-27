import React, { useEffect, useMemo } from 'react';
import { useVaultStore } from '../../store/useVaultStore';
import { useTabsStore } from '../../store/useTabsStore';
import { summarize, groupBySystem } from '../../utils/vaultIndex';

export const Lv0CardWall: React.FC = () => {
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const files = useVaultStore((s) => s.files);
  const fileCache = useVaultStore((s) => s.fileCache);
  const loadFile = useVaultStore((s) => s.loadFile);
  const loadIndex = useVaultStore((s) => s.loadIndex);
  const loading = useVaultStore((s) => s.loading);
  const error = useVaultStore((s) => s.error);

  const navigate = useTabsStore((s) => s.navigateActive);

  // Auto-load on mount when we have a project root and no files yet
  useEffect(() => {
    if (projectRoot && files.length === 0 && !loading) {
      loadIndex();
    }
  }, [projectRoot, files.length, loading, loadIndex]);

  // Warm cache so summaries have frontmatter
  useEffect(() => {
    if (!files.length) return;
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (cancelled) return;
        if (!fileCache[f.relative_path]) await loadFile(f.relative_path);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const summaries = useMemo(
    () => files.map((f) => summarize(f, fileCache[f.relative_path])),
    [files, fileCache],
  );
  const buckets = useMemo(() => groupBySystem(summaries), [summaries]);

  if (!projectRoot) {
    return (
      <div className="empty-state">
        <h2>Welcome to AICartographer</h2>
        <p className="muted">Configure a project root in <strong>Settings</strong> to begin exploring your vault.</p>
      </div>
    );
  }

  if (loading && files.length === 0) {
    return <div className="empty-state"><p>Loading vault…</p></div>;
  }
  if (error) {
    return <div className="empty-state"><p className="error">{error}</p></div>;
  }
  if (!loading && files.length === 0) {
    return (
      <div className="empty-state">
        <h2>Vault is empty</h2>
        <p className="muted">Run a scan from the UE editor to populate notes.</p>
      </div>
    );
  }

  const totals = {
    files: summaries.length,
    systems: buckets.filter((b) => b.systemId !== '_unassigned').length,
    blueprints: summaries.filter((s) => s.nodeType === 'Blueprint').length,
    cpp: summaries.filter((s) => s.nodeType === 'CPP').length,
    interfaces: summaries.filter((s) => s.nodeType === 'Interface').length,
  };

  return (
    <div className="cardwall">
      <div className="cardwall-header">
        <h1>Project overview</h1>
        <div className="cardwall-stats">
          <Stat label="Files" value={totals.files} />
          <Stat label="Systems" value={totals.systems} />
          <Stat label="Blueprints" value={totals.blueprints} />
          <Stat label="C++" value={totals.cpp} />
          <Stat label="Interfaces" value={totals.interfaces} />
        </div>
      </div>

      <div className="cardwall-grid">
        {buckets.map((b) => {
          const sample = b.nodes.slice(0, 5).map((n) => n.title);
          const elevated = b.nodes.filter((n) => n.riskLevel === 'elevated' || n.riskLevel === 'high').length;
          return (
            <button
              key={b.systemId}
              className="system-card"
              onClick={() => navigate({ level: 'lv1', systemId: b.systemId }, formatSystem(b.systemId))}
            >
              <div className="system-card-head">
                <span className="system-card-title">{formatSystem(b.systemId)}</span>
                <span className="system-card-count">{b.count}</span>
              </div>
              <ul className="system-card-sample">
                {sample.map((t, i) => <li key={i}>{t}</li>)}
                {b.count > sample.length && <li className="muted">…and {b.count - sample.length} more</li>}
              </ul>
              {elevated > 0 && (
                <div className="system-card-risk">
                  <span className="risk-dot" /> {elevated} elevated
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="stat">
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

function formatSystem(id: string): string {
  if (id === '_unassigned') return 'Unassigned';
  return id.charAt(0).toUpperCase() + id.slice(1);
}
