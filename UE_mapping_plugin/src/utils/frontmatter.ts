// Minimal YAML-ish frontmatter parser. Backend writes a known shape, so we don't
// need a full YAML implementation — we cover scalars, sequences, and the
// nested `edges` block the backend produces.

export interface VaultEdge {
  target: string;
  refs?: string[];
  label?: string;
}

export interface VaultFrontmatter {
  // identity
  node_id?: string;
  title?: string;
  asset_path?: string;
  node_type?: string;
  parent_class?: string | null;

  // scan
  scan_at?: string;
  scan_model?: string;
  engine_version?: string;
  ast_hash?: string;
  previous_ast_hash?: string;
  notes_review_needed?: boolean;
  notes_review_reason?: string;

  // llm-derived
  intent?: string;
  risk_level?: string;
  tags?: string[];

  // ast-derived
  exports_functions?: string[];
  exports_events?: string[];
  exports_dispatchers?: string[];
  variables?: Array<Record<string, unknown>>;

  // edges, grouped by edge_type → list
  edges?: Record<string, VaultEdge[]>;

  // free-form passthrough
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[1], body: raw.slice(m[0].length) };
}

export function parseFrontmatter(raw: string): VaultFrontmatter {
  const { frontmatter } = splitFrontmatter(raw);
  if (!frontmatter) return {};
  return normalizeFrontmatter(parseYamlBlock(frontmatter));
}

// Backend writes a nested schema (`scan: {ast_hash,...}`, `exports: {functions,...}`,
// `type: Blueprint`) but consumers across the frontend grew up reading flat
// field names (`scan_at`, `exports_functions`, `node_type`). Normalize here so
// every consumer sees a single canonical shape regardless of source.
export function normalizeFrontmatter(fm: VaultFrontmatter): VaultFrontmatter {
  const out: VaultFrontmatter = { ...fm };
  const raw = fm as Record<string, unknown>;

  const scan = raw.scan;
  if (scan && typeof scan === 'object') {
    const s = scan as Record<string, unknown>;
    if (typeof s.ast_hash === 'string' && !out.ast_hash) out.ast_hash = s.ast_hash;
    if (typeof s.scanned_at === 'string' && !out.scan_at) out.scan_at = s.scanned_at;
    if (typeof s.model === 'string' && !out.scan_model) out.scan_model = s.model;
    if (typeof s.engine_version === 'string' && !out.engine_version) out.engine_version = s.engine_version;
    if (typeof s.previous_ast_hash === 'string' && !out.previous_ast_hash) out.previous_ast_hash = s.previous_ast_hash;
    if (typeof s.notes_review_needed === 'boolean' && out.notes_review_needed === undefined) out.notes_review_needed = s.notes_review_needed;
    if (typeof s.notes_review_reason === 'string' && !out.notes_review_reason) out.notes_review_reason = s.notes_review_reason;
  }

  const exportsBlock = raw.exports;
  if (exportsBlock && typeof exportsBlock === 'object') {
    const e = exportsBlock as Record<string, unknown>;
    if (Array.isArray(e.functions) && !out.exports_functions) out.exports_functions = e.functions as string[];
    if (Array.isArray(e.events) && !out.exports_events) out.exports_events = e.events as string[];
    if (Array.isArray(e.dispatchers) && !out.exports_dispatchers) out.exports_dispatchers = e.dispatchers as string[];
  }

  if (typeof raw.type === 'string' && !out.node_type) out.node_type = raw.type;
  if (typeof raw.id === 'string' && !out.node_id) out.node_id = raw.id;

  return out;
}

