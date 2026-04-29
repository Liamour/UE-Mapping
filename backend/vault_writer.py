"""
Vault Writer — produces the Obsidian-style markdown vault that is the source of
truth for AICartographer. Each scanned node becomes one .md file under
<project_root>/.aicartographer/vault/Blueprints/ (or CPP/, Interfaces/...).

INVARIANTS (non-negotiable, enforced by tests):
- The "## [ NOTES ]" section and everything after it is OWNED BY THE DEVELOPER.
  No code path in this module may alter the contents below that heading once
  the file exists. Re-scans only ever rewrite content above it.
- BACKLINKS section is auto-generated, lives between explicit markers, and is
  the only auto-generated block inside the body that is rewritten on each scan.
- AST-derived fields and LLM-derived fields are kept in separate frontmatter
  zones so git diffs surface "the code changed" vs "the AI's interpretation
  drifted" as distinct events.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

VAULT_DIRNAME = ".aicartographer/vault"
NOTES_HEADING = "## [ NOTES ]"
NOTES_DIVIDER_COMMENT = "<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->"
# These two markers are machine-readable splice anchors — must NOT be translated;
# rebuild_backlinks() searches for them as exact strings to find the splice region.
BACKLINKS_START = "<!-- backlinks-start: AUTO-GENERATED, do not edit -->"
BACKLINKS_END = "<!-- backlinks-end -->"

DEFAULT_NOTES_BODY = (
    "*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*\n"
)


# ─────────────────────────────────────────────────────────────────────────────
# Language strings — only the human-visible templates translate. Section
# heading SLOTS like `## [ ... ]` translate too (the user reads them). The
# `<!-- backlinks-start -->` markers do NOT — they're splice anchors.
# ─────────────────────────────────────────────────────────────────────────────

_STRINGS_EN: Dict[str, str] = {
    "intro": "## [ INTRO ]",
    "members": "## [ MEMBERS ]",
    "backlinks": "## [ BACKLINKS ]",
    "system_risk_callout": "> [!system_risk] System risk: **{risk}**",
    "members_caption": "*Full member list ({n}). Hub node marked with ★.*",
    "no_narrative": "*(LLM did not emit a narrative block for this system — see [Project Overview](_overview.md) for the full project map.)*",
    "system_aggregate": "*(system pages aggregate their members; per-BP backlinks live on each blueprint page.)*",
    "no_backlinks_yet": "*(no backlinks yet — will populate after batch scan completes)*",
    "no_incoming": "*(no incoming references)*",
    "awaiting_llm": "*(awaiting LLM analysis)*",
    "project_overview_title": "Project Overview",
    "project_risk_callout": "> [!project_risk] Project risk: **{risk}**",
    "overview_no_backlinks": "*(project overview has no backlinks — it sits above the graph.)*",
    "edge_label": "edge",
}

_STRINGS_ZH: Dict[str, str] = {
    "intro": "## [ 简介 ]",
    "members": "## [ 成员 ]",
    "backlinks": "## [ 反向链接 ]",
    "system_risk_callout": "> [!system_risk] 系统风险等级：**{risk}**",
    "members_caption": "*完整成员清单（{n} 个）。Hub 节点用 ★ 标记。*",
    "no_narrative": "*(LLM 未为该系统输出叙事块 — 完整项目地图请参见 [项目总览](_overview.md)。)*",
    "system_aggregate": "*(系统页聚合了该系统的所有成员；每个蓝图的反向链接位于其各自的页面上。)*",
    "no_backlinks_yet": "*(尚未生成反向链接 — 批量扫描完成后会自动填充。)*",
    "no_incoming": "*(无传入引用)*",
    "awaiting_llm": "*(等待 LLM 分析中)*",
    "project_overview_title": "项目总览",
    "project_risk_callout": "> [!project_risk] 项目风险等级：**{risk}**",
    "overview_no_backlinks": "*(项目总览没有反向链接 — 它位于图的顶层。)*",
    "edge_label": "关系",
}


def _strings(language: Optional[str]) -> Dict[str, str]:
    return _STRINGS_ZH if language == "zh" else _STRINGS_EN

NODE_TYPE_TO_SUBDIR = {
    "Blueprint": "Blueprints",
    "BP": "Blueprints",
    "CPP": "CPP",
    "C++": "CPP",
    "Interface": "Interfaces",
    "Component": "Blueprints",
    # New blueprint flavours surfaced by the C++ bridge after the WBP/AnimBP
    # filter widening (§15.2 #2).  Each gets its own subdir so the file tree
    # groups them naturally; the underlying frontmatter schema is identical.
    "WidgetBlueprint": "Widgets",
    "AnimBlueprint": "Anims",
    "FunctionLibrary": "Libraries",
    "MacroLibrary": "Libraries",
}


# ─────────────────────────────────────────────────────────────────────────────
# Dataclasses
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Edge:
    target: str            # target node id or stable name
    edge_type: str         # function_call | interface_call | cast | spawn | listens_to
    refs: List[str] = field(default_factory=list)
    label: Optional[str] = None


@dataclass
class NodeRecord:
    node_id: str
    title: str             # used as filename (sanitised) and H1
    asset_path: str        # /Game/.../BP_X.BP_X
    node_type: str = "Blueprint"
    parent_class: Optional[str] = None
    ast_data: Optional[Any] = None
    edges_out: List[Edge] = field(default_factory=list)

    # LLM-derived
    intent: Optional[str] = None
    risk_level: str = "nominal"   # nominal | warning | critical
    tags: List[str] = field(default_factory=list)
    full_analysis_markdown: Optional[str] = None  # raw LLM markdown body

    # Optional AST-derived structured info (populated when extractor is available)
    exports_functions: List[str] = field(default_factory=list)
    exports_events: List[str] = field(default_factory=list)
    exports_dispatchers: List[str] = field(default_factory=list)
    variables: List[Dict[str, Any]] = field(default_factory=list)
    components: List[Dict[str, Any]] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Path helpers
# ─────────────────────────────────────────────────────────────────────────────

def _sanitise_filename(name: str) -> str:
    """Map an arbitrary node title to a safe markdown filename (no extension)."""
    cleaned = re.sub(r"[^\w\-.]+", "_", name).strip("._")
    return cleaned or "untitled"


def vault_root(project_root: str) -> Path:
    return Path(project_root) / VAULT_DIRNAME


def node_file_path(project_root: str, node: NodeRecord) -> Path:
    subdir = NODE_TYPE_TO_SUBDIR.get(node.node_type, "Blueprints")
    return vault_root(project_root) / subdir / f"{_sanitise_filename(node.title)}.md"


def ensure_vault_layout(project_root: str, default_vocab_src: Optional[Path] = None) -> Path:
    """Create vault dir tree on first run. Returns vault root path."""
    root = vault_root(project_root)
    for sub in ("Blueprints", "CPP", "Interfaces", "Widgets", "Anims", "Libraries", "_systems", "_meta"):
        (root / sub).mkdir(parents=True, exist_ok=True)

    # Copy default vocabulary if not present
    vocab_dest = root / "_meta" / "tag-vocabulary.json"
    if not vocab_dest.exists() and default_vocab_src and default_vocab_src.exists():
        shutil.copy(default_vocab_src, vocab_dest)
    return root


# ─────────────────────────────────────────────────────────────────────────────
# AST hashing — incremental scan key
# ─────────────────────────────────────────────────────────────────────────────

def compute_ast_hash(ast_data: Any) -> str:
    """Stable hash over canonicalised AST. None → 'empty'."""
    if ast_data is None:
        return "empty"
    canonical = json.dumps(ast_data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


# ─────────────────────────────────────────────────────────────────────────────
# Frontmatter assembly
# ─────────────────────────────────────────────────────────────────────────────

def _build_frontmatter(
    node: NodeRecord,
    ast_hash: str,
    previous_ast_hash: Optional[str],
    notes_review_needed: bool,
    notes_review_reason: Optional[str],
    model: str,
    engine_version: str,
) -> Dict[str, Any]:
    fm: Dict[str, Any] = {
        # IDENTITY
        "id": node.node_id,
        "asset_path": node.asset_path,
        "type": node.node_type,
    }
    if node.parent_class:
        fm["parent_class"] = node.parent_class

    # SCAN METADATA
    scan_block: Dict[str, Any] = {
        "ast_hash": ast_hash,
        "scanned_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": model,
        "engine_version": engine_version,
    }
    if previous_ast_hash and previous_ast_hash != ast_hash:
        scan_block["previous_ast_hash"] = previous_ast_hash
    if notes_review_needed:
        scan_block["notes_review_needed"] = True
        if notes_review_reason:
            scan_block["notes_review_reason"] = notes_review_reason
    fm["scan"] = scan_block

    # LLM-DERIVED
    if node.intent:
        fm["intent"] = node.intent
    fm["risk_level"] = node.risk_level
    if node.tags:
        fm["tags"] = node.tags

    # AST-DERIVED
    if any([node.exports_functions, node.exports_events, node.exports_dispatchers]):
        exports: Dict[str, Any] = {}
        if node.exports_functions:
            exports["functions"] = node.exports_functions
        if node.exports_events:
            exports["events"] = node.exports_events
        if node.exports_dispatchers:
            exports["dispatchers"] = node.exports_dispatchers
        fm["exports"] = exports
    if node.variables:
        fm["variables"] = node.variables
    if node.components:
        # Frontend Lv2BlueprintGraph reads components as internal nodes.
        # Each entry is {name, class, parent} — written verbatim from the
        # bridge's SCS walker.
        fm["components"] = node.components

    # EDGES (AST-derived, typed) — grouped by edge_type
    if node.edges_out:
        edges_block: Dict[str, List[Dict[str, Any]]] = {}
        for e in node.edges_out:
            entry: Dict[str, Any] = {"target": e.target}
            if e.refs:
                entry["refs"] = e.refs
            if e.label:
                entry["label"] = e.label
            edges_block.setdefault(e.edge_type, []).append(entry)
        fm["edges"] = edges_block

    return fm


def _render_frontmatter(fm: Dict[str, Any]) -> str:
    yaml_text = yaml.safe_dump(
        fm,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=120,
    )
    return f"---\n{yaml_text}---\n"


# ─────────────────────────────────────────────────────────────────────────────
# Body assembly (everything above NOTES)
# ─────────────────────────────────────────────────────────────────────────────

def _render_body_above_notes(node: NodeRecord, language: Optional[str] = None) -> str:
    s = _strings(language)
    parts: List[str] = []
    parts.append(f"# {node.title}\n")

    if node.intent:
        parts.append(f"> [!intent]\n> {node.intent}\n")

    if node.full_analysis_markdown:
        # The LLM body already contains its own ### [ INTENT ] etc. headings.
        parts.append(node.full_analysis_markdown.rstrip() + "\n")
    else:
        parts.append(s["awaiting_llm"] + "\n")

    parts.append(s["backlinks"] + "\n")
    parts.append(BACKLINKS_START + "\n")
    parts.append(s["no_backlinks_yet"] + "\n")
    parts.append(BACKLINKS_END + "\n")

    return "\n".join(parts)


def _initial_notes_block() -> str:
    return (
        f"{NOTES_HEADING}\n"
        f"{NOTES_DIVIDER_COMMENT}\n"
        f"\n"
        f"{DEFAULT_NOTES_BODY}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# NOTES preservation — the load-bearing invariant
# ─────────────────────────────────────────────────────────────────────────────

def _split_at_notes(file_text: str) -> tuple[str, Optional[str]]:
    """
    Returns (above_notes, notes_block_including_heading_or_None).
    The split line is the first occurrence of the NOTES_HEADING at the start of a line.
    """
    pattern = re.compile(rf"(?ms)^{re.escape(NOTES_HEADING)}\s*$")
    match = pattern.search(file_text)
    if not match:
        return file_text, None
    return file_text[: match.start()], file_text[match.start():]


def read_existing_notes(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    _, notes = _split_at_notes(text)
    return notes


def read_existing_frontmatter(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    try:
        return yaml.safe_load(text[4:end]) or {}
    except yaml.YAMLError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point — write a single node
# ─────────────────────────────────────────────────────────────────────────────

def write_node_file(
    project_root: str,
    node: NodeRecord,
    model: str = "unknown",
    engine_version: str = "5.7",
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Write or update one vault file for `node`.

    Returns a result dict:
      {
        "path": "<absolute path>",
        "ast_hash": "<hash>",
        "previous_ast_hash": "<hash or None>",
        "skipped": bool,            # True if AST unchanged AND file already current
        "created": bool,            # True if file did not previously exist
        "notes_review_needed": bool # True if AST changed and user notes existed
      }
    """
    path = node_file_path(project_root, node)
    path.parent.mkdir(parents=True, exist_ok=True)

    ast_hash = compute_ast_hash(node.ast_data)
    existing_fm = read_existing_frontmatter(path)
    previous_ast_hash = None
    if existing_fm:
        previous_ast_hash = (existing_fm.get("scan") or {}).get("ast_hash")

    created = not path.exists()

    # Detect whether developer has put real notes (i.e. anything beyond the
    # default seeded body). If yes, AND ast changed, set notes_review_needed.
    existing_notes_block = read_existing_notes(path) if not created else None
    has_real_notes = False
    if existing_notes_block:
        # Strip heading + divider + default body; if anything substantive remains, treat as real.
        residue = existing_notes_block
        residue = residue.replace(NOTES_HEADING, "", 1)
        residue = residue.replace(NOTES_DIVIDER_COMMENT, "", 1)
        residue = residue.replace(DEFAULT_NOTES_BODY, "", 1)
        if residue.strip():
            has_real_notes = True

    notes_review_needed = bool(
        has_real_notes
        and previous_ast_hash
        and previous_ast_hash != ast_hash
    )
    notes_review_reason = (
        f"AST hash changed: {previous_ast_hash} → {ast_hash}"
        if notes_review_needed else None
    )

    fm = _build_frontmatter(
        node=node,
        ast_hash=ast_hash,
        previous_ast_hash=previous_ast_hash,
        notes_review_needed=notes_review_needed,
        notes_review_reason=notes_review_reason,
        model=model,
        engine_version=engine_version,
    )

    frontmatter_text = _render_frontmatter(fm)
    body_text = _render_body_above_notes(node, language=language)
    notes_text = existing_notes_block if existing_notes_block else _initial_notes_block()

    full_text = frontmatter_text + "\n" + body_text + "\n" + notes_text

    # Atomic write
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(full_text, encoding="utf-8")
    os.replace(tmp_path, path)

    return {
        "path": str(path),
        "ast_hash": ast_hash,
        "previous_ast_hash": previous_ast_hash,
        "skipped": False,
        "created": created,
        "notes_review_needed": notes_review_needed,
    }


