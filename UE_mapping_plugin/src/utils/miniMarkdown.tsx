import React from 'react';

// Tiny markdown renderer — handles what AI-generated vault notes use:
// h1-h4, paragraphs, ul/ol, inline code, fenced code, bold/italic, internal
// links `[[Title]]` and external links `[txt](url)`. Not for arbitrary user
// markdown; we only parse our own content shape.

interface Props {
  source: string;
  onLinkClick?: (target: string) => void;
}

export const MiniMarkdown: React.FC<Props> = ({ source, onLinkClick }) => {
  const blocks = parseBlocks(source);
  return (
    <div className="prose-mini">
      {blocks.map((b, idx) => renderBlock(b, idx, onLinkClick))}
    </div>
  );
};

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'hr' }
  | { type: 'blank' };

function parseBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push({ type: 'hr' });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const ordered = !!olMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(/^[\s]*\d+\.\s+(.+)$/) : lines[i].match(/^[\s]*[-*]\s+(.+)$/);
        if (!m) break;
        items.push(m[1].trim());
        i++;
      }
      out.push({ type: 'list', ordered, items });
      continue;
    }
    // accumulate paragraph until blank line
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|---+|```)/.test(lines[i].trim()) && !/^[\s]*([-*]|\d+\.)\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ type: 'paragraph', text: para.join(' ') });
  }
  return out;
}

function renderBlock(b: Block, key: number, onLinkClick?: (target: string) => void): React.ReactNode {
  if (b.type === 'heading') {
    const Tag = (`h${b.level}` as keyof React.JSX.IntrinsicElements);
    return React.createElement(Tag, { key, className: `md-h md-h${b.level}` }, renderInline(b.text, onLinkClick));
  }
  if (b.type === 'paragraph') {
    return <p key={key} className="md-p">{renderInline(b.text, onLinkClick)}</p>;
  }
  if (b.type === 'code') {
    return (
      <pre key={key} className="md-pre"><code className={`md-code lang-${b.lang}`}>{b.text}</code></pre>
    );
  }
  if (b.type === 'list') {
    if (b.ordered) {
      return (
        <ol key={key} className="md-ol">
          {b.items.map((it, i2) => <li key={i2}>{renderInline(it, onLinkClick)}</li>)}
        </ol>
      );
    }
    return (
      <ul key={key} className="md-ul">
        {b.items.map((it, i2) => <li key={i2}>{renderInline(it, onLinkClick)}</li>)}
      </ul>
    );
  }
  if (b.type === 'hr') return <hr key={key} className="md-hr" />;
  return null;
}

function renderInline(text: string, onLinkClick?: (target: string) => void): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const re = /(\[\[([^\]]+)\]\])|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    if (m[1]) {
      const target = m[2];
      parts.push(
        <a
          key={`l${n++}`}
          className="md-internal-link"
          onClick={(e) => {
            e.preventDefault();
            onLinkClick?.(target);
          }}
          href="#"
        >
          {target}
        </a>
      );
    } else if (m[3]) {
      parts.push(<a key={`x${n++}`} className="md-external-link" href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
    } else if (m[6]) {
      parts.push(<code key={`c${n++}`} className="md-inline-code">{m[7]}</code>);
    } else if (m[8]) {
      parts.push(<strong key={`b${n++}`}>{m[9]}</strong>);
    } else if (m[10]) {
      parts.push(<em key={`i${n++}`}>{m[11]}</em>);
    }
    cursor = re.lastIndex;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
