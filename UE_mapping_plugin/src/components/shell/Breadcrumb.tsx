import React from 'react';
import { useTabsStore, type TabLocation } from '../../store/useTabsStore';
import { useLang } from '../../utils/i18n';
import type { OutputLanguage } from '../../store/useLLMStore';

export const Breadcrumb: React.FC = () => {
  const lang = useLang();
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const navigate = useTabsStore((s) => s.navigateActive);

  if (!activeTab) return null;
  const segments = locationToSegments(activeTab.location, lang);

  return (
    <div className="breadcrumb">
      {segments.map((seg, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && <span className="breadcrumb-sep">›</span>}
          <button
            className={`breadcrumb-seg ${idx === segments.length - 1 ? 'breadcrumb-current' : ''}`}
            onClick={() => seg.target && navigate(seg.target, seg.label)}
          >
            {seg.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

function locationToSegments(
  loc: TabLocation,
  lang: OutputLanguage,
): Array<{ label: string; target?: TabLocation }> {
  const out: Array<{ label: string; target?: TabLocation }> = [];
  out.push({ label: lang === 'zh' ? '项目' : 'Project', target: { level: 'lv0' } });
  if (loc.level === 'lv0') return out;
  if (loc.systemId) {
    const unassigned = lang === 'zh' ? '未归类' : 'Unassigned';
    out.push({
      label: loc.systemId === '_unassigned' ? unassigned : loc.systemId,
      target: { level: 'lv1', systemId: loc.systemId },
    });
  }
  if (loc.level === 'lv1') return out;
  if (loc.relativePath) {
    const baseName = loc.relativePath.split('/').pop()?.replace(/\.md$/, '') ?? loc.relativePath;
    out.push({
      label: baseName,
      target: { level: 'lv2', relativePath: loc.relativePath, systemId: loc.systemId },
    });
  }
  if (loc.level === 'lv2') return out;
  if (loc.functionId) {
    out.push({ label: loc.functionId });
  }
  return out;
}