# ─────────────────────────────────────────────────────────────────────────────
# User notes editing — only allowed write into the NOTES region
# ─────────────────────────────────────────────────────────────────────────────

def write_user_notes(project_root: str, relative_path: str, new_notes_body: str) -> Dict[str, Any]:
    """
    Replace the contents BELOW the NOTES heading with new_notes_body.
    Frontmatter and main body stay untouched. Also clears notes_review_needed flag.

    relative_path: e.g. "Blueprints/BP_HealthComponent.md" (relative to vault root).
    """
    full_path = vault_root(project_root) / relative_path
    if not full_path.exists():
        raise FileNotFoundError(f"Vault file not found: {full_path}")

    text = full_path.read_text(encoding="utf-8")
    above, notes_block = _split_at_notes(text)
    if notes_block is None:
        # File has no NOTES heading — append a fresh one
        above = text.rstrip() + "\n\n"

    # Clear notes_review_needed in frontmatter
    if above.startswith("---\n"):
        end = above.find("\n---\n", 4)
        if end != -1:
            try:
                fm = yaml.safe_load(above[4:end]) or {}
                if isinstance(fm, dict) and isinstance(fm.get("scan"), dict):
                    fm["scan"].pop("notes_review_needed", None)
                    fm["scan"].pop("notes_review_reason", None)
                    new_fm_text = yaml.safe_dump(
                        fm, sort_keys=False, allow_unicode=True,
                        default_flow_style=False, width=120,
                    )
                    above = f"---\n{new_fm_text}---\n" + above[end + len("\n---\n"):]
            except yaml.YAMLError:
                pass

    new_notes = (
        f"{NOTES_HEADING}\n"
        f"{NOTES_DIVIDER_COMMENT}\n"
        f"\n"
        f"{new_notes_body.rstrip()}\n"
    )

    full_text = above.rstrip() + "\n\n" + new_notes
    tmp_path = full_path.with_suffix(full_path.suffix + ".tmp")
    tmp_path.write_text(full_text, encoding="utf-8")
    os.replace(tmp_path, full_path)

    return {"path": str(full_path), "notes_review_cleared": True}


