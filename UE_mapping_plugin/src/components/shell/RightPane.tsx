import React, { useState } from 'react';
import { useTabsStore } from '../../store/useTabsStore';
import { useVaultStore } from '../../store/useVaultStore';
import { AIChat } from '../chat/AIChat';
import { useT } from '../../utils/i18n';

export const RightPane: React.FC = () => {
  const t = useT();
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
        >{t({ en: 'Metadata', zh: '元数据' })}</button>
        <button
          className={`rp-tab ${tab === 'chat' ? 'rp-tab-active' : ''}`}
          onClick={() => setTab('chat')}
        >{t({ en: 'AI Chat', zh: 'AI 对话' })}</button>
      </div>
      <div className="rightpane-body">
        {tab === 'meta' && <MetadataPanel file={file} />}
        {tab === 'chat' && <AIChat />}
      </div>
    </aside>
  );
};

const MetadataPanel: React.FC<{ file: ReturnType<typeof useVaultStore.getState>['fileCache'][string] | undefined }> = ({ file }) => {
  const t = useT();
  if (!file) {
    return (
      <div className="rightpane-empty muted">
        <p>{t({ en: 'Select a node to view its metadata.', zh: '选中一个节点以查看元数据。' })}</p>
      </div>
    );
  }
  const fm = file.frontmatter;
  const tags = (fm.tags ?? []) as string[];
  return (
    <div className="meta-panel">
      <Field label={t({ en: 'Title', zh: '标题' })} value={(fm.title as string) ?? '—'} />
      <Field label={t({ en: 'Type', zh: '类型' })} value={(fm.node_type as string) ?? '—'} />
      <Field label={t({ en: 'Parent', zh: '父类' })} value={(fm.parent_class as string) ?? '—'} />
      <Field label={t({ en: 'Asset path', zh: '资产路径' })} value={(fm.asset_path as string) ?? '—'} mono />
      <Field label={t({ en: 'Risk level', zh: '风险等级' })} value={(fm.risk_level as string) ?? 'nominal'} />
      <Field label={t({ en: 'Last scan', zh: '上次扫描' })} value={(fm.scan_at as string) ?? '—'} />
      <Field label={t({ en: 'Model', zh: '模型' })} value={(fm.scan_model as string) ?? '—'} />
      <Field label={t({ en: 'AST hash', zh: 'AST 哈希' })} value={(fm.ast_hash as string) ?? '—'} mono />
      {fm.notes_review_needed && (
        <div className="meta-flag">
          <strong>{t({ en: 'Review needed:', zh: '需要复核：' })}</strong>{' '}
          {(fm.notes_review_reason as string) ?? t({ en: 'AST changed since notes last touched', zh: '自上次编辑笔记以来 AST 已变更' })}
        </div>
      )}
      {fm.intent && (
        <div className="meta-block">
          <div className="meta-block-label">{t({ en: 'Intent', zh: '意图' })}</div>
          <div className="meta-block-body">{fm.intent as string}</div>
        </div>
      )}
      {tags.length > 0 && (
        <div className="meta-block">
          <div className="meta-block-label">{t({ en: 'Tags', zh: '标签' })}</div>
          <div className="meta-tags">
            {tags.map((tag) => <span key={tag} className={`tag tag-${tagAxis(tag)}`}>#{tag}</span>)}
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
