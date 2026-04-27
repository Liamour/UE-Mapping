import React, { useEffect, useState } from 'react';
import { writeVaultNotes } from '../../services/vaultApi';
import { useVaultStore } from '../../store/useVaultStore';
import { useT } from '../../utils/i18n';

interface Props {
  relativePath: string;
  initial: string;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export const NotesEditor: React.FC<Props> = ({ relativePath, initial }) => {
  const t = useT();
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const invalidateFile = useVaultStore((s) => s.invalidateFile);
  const loadFile = useVaultStore((s) => s.loadFile);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<SaveState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setState('idle');
    setEditing(false);
  }, [relativePath, initial]);

  const onSave = async () => {
    if (!projectRoot) return;
    setState('saving');
    setErrorMsg(null);
    try {
      await writeVaultNotes(projectRoot, relativePath, draft);
      invalidateFile(relativePath);
      await loadFile(relativePath);
      setState('saved');
      setEditing(false);
      setTimeout(() => setState('idle'), 1500);
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const onCancel = () => {
    setDraft(initial);
    setState('idle');
    setEditing(false);
  };

  const showEmpty = !initial.trim();

  return (
    <section className="notes-section">
      <div className="notes-section-head">
        <h3 className="notes-heading">
          {t({ en: 'Notes', zh: '笔记' })} <span className="muted">{t({ en: '— developer-owned, never overwritten', zh: '— 开发者私有，永不被覆盖' })}</span>
        </h3>
        {!editing && (
          <button className="btn-text" onClick={() => setEditing(true)}>
            {showEmpty ? t({ en: '+ Add notes', zh: '+ 添加笔记' }) : t({ en: 'Edit', zh: '编辑' })}
          </button>
        )}
        {editing && (
          <div className="notes-actions">
            <button className="btn-text" onClick={onCancel} disabled={state === 'saving'}>
              {t({ en: 'Cancel', zh: '取消' })}
            </button>
            <button className="btn-primary" onClick={onSave} disabled={state === 'saving'}>
              {state === 'saving' ? t({ en: 'Saving…', zh: '保存中…' }) : t({ en: 'Save', zh: '保存' })}
            </button>
          </div>
        )}
      </div>
      {!editing && !showEmpty && (
        <div className="notes-display">
          <pre className="notes-pre">{initial}</pre>
        </div>
      )}
      {!editing && showEmpty && (
        <p className="notes-empty muted">
          {t({
            en: 'No notes yet. Click Add notes to write your private observations.',
            zh: '暂无笔记。点击 添加笔记 记录你的私人观察。',
          })}
        </p>
      )}
      {editing && (
        <textarea
          className="notes-textarea"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setState('dirty');
          }}
          rows={8}
          placeholder={t({
            en: 'Write notes that travel with this blueprint. The scanner will never overwrite this section.',
            zh: '在此处写下与该蓝图相关的笔记。扫描器永远不会覆盖此段内容。',
          })}
        />
      )}
      {state === 'saved' && <div className="notes-status notes-status-ok">{t({ en: 'Saved.', zh: '已保存。' })}</div>}
      {state === 'error' && (
        <div className="notes-status notes-status-err">
          {t({ en: `Save failed: ${errorMsg}`, zh: `保存失败：${errorMsg}` })}
        </div>
      )}
    </section>
  );
};