# ─────────────────────────────────────────────────────────────────────────────
# Backlinks reverse-index pass
# ─────────────────────────────────────────────────────────────────────────────

def rebuild_backlinks(project_root: str, language: Optional[str] = None) -> Dict[str, int]:
    """
    Walk every .md in vault, parse frontmatter `edges:`, build reverse map,
    then rewrite the BACKLINKS region of every file.

    `language` controls the user-visible "no incoming references" placeholder.
    Splice anchors stay literal regardless.

    Returns counts {nodes_scanned, nodes_with_backlinks, total_backlinks}.
    """
    root = vault_root(project_root)
    md_files = [p for p in root.rglob("*.md") if not p.name.startswith("_")]

    # Pass 1: build forward title→path index and reverse map
    title_to_path: Dict[str, Path] = {}
    reverse: Dict[str, List[Dict[str, str]]] = {}

    for path in md_files:
        title = path.stem
        title_to_path[title] = path

    for path in md_files:
        fm = read_existing_frontmatter(path)
        if not fm:
            continue
        edges = fm.get("edges") or {}
        if not isinstance(edges, dict):
            continue
        source_title = path.stem
        for edge_type, entries in edges.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                target = entry.get("target")
                if not target:
                    continue
                reverse.setdefault(target, []).append({
                    "source": source_title,
                    "edge_type": edge_type,
                })

    # Pass 2: rewrite each file's BACKLINKS region
    nodes_with_backlinks = 0
    total = 0
    for path in md_files:
        title = path.stem
        incoming = reverse.get(title, [])
        if incoming:
            nodes_with_backlinks += 1
            total += len(incoming)
        new_block = _render_backlinks_block(incoming, language=language)
        _splice_backlinks(path, new_block)

    return {
        "nodes_scanned": len(md_files),
        "nodes_with_backlinks": nodes_with_backlinks,
        "total_backlinks": total,
    }


