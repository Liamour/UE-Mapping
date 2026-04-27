import React, { useState } from 'react';
import { useTabsStore } from '../../store/useTabsStore';
import { useVaultStore } from '../../store/useVaultStore';
import { AIChat } from '../chat/AIChat';

export const RightPane: React.FC = () => {
  const [tab, setTab] = useState<'meta' | 'chat'>('meta');
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const fileCache = useVaultStore((s) => s.fileCache);
  const file = activeTab?.location.relativePath
    ? fileCache[activeTab.location.relativePath]
    : undefined;

  return (
    <aside className="rightpane">
      <div className="rightpane-tabs">
        <button
          className={`rp-tab ${tab === 'meta' ? 'rp-tab-active' : ''}`}
          onClick={() => setTab('meta')}
        >Metadata</button>
        <button
          className={`rp-tab ${tab === 'chat' ? 'rp-tab-active' : ''}`}
          onClick={() => setTab('chat')}
        >AI Chat</button>
      </div>
      <div className="rightpane-body">
        {tab === 'meta' && <MetadataPanel file={file} />}
        {tab === 'chat' && <AIChat />}
      </div>
    </aside>
  );
};

const MetadataPanel: React.FC<{ file: ReturnType<typeof useVaultStore.getState>['fileCache'][string] | undefined }> = ({ file }) => {
  if (!file) {
    return (
      <div className="rightpane-empty muted">
        <p>Select a node to view its metadata.</p>
      </div>
    );
  }
  const fm = file.frontmatter;
  const tags = (fm.tags ?? []) as string[];
  return (
    <div className="meta-panel">
      <Field label="Title" value={(fm.title as string) ?? '—'} />
      <Field label="Type" value={(fm.node_type as string) ?? '—'} />
      <Field label="Parent" value={(fm.parent_class as string) ?? '—'} />
      <Field label="Asset path" value={(fm.asset_path as string) ?? '—'} mono />
      <Field label="Risk level" value={(fm.risk_level as string) ?? 'nominal'} />
      <Field label="Last scan" value={(fm.scan_at as string) ?? '—'} />
      <Field label="Model" value={(fm.scan_model as string) ?? '—'} />
      <Field label="AST hash" value={(fm.ast_hash as string) ?? '—'} mono />
      {fm.notes_review_needed && (
        <div className="meta-flag">
          <strong>Review needed:</strong> {(fm.notes_review_reason as string) ?? 'AST changed since notes last touched'}
        </div>
      )}
      {fm.intent && (
        <div className="meta-block">
          <div className="meta-block-label">Intent</div>
          <div className="meta-block-body">{fm.intent as string}</div>
        </div>
      )}
      {tags.length > 0 && (
        <div className="meta-block">
          <div className="meta-block-label">Tags</div>
          <div className="meta-tags">
            {tags.map((t) => <span key={t} className={`tag tag-${tagAxis(t)}`}>#{t}</span>)}
          </div>
        </div>
      )}
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="meta-field">
    <div className="meta-field-label">{label}</div>
    <div className={`meta-field-value ${mono ? 'mono' : ''}`}>{value}</div>
  </div>
);

function tagAxis(tagRaw: string): string {
  const tag = tagRaw.startsWith('#') ? tagRaw.slice(1) : tagRaw;
  if (tag.startsWith('system/')) return 'system';
  if (tag.startsWith('layer/')) return 'layer';
  if (tag.startsWith('role/')) return 'role';
  return 'other';
}
