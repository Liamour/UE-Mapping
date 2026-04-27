import React, { useEffect, useState } from 'react';
import { writeVaultNotes } from '../../services/vaultApi';
import { useVaultStore } from '../../store/useVaultStore';

interface Props {
  relativePath: string;
  initial: string;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export const NotesEditor: React.FC<Props> = ({ relativePath, initial }) => {
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
        <h3 className="notes-heading">Notes <span className="muted">— developer-owned, never overwritten</span></h3>
        {!editing && (
          <button className="btn-text" onClick={() => setEditing(true)}>
            {showEmpty ? '+ Add notes' : 'Edit'}
          </button>
        )}
        {editing && (
          <div className="notes-actions">
            <button className="btn-text" onClick={onCancel} disabled={state === 'saving'}>Cancel</button>
            <button className="btn-primary" onClick={onSave} disabled={state === 'saving'}>
              {state === 'saving' ? 'Saving…' : 'Save'}
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
        <p className="notes-empty muted">No notes yet. Click <em>Add notes</em> to write your private observations.</p>
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
          placeholder="Write notes that travel with this blueprint. The scanner will never overwrite this section."
        />
      )}
      {state === 'saved' && <div className="notes-status notes-status-ok">Saved.</div>}
      {state === 'error' && <div className="notes-status notes-status-err">Save failed: {errorMsg}</div>}
    </section>
  );
};