def _render_backlinks_block(incoming: List[Dict[str, str]], language: Optional[str] = None) -> str:
    s = _strings(language)
    if not incoming:
        return f"{BACKLINKS_START}\n{s['no_incoming']}\n{BACKLINKS_END}\n"
    lines = [BACKLINKS_START]
    for ref in incoming:
        lines.append(f"- [[{ref['source']}]] — `{ref['edge_type']}`")
    lines.append(BACKLINKS_END)
    return "\n".join(lines) + "\n"


def _splice_backlinks(path: Path, new_block: str) -> None:
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"{re.escape(BACKLINKS_START)}.*?{re.escape(BACKLINKS_END)}\n?",
        re.DOTALL,
    )
    if not pattern.search(text):
        return  # File predates backlinks region; skip (will be regenerated next scan).
    new_text = pattern.sub(new_block, text)
    if new_text != text:
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(new_text, encoding="utf-8")
        os.replace(tmp_path, path)


# ─────────────────────────────────────────────────────────────────────────────
# Scan manifest — increments scans use this to skip unchanged nodes
# ─────────────────────────────────────────────────────────────────────────────

def manifest_path(project_root: str) -> Path:
    return vault_root(project_root) / "_meta" / "scan-manifest.json"


def load_manifest(project_root: str) -> Dict[str, Any]:
    p = manifest_path(project_root)
    if not p.exists():
        return {"asset_hashes": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"asset_hashes": {}}


