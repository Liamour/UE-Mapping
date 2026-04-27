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
BACKLINKS_START = "<!-- backlinks-start: AUTO-GENERATED, do not edit -->"
BACKLINKS_END = "<!-- backlinks-end -->"

DEFAULT_NOTES_BODY = (
    "*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*\n"
)

NODE_TYPE_TO_SUBDIR = {
    "Blueprint": "Blueprints",
    "BP": "Blueprints",
    "CPP": "CPP",
    "C++": "CPP",
    "Interface": "Interfaces",
    "Component": "Blueprints",
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
    for sub in ("Blueprints", "CPP", "Interfaces", "_systems", "_meta"):
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

def _render_body_above_notes(node: NodeRecord) -> str:
    parts: List[str] = []
    parts.append(f"# {node.title}\n")

    if node.intent:
        parts.append(f"> [!intent]\n> {node.intent}\n")

    if node.full_analysis_markdown:
        # The LLM body already contains its own ### [ INTENT ] etc. headings.
        parts.append(node.full_analysis_markdown.rstrip() + "\n")
    else:
        parts.append("*(awaiting LLM analysis)*\n")

    parts.append("## [ BACKLINKS ]\n")
    parts.append(BACKLINKS_START + "\n")
    parts.append("*(no backlinks yet — will populate after batch scan completes)*\n")
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
    body_text = _render_body_above_notes(node)
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

def rebuild_backlinks(project_root: str) -> Dict[str, int]:
    """
    Walk every .md in vault, parse frontmatter `edges:`, build reverse map,
    then rewrite the BACKLINKS region of every file.

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
        new_block = _render_backlinks_block(incoming)
        _splice_backlinks(path, new_block)

    return {
        "nodes_scanned": len(md_files),
        "nodes_with_backlinks": nodes_with_backlinks,
        "total_backlinks": total,
    }


def _render_backlinks_block(incoming: List[Dict[str, str]]) -> str:
    if not incoming:
        return f"{BACKLINKS_START}\n*(no incoming references)*\n{BACKLINKS_END}\n"
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


def is_unchanged(project_root: str, node_id: str, current_ast_hash: str) -> bool:
    """Used by incremental scan to decide whether to skip this node entirely."""
    manifest = load_manifest(project_root)
    return manifest.get("asset_hashes", {}).get(node_id) == current_ast_hash
