import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useVaultStore } from '../../store/useVaultStore';
import { rebuildBacklinks, checkBackendHealth, exportVault, downloadJSON, type VaultExportScope } from '../../services/vaultApi';
import { getBridgeStatus, getCandidateGlobals, isBridgeAvailable, isDeepScanAvailable, isVaultFileWriteAvailable } from '../../services/bridgeApi';
import { rebuildSystemMOCs } from '../../services/mocGenerator';
import { ScanOrchestrator } from './ScanOrchestrator';
import { FrameworkScanPanel } from './FrameworkScanPanel';
import { LLMProviderPanel } from './LLMProviderPanel';
import { useT, useLang } from '../../utils/i18n';

export const SettingsModal: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const open = useUIStore((s) => s.settingsOpen);
  const close = () => useUIStore.getState().setSettingsOpen(false);
  const projectRoot = useVaultStore((s) => s.projectRoot);
  const setProjectRoot = useVaultStore((s) => s.setProjectRoot);
  const loadIndex = useVaultStore((s) => s.loadIndex);

  const [draft, setDraft] = useState(projectRoot);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Backend-only ops (Ping, Rebuild backlinks) are hidden when the C++ bridge
  // is providing vault FS — those features still need the Python backend.
  const onBridge = isBridgeAvailable();

  React.useEffect(() => {
    if (open) {
      setDraft(projectRoot);
      setStatus(null);
    }
  }, [open, projectRoot]);

  if (!open) return null;

  const onSave = async () => {
    setBusy(true);
    setStatus(null);
    setProjectRoot(draft.trim());
    try {
      await loadIndex();
      setStatus(t({ en: 'Vault loaded.', zh: 'Vault 加载完成。' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(t({ en: `Load failed: ${msg}`, zh: `加载失败：${msg}` }));
    } finally {
      setBusy(false);
    }
  };

  const onRebuild = async () => {
    if (!projectRoot) return;
    setBusy(true);
    setStatus(null);
    try {
      await rebuildBacklinks(projectRoot, lang);
      await loadIndex();
      setStatus(t({ en: 'Backlinks rebuilt.', zh: '反向链接已重建。' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(t({ en: `Rebuild failed: ${msg}`, zh: `重建失败：${msg}` }));
    } finally {
      setBusy(false);
    }
  };

  const onPing = async () => {
    setBusy(true);
    setStatus(null);
    const h = await checkBackendHealth();
    if (!h) {
      setStatus(t({ en: 'Backend unreachable on http://localhost:8000', zh: '无法连接到 http://localhost:8000 后端' }));
    } else {
      setStatus(t({
        en: `Backend ${h.version} — Redis: ${h.redis_available ? 'available' : 'offline'}`,
        zh: `后端 ${h.version} — Redis：${h.redis_available ? '已连接' : '离线'}`,
      }));
    }
    setBusy(false);
  };

  const onExport = async (scope: VaultExportScope) => {
    if (!projectRoot) return;
    setBusy(true);
    setStatus(t({ en: 'Exporting...', zh: '正在导出…' }));
    try {
      const data = await exportVault(projectRoot, scope, (done, total) => {
        setStatus(t({
          en: `Exporting ${done}/${total}...`,
          zh: `正在导出 ${done}/${total}…`,
        }));
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const projName = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
      const filename = `aicartographer-${projName}-${scope}-${stamp}.json`;
      downloadJSON(filename, data);
      setStatus(t({
        en: `Exported ${data.counts.systems} system(s) + ${data.counts.blueprints} blueprint(s) → ${filename}`,
        zh: `已导出 ${data.counts.systems} 个系统 + ${data.counts.blueprints} 个蓝图 → ${filename}`,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(t({ en: `Export failed: ${msg}`, zh: `导出失败：${msg}` }));
    } finally {
      setBusy(false);
    }
  };

  const onRebuildMOCs = async () => {
    if (!projectRoot) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await rebuildSystemMOCs(projectRoot);
      const summary = result.systems.length === 0
        ? t({ en: 'No system tags found — nothing to write.', zh: '未找到任何 system 标签，无需写入。' })
        : t({
            en: `Wrote ${result.systems.length} MOC(s): ${result.systems.map((s) => `${s.systemId} (${s.entryCount})`).join(', ')}`,
            zh: `已写入 ${result.systems.length} 个 MOC：${result.systems.map((s) => `${s.systemId} (${s.entryCount})`).join('、')}`,
          });
      const tail = result.unassignedCount > 0
        ? t({
            en: ` · ${result.unassignedCount} unassigned node(s) skipped.`,
            zh: ` · 跳过 ${result.unassignedCount} 个未归类节点。`,
          })
        : '';
      setStatus(summary + tail);
      await loadIndex();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(t({ en: `MOC rebuild failed: ${msg}`, zh: `MOC 重建失败：${msg}` }));
    } finally {
      setBusy(false);
    }
  };

  const mocAvailable = isVaultFileWriteAvailable();
  const scanAvailable = isDeepScanAvailable() && !!projectRoot;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t({ en: 'Settings', zh: '设置' })}</h2>
          <button className="iconbtn" onClick={close}>×</button>
        </div>
        <div className="modal-body">
          <section className="settings-section">
            <h3>{t({ en: 'Project root', zh: '项目根目录' })}</h3>
            <p className="muted" dangerouslySetInnerHTML={{
              __html: t({
                en: 'Absolute path to your UE project (the folder that contains <code>.aicartographer/vault</code>).',
                zh: 'UE 项目的绝对路径（包含 <code>.aicartographer/vault</code> 的文件夹）。',
              }),
            }} />
            <input
              className="settings-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t({ en: 'e.g. D:/MyGame', zh: '例如 D:/MyGame' })}
            />
            <div className="settings-actions">
              <button className="btn-primary" onClick={onSave} disabled={busy}>
                {t({ en: 'Save & load vault', zh: '保存并加载 vault' })}
              </button>
              {!onBridge && (
                <>
                  <button className="btn-text" onClick={onPing} disabled={busy}>
                    {t({ en: 'Ping backend', zh: '探测后端' })}
                  </button>
                  <button className="btn-text" onClick={onRebuild} disabled={busy || !projectRoot}>
                    {t({ en: 'Rebuild backlinks', zh: '重建反向链接' })}
                  </button>
                </>
              )}
              {mocAvailable && (
                <button
                  className="btn-text"
                  onClick={onRebuildMOCs}
                  disabled={busy || !projectRoot}
                  title={t({
                    en: 'Aggregate every node by `system/X` tag into _systems/X.md',
                    zh: '按 `system/X` 标签将所有节点聚合到 _systems/X.md',
                  })}
                >{t({ en: 'Rebuild MOCs', zh: '重建 MOC' })}</button>
              )}
            </div>
            {onBridge && (
              <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 8 }}>
                {t({
                  en: 'Backend operations (ping, rebuild backlinks, LLM scan) hidden in bridge mode. Start the Python backend to access them — they will reappear automatically.',
                  zh: '桥接模式下后端相关操作（探测、重建反向链接、LLM 扫描）被隐藏。启动 Python 后端后会自动恢复。',
                })}
              </p>
            )}
            {status && <div className="settings-status">{status}</div>}
          </section>
          {projectRoot && (
            <section className="settings-section">
              <h3>{t({ en: 'Export vault as JSON', zh: '导出 vault 为 JSON' })}</h3>
              <p className="muted" dangerouslySetInnerHTML={{
                __html: t({
                  en: 'Bundle every node\'s frontmatter + body into a single JSON file. Hand it to any external LLM (ChatGPT web, Claude.ai, local model) to ask questions about the project without spending API tokens. <strong>L1</strong> = system overviews only; <strong>L2</strong> = per-blueprint details only; <strong>All</strong> = both.',
                  zh: '把每个节点的 frontmatter + 正文打包成一个 JSON 文件。可以把它丢给任何外部 LLM（ChatGPT 网页版、Claude.ai、本地模型）提问，不消耗 API token。<strong>L1</strong> = 仅系统总览；<strong>L2</strong> = 仅蓝图详情；<strong>全部</strong> = 两者都包含。',
                }),
              }} />
              <div className="settings-actions">
                <button className="btn-text" onClick={() => onExport('all')} disabled={busy}>
                  {t({ en: 'Export all', zh: '导出全部' })}
                </button>
                <button className="btn-text" onClick={() => onExport('l1')} disabled={busy}>
                  {t({ en: 'Export L1 only', zh: '仅 L1' })}
                </button>
                <button className="btn-text" onClick={() => onExport('l2')} disabled={busy}>
                  {t({ en: 'Export L2 only', zh: '仅 L2' })}
                </button>
              </div>
            </section>
          )}
          {scanAvailable && (
            <section className="settings-section">
              <h3>{t({ en: 'Framework scan', zh: '框架扫描' })} <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--fs-xs)' }}>{t({ en: '(no LLM)', zh: '（不调用 LLM）' })}</span></h3>
              <p className="muted" dangerouslySetInnerHTML={{
                __html: t({
                  en: 'Walks every Blueprint under <code>/Game/</code> and writes skeleton notes containing the AST-derived functions, components, and outbound edges. Runs entirely in the editor — no backend required. After this completes the file tree and L1 graph populate immediately; you can then enrich specific nodes with the LLM scan below.',
                  zh: '遍历 <code>/Game/</code> 下所有蓝图，写入包含 AST 提取出的函数、组件、outbound 边的骨架笔记。完全在编辑器内运行——无需后端。完成后文件树和 L1 力向图立即可用，随后可用下方 LLM 扫描进一步丰富特定节点。',
                }),
              }} />
              <FrameworkScanPanel />
            </section>
          )}
          {scanAvailable && (
            <section className="settings-section">
              <h3>{t({ en: 'LLM analysis', zh: 'LLM 分析' })} <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--fs-xs)' }}>{t({ en: '(category-filtered)', zh: '（可按类别过滤）' })}</span></h3>
              <p className="muted" dangerouslySetInnerHTML={{
                __html: t({
                  en: 'Sends fingerprinted Blueprints to the Python backend\'s LLM pipeline to derive intent, tags, and risk level. Use the checkboxes to scope the run (e.g. only analyze Blueprints, skip Components and Interfaces). Requires <code>uvicorn</code> + Redis running.',
                  zh: '将带 AST 指纹的蓝图发送到 Python 后端的 LLM 流水线，提取 intent、tags 和风险等级。可用复选框缩小扫描范围（例如只分析 Blueprints，跳过 Components 和 Interfaces）。需要 <code>uvicorn</code> 和 Redis 在运行。',
                }),
              }} />
              <ScanOrchestrator />
            </section>
          )}
          <section className="settings-section">
            <h3>{t({ en: 'LLM provider', zh: 'LLM 服务商' })} <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--fs-xs)' }}>{t({ en: '(your keys, your machine)', zh: '（密钥仅存于本机）' })}</span></h3>
            <LLMProviderPanel />
          </section>
          <section className="settings-section">
            <h3>{t({ en: 'Vault transport', zh: 'Vault 传输方式' })}</h3>
            <BridgeStatusLine />
          </section>
        </div>
      </div>
    </div>
  );
};

const BridgeStatusLine: React.FC = () => {
  const t = useT();
  const status = getBridgeStatus();
  const globals = getCandidateGlobals();
  if (status.kind === 'ready') {
    return (
      <div>
        <p className="muted">
          {t({
            en: 'Connected via UE editor bridge — vault file I/O runs through the C++ plugin (no Python backend required for read/write).',
            zh: '已通过 UE 编辑器桥接 — vault 文件 I/O 由 C++ 插件处理（读写无需 Python 后端）。',
          })}
        </p>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          <code>{status.path}</code>
        </p>
        <details className="settings-debug">
          <summary>{t({ en: `Bridge methods (${status.methods.length})`, zh: `桥接方法（${status.methods.length}）` })}</summary>
          <pre className="settings-debug-pre">{status.methods.join('\n')}</pre>
        </details>
      </div>
    );
  }
  if (status.kind === 'partial') {
    return (
      <div>
        <p className="muted" dangerouslySetInnerHTML={{
          __html: t({
            en: '<strong>UE editor bridge present but vault FS methods are missing.</strong> The C++ plugin binary is out of date — Live Coding cannot register new <code>UFUNCTION</code>s. Close UE, rebuild the AICartographer module from VS / Rider, then relaunch the editor.',
            zh: '<strong>UE 编辑器桥接已连接，但 vault FS 方法缺失。</strong>C++ 插件二进制已过期 — Live Coding 无法注册新的 <code>UFUNCTION</code>。请关闭 UE，从 VS / Rider 重新编译 AICartographer 模块后再启动编辑器。',
          }),
        }} />
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {t({ en: 'Found at:', zh: '位置：' })} <code>{status.path}</code>
        </p>
        <details className="settings-debug">
          <summary>{t({ en: `Bridge methods (${status.methods.length})`, zh: `桥接方法（${status.methods.length}）` })}</summary>
          <pre className="settings-debug-pre">{status.methods.join('\n') || t({ en: '(none — binding may have failed)', zh: '（无 — 绑定可能失败）' })}</pre>
        </details>
      </div>
    );
  }
  return (
    <div>
      <p className="muted">
        {t({
          en: 'Bridge not found at any known path — using HTTP backend at localhost:8000.',
          zh: '在所有已知路径下都未找到桥接 — 使用 localhost:8000 的 HTTP 后端。',
        })}
      </p>
      <details className="settings-debug" open>
        <summary>{t({
          en: `Window globals visible to JS (${globals.length}) — paste this back so we can locate the bridge`,
          zh: `JS 可见的 window 全局变量（${globals.length}）— 把这些贴出来以便定位桥接`,
        })}</summary>
        <pre className="settings-debug-pre">{globals.join('\n') || t({ en: '(empty)', zh: '（为空）' })}</pre>
      </details>
    </div>
  );
};