def update_manifest(
    project_root: str,
    completed: int,
    failed: int,
    skipped: int,
    asset_hashes: Dict[str, str],
    engine_version: str = "5.7",
) -> Path:
    p = manifest_path(project_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "last_full_scan": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "engine_version": engine_version,
        "scan_results": {
            "completed": completed,
            "failed": failed,
            "skipped": skipped,
        },
        "asset_hashes": asset_hashes,
    }
    p.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return p


def is_unchanged(
    project_root: str,
    node_id: str,
    current_ast_hash: str,
    node_type: str = "Blueprint",
) -> bool:
    """Decide whether a node can be skipped on an incremental scan.

    Two conditions must hold:
      1. AST hash matches the previously recorded one in scan-manifest.json.
      2. A real LLM-analysed .md exists for this node in the vault
         (`frontmatter.analysis_state == 'llm'`).

    Without (2), a vault that only ever ran framework-scan (skeleton writes)
    would short-circuit every LLM scan and never produce real analysis. We
    saw exactly that in the wild: 55 BPs all marked "skipped" with 0 wrote.
    """
    manifest = load_manifest(project_root)
    if manifest.get("asset_hashes", {}).get(node_id) != current_ast_hash:
        return False
    subdir = NODE_TYPE_TO_SUBDIR.get(node_type, "Blueprints")
    md_path = vault_root(project_root) / subdir / f"{_sanitise_filename(node_id)}.md"
    fm = read_existing_frontmatter(md_path)
    if not fm:
        return False
    return fm.get("analysis_state") == "llm"


# ─────────────────────────────────────────────────────────────────────────────
# L1 (project-level) IO — feeds the project clustering LLM call and writes
# its output back to the vault as Systems/_overview.md + _meta/l1_overview.json.
# ─────────────────────────────────────────────────────────────────────────────

L1_OVERVIEW_REL = "Systems/_overview.md"
L1_METADATA_REL = "_meta/l1_overview.json"


def collect_l2_metadata(project_root: str) -> List[Dict[str, Any]]:
    """Walk the vault's blueprint pages and extract the per-BP metadata that
    feeds the L1 clustering call.  Skips Systems/_*.md (aggregate pages) and
    files without a parseable scan block.

    Each entry mirrors the L1_SYSTEM_PROMPT input contract:
      {node_id, asset_path, intent, system, layer, role, risk_level, outbound_edges}
    Tags are split back into their axes (the L2 writer stores them as
    "#system/x", "#layer/y", "#role/z").
    """
    root = vault_root(project_root)
    if not root.exists():
        return []

    summaries: List[Dict[str, Any]] = []
    for path in root.rglob("*.md"):
        if path.name.startswith("_"):
            continue
        # Skip aggregate Systems/<id>.md pages — they describe a system, not a member.
        if path.parent.name == "Systems":
            continue
        fm = read_existing_frontmatter(path)
        if not fm or not isinstance(fm, dict):
            continue
        if not fm.get("asset_path"):
            continue

        systems: List[str] = []
        layer: Optional[str] = None
        role: Optional[str] = None
        for tag in (fm.get("tags") or []):
            if not isinstance(tag, str):
                continue
            if tag.startswith("#system/"):
                systems.append(tag[len("#system/"):])
            elif tag.startswith("#layer/") and not layer:
                layer = tag[len("#layer/"):]
            elif tag.startswith("#role/") and not role:
                role = tag[len("#role/"):]

        edges_block = fm.get("edges") or {}
        outbound: List[Dict[str, str]] = []
        if isinstance(edges_block, dict):
            for edge_type, entries in edges_block.items():
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if isinstance(entry, dict) and entry.get("target"):
                        outbound.append({
                            "target": str(entry["target"]),
                            "edge_type": str(edge_type),
                        })

        summaries.append({
            "node_id": str(fm.get("id") or path.stem),
            "asset_path": str(fm["asset_path"]),
            "title": path.stem,
            "node_type": str(fm.get("type") or "Blueprint"),
            "intent": fm.get("intent"),
            "system": systems,
            "layer": layer,
            "role": role,
            "risk_level": str(fm.get("risk_level") or "nominal"),
            "outbound_edges": outbound,
        })
    return summaries