// Lightweight YAML subset parser — handles indented blocks, scalars, sequences,
// nested maps. Good enough for our backend output.
function parseYamlBlock(text: string): VaultFrontmatter {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: any; key?: string }> = [
    { indent: -1, container: root },
  ];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.match(/^ */)![0].length;
    const trimmed = line.slice(indent);
    const isListItem = trimmed.startsWith('- ');

    // Pop stack frames whose indent ≥ current indent. Exception: a list item
    // at the same indent as its parent key is valid YAML —
    //   edges:
    //     function_call:        # indent 2
    //     - target: Foo         # indent 2  (list item at same indent)
    // — so we keep the array frame on the stack instead of popping it off.
    while (stack.length > 1) {
      const topFrame = stack[stack.length - 1];
      if (isListItem && Array.isArray(topFrame.container) && topFrame.indent === indent) break;
      if (topFrame.indent >= indent) stack.pop();
      else break;
    }
    const top = stack[stack.length - 1];

    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      if (!Array.isArray(top.container)) {
        i++;
        continue;
      }
      // inline mapping: `- key: value`
      if (/^[A-Za-z_][\w-]*:/.test(value)) {
        const obj: Record<string, unknown> = {};
        // first inline key/value
        const colonIdx = value.indexOf(':');
        const k = value.slice(0, colonIdx).trim();
        const v = value.slice(colonIdx + 1).trim();
        obj[k] = v ? parseScalar(v) : null;
        top.container.push(obj);
        // following deeper-indented lines are also part of this object
        const objIndent = indent + 2;
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j];
          if (!next.trim()) {
            j++;
            continue;
          }
          const nIndent = next.match(/^ */)![0].length;
          if (nIndent < objIndent) break;
          const nTrim = next.slice(nIndent);
          if (nTrim.startsWith('- ')) break;
          const c = nTrim.indexOf(':');
          if (c < 0) break;
          const nk = nTrim.slice(0, c).trim();
          const nv = nTrim.slice(c + 1).trim();
          if (!nv) {
            // could be a nested list/map; for our schema this is `refs:`
            const arr: unknown[] = [];
            obj[nk] = arr;
            const childIndent = nIndent + 2;
            let k2 = j + 1;
            while (k2 < lines.length) {
              const nx = lines[k2];
              if (!nx.trim()) {
                k2++;
                continue;
              }
              const nx2 = nx.match(/^ */)![0].length;
              if (nx2 < childIndent) break;
              const nt = nx.slice(nx2);
              if (nt.startsWith('- ')) {
                arr.push(parseScalar(nt.slice(2).trim()));
                k2++;
              } else break;
            }
            j = k2;
          } else {
            obj[nk] = parseScalar(nv);
            j++;
          }
        }
        i = j;
        continue;
      }
      top.container.push(parseScalar(value));
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (!Array.isArray(top.container) && top.container !== null) {
      if (rest === '' || rest === '|' || rest === '>') {
        // peek next non-empty to decide list vs map
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) {
          (top.container as Record<string, unknown>)[key] = null;
          i++;
          continue;
        }
        const nextIndent = lines[j].match(/^ */)![0].length;
        const nextTrim = lines[j].slice(nextIndent);
        const nextIsListItem = nextTrim.startsWith('- ');
        // YAML allows list items at the same indent as their parent key, so
        // accept nextIndent === indent when the next line is `- item`.
        if (nextIndent < indent || (nextIndent === indent && !nextIsListItem)) {
          (top.container as Record<string, unknown>)[key] = null;
          i++;
          continue;
        }
        if (nextIsListItem) {
          const arr: unknown[] = [];
          (top.container as Record<string, unknown>)[key] = arr;
          stack.push({ indent, container: arr, key });
        } else {
          const obj: Record<string, unknown> = {};
          (top.container as Record<string, unknown>)[key] = obj;
          stack.push({ indent, container: obj, key });
        }
        i++;
        continue;
      }
      (top.container as Record<string, unknown>)[key] = parseScalar(rest);
      i++;
      continue;
    }

    i++;
  }
  return root as VaultFrontmatter;
}

function parseScalar(raw: string): unknown {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  // inline flow sequence: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  return raw;
}

// Strip frontmatter and return just the markdown body (everything after `---\n---`).
export function stripFrontmatter(raw: string): string {
  return splitFrontmatter(raw).body;
}

// Extract the user NOTES section (everything below the `## [ NOTES ]` heading).
export function extractNotes(body: string): { aiSection: string; notes: string } {
  const NOTES_HEADING = /^##\s*\[\s*NOTES\s*\]\s*$/m;
  const idx = body.search(NOTES_HEADING);
  if (idx < 0) return { aiSection: body, notes: '' };
  const headingMatch = body.slice(idx).match(/^##\s*\[\s*NOTES\s*\]\s*\n/);
  const headingLen = headingMatch ? headingMatch[0].length : 0;
  // skip optional HTML divider comment
  let after = body.slice(idx + headingLen);
  after = after.replace(/^<!--[^]*?-->\s*\n/, '');
  return {
    aiSection: body.slice(0, idx).trimEnd(),
    notes: after.trimStart(),
  };
}