def write_l1_overview(
    project_root: str,
    metadata: Dict[str, Any],
    analysis_markdown: str,
    model: str = "unknown",
    member_meta: Optional[List[Dict[str, Any]]] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Write the L1 result to:
      - Systems/_overview.md         project narrative (frontmatter + ANALYSIS body)
      - _meta/l1_overview.json       structured metadata for force-graph coloring
      - Systems/<axis>.md            one file per LLM system, keyed by axis so the
                                     frontend's existing `tags: #system/<axis>`
                                     routing resolves directly to it

    `member_meta` is the output of collect_l2_metadata — used to resolve member
    asset_paths back to their vault filename + subdir for the per-system MEMBERS
    list.  When omitted, member links are still rendered but default to the
    Blueprints/ subdir which may 404 for Interfaces/Components.

    Returns {"overview_path", "metadata_path", "system_paths": [...], "system_count"}.
    """
    root = vault_root(project_root)
    (root / "Systems").mkdir(parents=True, exist_ok=True)
    (root / "_meta").mkdir(parents=True, exist_ok=True)

    s = _strings(language)
    systems = metadata.get("systems") or []
    cross_edges = metadata.get("cross_system_edges") or []
    project_risk = metadata.get("project_risk_level") or "nominal"
    scanned_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    overview_title = s["project_overview_title"]
    fm = {
        "id": "_overview",
        "type": "ProjectOverview",
        "title": overview_title,
        "scan": {
            "scanned_at": scanned_at,
            "model": model,
            "stage": "L1",
        },
        "system_count": len(systems),
        "project_risk_level": project_risk,
        "analysis_state": "llm",
    }
    frontmatter_text = _render_frontmatter(fm)

    body_parts: List[str] = [f"# {overview_title}\n"]
    body_parts.append(s["project_risk_callout"].format(risk=project_risk) + "\n")
    body_parts.append(analysis_markdown.rstrip() + "\n")
    body_parts.append(s["backlinks"] + "\n")
    body_parts.append(BACKLINKS_START + "\n")
    body_parts.append(s["overview_no_backlinks"] + "\n")
    body_parts.append(BACKLINKS_END + "\n")
    body_text = "\n".join(body_parts)

    overview_path = root / "Systems" / "_overview.md"
    existing_notes = read_existing_notes(overview_path) if overview_path.exists() else None
    notes_text = existing_notes if existing_notes else _initial_notes_block()
    full_text = frontmatter_text + "\n" + body_text + "\n" + notes_text

    tmp = overview_path.with_suffix(overview_path.suffix + ".tmp")
    tmp.write_text(full_text, encoding="utf-8")
    os.replace(tmp, overview_path)

    metadata_path = root / "_meta" / "l1_overview.json"
    metadata_payload = {
        "scanned_at": scanned_at,
        "model": model,
        **metadata,
    }
    metadata_path.write_text(
        json.dumps(metadata_payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Per-system .md — one per LLM system, filename = axis (matches the
    # frontend's `tags: #system/<axis>` → systemId convention).
    system_paths: List[str] = []
    asset_index = _build_member_index(member_meta or [])
    for sys_obj in systems:
        try:
            written = _write_system_md(
                root=root,
                system=sys_obj,
                analysis_markdown=analysis_markdown,
                asset_index=asset_index,
                model=model,
                scanned_at=scanned_at,
                language=language,
            )
            if written:
                system_paths.append(written)
        except Exception as e:  # pragma: no cover — never let one bad system block the others
            print(f"[SYS_WARN] failed to write Systems/<axis>.md for "
                  f"{sys_obj.get('id')}: {e}")

    return {
        "overview_path": str(overview_path),
        "metadata_path": str(metadata_path),
        "system_paths": system_paths,
        "system_count": len(systems),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Per-system .md helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_member_index(member_meta: List[Dict[str, Any]]) -> Dict[str, Dict[str, str]]:
    """asset_path → {title, subdir} for resolving member links.  Members not
    present in this index are still rendered (using a Blueprint default subdir)
    so the per-system .md doesn't silently drop unknown members."""
    out: Dict[str, Dict[str, str]] = {}
    for m in member_meta:
        asset_path = m.get("asset_path") or ""
        if not asset_path:
            continue
        title = m.get("title") or m.get("node_id") or asset_path.split("/")[-1].split(".")[0]
        node_type = m.get("node_type") or "Blueprint"
        subdir = NODE_TYPE_TO_SUBDIR.get(node_type, "Blueprints")
        out[asset_path] = {"title": str(title), "subdir": subdir}
    return out


_SYS_BLOCK_RE = re.compile(
    r"^### \[ (?P<title>.+?) \]\s*\n(?P<body>.*?)(?=^### \[|\Z)",
    flags=re.MULTILINE | re.DOTALL,
)


def _extract_system_block(analysis_markdown: str, system_title: str) -> str:
    """Pull the `### [ <system_title> ]` … (next ### or EOF) block out of the
    L1 narrative.  Returns the block body (without the heading) trimmed.
    Empty string when no matching heading exists."""
    if not analysis_markdown or not system_title:
        return ""
    target = system_title.strip()
    for m in _SYS_BLOCK_RE.finditer(analysis_markdown):
        if m.group("title").strip().lower() == target.lower():
            return m.group("body").strip()
    return ""


def _resolve_member_link(asset_path: str, asset_index: Dict[str, Dict[str, str]]) -> tuple[str, str]:
    """Return (display_title, relative_link) for a member.  Falls back to the
    asset name extracted from the path when we have no metadata for it."""
    info = asset_index.get(asset_path)
    if info:
        title = info["title"]
        subdir = info["subdir"]
    else:
        tail = asset_path.split("/")[-1]
        title = tail.split(".")[0] or tail
        subdir = "Blueprints"
    safe_name = _sanitise_filename(title)
    # Systems/<axis>.md links into ../Blueprints/<title>.md etc.
    return title, f"../{subdir}/{safe_name}.md"


def _write_system_md(
    root: Path,
    system: Dict[str, Any],
    analysis_markdown: str,
    asset_index: Dict[str, Dict[str, str]],
    model: str,
    scanned_at: str,
    language: Optional[str] = None,
) -> Optional[str]:
    s = _strings(language)
    axis = (system.get("axis") or system.get("id") or "").strip().lower()
    if not axis:
        return None  # malformed system entry — skip rather than write to "<empty>.md"

    title = system.get("title") or axis
    members = system.get("members") or []
    hub_asset = system.get("hub")
    risk_level = (system.get("risk_level") or "nominal").lower()

    # Body — first inject the LLM's per-system narrative (if extractable),
    # then append a deterministic MEMBERS list.  The LLM block already covers
    # Intent / Critical Path / Risk so we don't duplicate those headings.
    intro_block = _extract_system_block(analysis_markdown, title)

    body_lines: List[str] = []
    body_lines.append(f"# {title}\n")
    body_lines.append(s["system_risk_callout"].format(risk=risk_level) + "\n")

    body_lines.append(s["intro"])
    if intro_block:
        body_lines.append(intro_block)
    else:
        body_lines.append(s["no_narrative"])
    body_lines.append("")

    body_lines.append(s["members"])
    body_lines.append(s["members_caption"].format(n=len(members)))
    body_lines.append("")
    for asset_path in members:
        member_title, link = _resolve_member_link(asset_path, asset_index)
        marker = " ★" if asset_path == hub_asset else ""
        body_lines.append(f"- [{member_title}]({link}){marker}")
    body_lines.append("")

    body_lines.append(s["backlinks"])
    body_lines.append(BACKLINKS_START)
    body_lines.append(s["system_aggregate"])
    body_lines.append(BACKLINKS_END)

    body_text = "\n".join(body_lines)

    fm = {
        "title": title,
        "node_type": "System",
        "system_id": axis,
        "system_slug": system.get("id") or axis,
        "axis": axis,
        "member_count": len(members),
        "hub": hub_asset,
        "risk_level": risk_level,
        "scan": {
            "scanned_at": scanned_at,
            "model": model,
            "stage": "L1",
        },
        "analysis_state": "llm",
    }
    frontmatter_text = _render_frontmatter(fm)

    out_path = root / "Systems" / f"{_sanitise_filename(axis)}.md"
    existing_notes = read_existing_notes(out_path) if out_path.exists() else None
    notes_text = existing_notes if existing_notes else _initial_notes_block()

    full_text = frontmatter_text + "\n" + body_text + "\n\n" + notes_text
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(full_text, encoding="utf-8")
    os.replace(tmp, out_path)
    return str(out_path)


# ─────────────────────────────────────────────────────────────────────────────
# Apply-rename — migrate a vault .md to match a UE asset rename.
# ─────────────────────────────────────────────────────────────────────────────
# Used by the TopBar stale-asset dropdown's "Apply rename" button (HANDOFF
# §A1 P1 follow-up).  Triggered when the AssetRegistry stale listener has
# observed a rename from old_path → new_path; this function:
#   1. reads the existing vault .md frontmatter
#   2. updates `title` + `asset_path` in-place (stamping the previous
#      asset_path into `previous_asset_path` so history is traceable)
#   3. writes the updated content under a new filename derived from new_name
#   4. deletes the old file
# Body and NOTES sections are preserved verbatim — the user's developer-
# private notes never get touched.

def apply_rename(
    project_root: str,
    old_relative_path: str,
    new_name: str,
    new_asset_path: str,
) -> Dict[str, Any]:
    """Rename a vault .md to match a UE asset rename.  Returns
    {new_relative_path, previous_asset_path}."""
    root = vault_root(project_root).resolve()
    old_path = (root / old_relative_path).resolve()
    if not str(old_path).startswith(str(root)):
        raise ValueError(f"Path traversal denied: {old_relative_path}")
    if not old_path.exists():
        raise FileNotFoundError(f"Source not found: {old_relative_path}")

    new_filename = _sanitise_filename(new_name) + ".md"
    new_path = (old_path.parent / new_filename).resolve()
    if new_path != old_path and new_path.exists():
        raise FileExistsError(
            f"Target already exists: {new_path.relative_to(root)} — "
            f"vault note for '{new_name}' is already there"
        )

    text = old_path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"File missing YAML frontmatter: {old_relative_path}")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError(f"Frontmatter not closed: {old_relative_path}")

    fm = yaml.safe_load(text[4:end]) or {}
    body = text[end + 5:]

    previous_asset_path = fm.get("asset_path", "") or ""
    fm["title"] = new_name
    fm["asset_path"] = new_asset_path
    if previous_asset_path and previous_asset_path != new_asset_path:
        fm["previous_asset_path"] = previous_asset_path

    new_text = _render_frontmatter(fm) + body
    new_path.write_text(new_text, encoding="utf-8")
    if new_path != old_path:
        old_path.unlink()

    return {
        "new_relative_path": str(new_path.relative_to(root)).replace("\\", "/"),
        "previous_asset_path": previous_asset_path,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Delete-vault-file — remove a single .md from the vault.
# ─────────────────────────────────────────────────────────────────────────────
# Wired to the TopBar stale dropdown's "Delete vault note" button (the Apply
# action for a `removed` event).  Path is normalised + path-traversal-checked
# against vault_root.  Returns {ok, deleted_relative_path} on success, raises
# FileNotFoundError if the file is already gone.

def delete_vault_file(project_root: str, relative_path: str) -> Dict[str, Any]:
    root = vault_root(project_root).resolve()
    target = (root / relative_path).resolve()
    if not str(target).startswith(str(root)):
        raise ValueError(f"Path traversal denied: {relative_path}")
    if not target.exists():
        raise FileNotFoundError(f"Vault note not found: {relative_path}")
    if target.is_dir():
        raise ValueError(f"Refusing to delete directory: {relative_path}")
    target.unlink()
    return {
        "ok": True,
        "deleted_relative_path": str(target.relative_to(root)).replace("\\", "/"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# find_vault_note_for_asset — look up an existing vault .md by asset_path.
# ─────────────────────────────────────────────────────────────────────────────
# Used by framework-scan to honour user-organised folder structures: if a node
# already has a .md file *somewhere* in the vault (regardless of subdir), the
# next scan should re-write that file in place rather than dropping a fresh
# copy at the deterministic Blueprints/<Name>.md path and orphaning the user's
# moved file.  Returns the relative path (with forward slashes) or None.

def find_vault_note_for_asset(project_root: str, asset_path: str) -> Optional[str]:
    if not asset_path:
        return None
    root = vault_root(project_root).resolve()
    if not root.exists():
        return None
    for md in root.rglob("*.md"):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        if not text.startswith("---\n"):
            continue
        end = text.find("\n---\n", 4)
        if end == -1:
            continue
        try:
            fm = yaml.safe_load(text[4:end]) or {}
        except yaml.YAMLError:
            continue
        if isinstance(fm, dict) and fm.get("asset_path") == asset_path:
            return str(md.relative_to(root)).replace("\\", "/")
    return None
