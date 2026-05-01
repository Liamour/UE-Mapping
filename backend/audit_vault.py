"""Anti-fabrication audit for L1 system narratives (HANDOFF §22.5 #1 / §24.7 #1).

Walks `.aicartographer/vault/Systems/*.md`, extracts every asset identifier
the LLM wrote into the narrative body, and verifies each against:
  1. the system's declared members (from the Blueprint vault frontmatter
     `tags: [system/<id>, ...]`), and
  2. the full vault asset roster (every .md under Blueprints / Anims /
     Interfaces / Components / Widgets / Libraries / Data).

Three buckets:
  - in_scope     — asset is a member of THIS system (clean)
  - out_of_scope — asset exists in vault but in another system; allowed in
                   EXTERNAL COUPLING / risk callouts but suspicious in
                   INTERNAL CALL FLOW / MEMBERS sections
  - fabricated   — asset does not exist anywhere in vault — pure invention.
                   This is the failure mode that blocks production use.

Run from the worktree root:
    python backend/audit_vault.py D:\\Traeproject\\UEMapping
    python backend/audit_vault.py . --out vault-audit.md --json audit.json

The script is read-only — it never modifies vault files.  Safe to run on
production data without snapshots.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import yaml


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

VAULT_REL = ".aicartographer/vault"

# UE asset-naming convention prefixes seen in Cropout + general UE5 projects.
# An identifier qualifies as "asset reference" only if it starts with one of
# these — generic CamelCase tokens like `OnDeath`, `BeginPlay`, `Tick` are
# function names, not assets, and pollute the audit if mixed in.
ASSET_PREFIXES = (
    "BP_",      # Blueprint
    "BPC_",     # Blueprint Component
    "BPI_",     # Blueprint Interface
    "ABP_",     # AnimBlueprint
    "BTT_",     # Behavior Tree Task
    "BTS_",     # Behavior Tree Service
    "BTD_",     # Behavior Tree Decorator
    "BTC_",     # Behavior Tree Composite
    "BB_",      # Blackboard
    "BS_",      # Blend Space (or Blackboard Selector — disambig later)
    "EQS_",     # Environment Query
    "EQC_",     # Environment Query Context
    "UI_",      # UI Widget
    "UIE_",     # UI Element
    "CUI_",     # Common UI / DataAsset
    "IM_",      # Input Modifier
    "IMC_",     # Input Mapping Context
    "IA_",      # Input Action
    "DT_",      # DataTable
    "DA_",      # DataAsset
    "PDA_",     # Primary DataAsset
    "S_",       # Slate / sound — sometimes
    "T_",       # Texture
    "M_",       # Material — usually skipped
    "MI_",      # Material Instance
    "EQT_",     # Env Query Test
)

# Controlled-vocab tokens used by the prompt for edge types / risk levels /
# layer / role.  These appear backticked in narratives and are NOT asset
# references — exclude them so they don't show up as "fabricated".
VOCAB_TOKENS = frozenset({
    "function_call", "interface_call", "cast", "spawn", "listens_to",
    "inheritance", "delegate",
    "nominal", "warning", "critical",
    "actor", "controller", "interface", "behavior-tree", "behavior_tree",
    "data-asset", "data-table", "manager", "subsystem", "library", "macro",
    "widget", "anim", "component", "data", "core",
    "gameplay-core", "combat", "ai", "animation", "physics", "network",
    "multiplayer-meta", "ui", "audio", "vfx", "cinematic", "camera", "input",
    "world", "spawn", "persistence", "progression", "economy", "analytics",
    "tooling", "blueprint", "characters", "framework",
    "True", "False", "None", "true", "false", "null",
})

# Subdirs in vault that are auto-generated aggregates, not assets — skip when
# building the asset roster.
SKIP_VAULT_SUBDIRS = frozenset({"_meta", "_systems", "Systems"})

# Body cuts — sections written deterministically by `write_system_l1_narrative`
# AFTER the LLM-authored narrative.  We strip them so backlinks / member-link
# auto-text doesn't inflate the reference count.
MEMBER_HEADING_RE = re.compile(
    r"^##\s*\[\s*(?:Members|成员)\s*\]\s*$",
    re.MULTILINE,
)
BACKLINKS_HEADING_RE = re.compile(
    r"^(?:##\s*(?:Backlinks|反向链接)|<!--\s*backlinks-start)",
    re.MULTILINE,
)

# Backticked identifier — the LLM marks every asset reference with backticks
# in the narrative.  This is far more reliable than scanning prose for
# arbitrary CamelCase, which fires on every English noun.  Pattern allows
# the asset name optionally followed by ` (role)` — e.g. `BP_Foo (actor)`.
BACKTICK_IDENT_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")

# Markdown link target name — `[BP_Foo](path)` form, used in MEMBERS bullets.
# We match these too in case the LLM writes them inline within the narrative
# (some models do).
MD_LINK_NAME_RE = re.compile(r"\[([A-Za-z_][A-Za-z0-9_]*)\]\([^)]+\)")


# ─────────────────────────────────────────────────────────────────────────────
# Frontmatter / file IO
# ─────────────────────────────────────────────────────────────────────────────

def _split_frontmatter(text: str) -> Tuple[Dict, str]:
    """Split a markdown file with `---`-delimited YAML frontmatter into
    (parsed_dict, body_text).  Tolerates files without frontmatter."""
    if not text.startswith("---"):
        return {}, text
    end_idx = text.find("\n---", 3)
    if end_idx < 0:
        return {}, text
    yaml_text = text[3:end_idx].strip()
    body = text[end_idx + 4:]  # skip the closing "\n---"
    try:
        fm = yaml.safe_load(yaml_text) or {}
    except yaml.YAMLError:
        fm = {}
    return (fm if isinstance(fm, dict) else {}), body


def _strip_auto_generated(body: str) -> str:
    """Cut the body at the first auto-rendered section heading (Members
    or Backlinks).  Everything before that point is LLM-authored narrative."""
    cuts: List[int] = []
    m = MEMBER_HEADING_RE.search(body)
    if m:
        cuts.append(m.start())
    m = BACKLINKS_HEADING_RE.search(body)
    if m:
        cuts.append(m.start())
    if cuts:
        return body[: min(cuts)]
    return body


# ─────────────────────────────────────────────────────────────────────────────
# Vault asset roster + member discovery
# ─────────────────────────────────────────────────────────────────────────────

def collect_vault_assets(vault: Path) -> Set[str]:
    """Enumerate every asset note under vault, excluding aggregates.

    Returns the union of (file stems, frontmatter titles).  Both are
    accepted as "this asset exists" — some assets get renamed and the
    title in frontmatter may diverge from the file stem temporarily."""
    assets: Set[str] = set()
    for md in vault.rglob("*.md"):
        if any(part in SKIP_VAULT_SUBDIRS for part in md.parts):
            continue
        if md.stem:
            assets.add(md.stem)
        try:
            fm, _ = _split_frontmatter(md.read_text(encoding="utf-8"))
            t = fm.get("title")
            if isinstance(t, str) and t.strip():
                assets.add(t.strip())
        except OSError:
            continue
    return assets


def collect_system_members(vault: Path) -> Dict[str, Set[str]]:
    """Build {system_id: {member_title, ...}} from frontmatter.tags across
    every asset note.  An asset can belong to multiple systems."""
    members: Dict[str, Set[str]] = defaultdict(set)
    for md in vault.rglob("*.md"):
        if any(part in SKIP_VAULT_SUBDIRS for part in md.parts):
            continue
        try:
            fm, _ = _split_frontmatter(md.read_text(encoding="utf-8"))
        except OSError:
            continue
        tags = fm.get("tags") or []
        if not isinstance(tags, list):
            continue
        title = (fm.get("title") if isinstance(fm.get("title"), str) else "") or md.stem
        for t in tags:
            if not isinstance(t, str):
                continue
            tag = t.lstrip("#").strip()
            if tag.startswith("system/"):
                sys_id = tag.split("/", 1)[1]
                if sys_id:
                    members[sys_id].add(title)
    return members


# ─────────────────────────────────────────────────────────────────────────────
# Narrative parsing
# ─────────────────────────────────────────────────────────────────────────────

def _looks_like_asset_name(name: str) -> bool:
    """True when the identifier follows UE asset prefix conventions.  The
    prefix gate keeps generic function-name tokens (`BeginPlay`, `OnHit`)
    out of the audit — those aren't asset references and would inflate
    the false-positive rate."""
    if not name or len(name) < 3:
        return False
    if name in VOCAB_TOKENS:
        return False
    return any(name.startswith(p) for p in ASSET_PREFIXES)


def extract_referenced_assets(narrative_body: str) -> Set[str]:
    """Pull every backticked or markdown-linked identifier from the LLM
    narrative section, filter to those matching asset-prefix convention.

    The dual scan (backticks AND md links) catches both common LLM
    output styles — Claude tends to backtick names; other models
    sometimes emit `[Name](path)` inline."""
    refs: Set[str] = set()
    for m in BACKTICK_IDENT_RE.finditer(narrative_body):
        name = m.group(1)
        if _looks_like_asset_name(name):
            refs.add(name)
    for m in MD_LINK_NAME_RE.finditer(narrative_body):
        name = m.group(1)
        if _looks_like_asset_name(name):
            refs.add(name)
    return refs


# ─────────────────────────────────────────────────────────────────────────────
# Audit logic
# ─────────────────────────────────────────────────────────────────────────────

def audit_one(
    system_path: Path,
    vault_assets: Set[str],
    system_members: Dict[str, Set[str]],
) -> Optional[Dict]:
    """Audit a single Systems/<id>.md narrative.  Returns the audit record
    or None when the file isn't a parseable system narrative."""
    try:
        text = system_path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, body = _split_frontmatter(text)
    system_id = (
        (fm.get("system_id") if isinstance(fm.get("system_id"), str) else "")
        or system_path.stem
    )
    title = (
        (fm.get("title") if isinstance(fm.get("title"), str) else "")
        or system_id
    )
    member_count = fm.get("member_count")
    if not isinstance(member_count, int):
        member_count = 0

    narrative = _strip_auto_generated(body)
    refs = extract_referenced_assets(narrative)
    members = system_members.get(system_id, set())

    in_scope = sorted(refs & members)
    out_of_scope = sorted((refs - members) & vault_assets)
    fabricated = sorted(refs - vault_assets)

    return {
        "system_id": system_id,
        "title": title,
        "member_count": member_count,
        "refs_total": len(refs),
        "in_scope_count": len(in_scope),
        "out_of_scope_count": len(out_of_scope),
        "fabricated_count": len(fabricated),
        "in_scope": in_scope,
        "out_of_scope": out_of_scope,
        "fabricated": fabricated,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────

def _verdict(rate: float) -> str:
    if rate < 1.0:
        return "production-ready (< 1%)"
    if rate < 5.0:
        return "needs prompt hardening (1–5%)"
    return "BLOCKING (>= 5%)"


def render_markdown_report(audits: List[Dict]) -> str:
    total_refs = sum(a["refs_total"] for a in audits)
    total_fab = sum(a["fabricated_count"] for a in audits)
    total_oos = sum(a["out_of_scope_count"] for a in audits)
    fab_rate = (total_fab / total_refs * 100.0) if total_refs else 0.0

    lines: List[str] = []
    lines.append("# AICartographer L1 narrative — anti-fabrication audit")
    lines.append("")
    lines.append(f"- Systems scanned: **{len(audits)}**")
    lines.append(f"- Total asset references in narratives: **{total_refs}**")
    lines.append(f"- Fabricated (not in vault): **{total_fab}**")
    lines.append(f"- Out-of-scope (in vault, not member of system): **{total_oos}**")
    lines.append(f"- Fabrication rate: **{fab_rate:.2f}%**")
    lines.append(f"- Verdict: **{_verdict(fab_rate)}**")
    lines.append("")
    lines.append("## Per-system breakdown")
    lines.append("")
    lines.append("| System | Members | Refs | In | OOS | Fab | Status |")
    lines.append("|---|---:|---:|---:|---:|---:|:---:|")

    def _row_sort(a: Dict) -> Tuple[int, int, str]:
        # Worst offenders first (most fabrications, then OOS, then alpha)
        return (-a["fabricated_count"], -a["out_of_scope_count"], a["system_id"])

    for a in sorted(audits, key=_row_sort):
        if a["fabricated_count"]:
            sym = "FAB"
        elif a["out_of_scope_count"]:
            sym = "OOS"
        else:
            sym = "OK"
        lines.append(
            f"| {a['title']} (`{a['system_id']}`) | "
            f"{a['member_count']} | {a['refs_total']} | "
            f"{a['in_scope_count']} | {a['out_of_scope_count']} | "
            f"{a['fabricated_count']} | {sym} |"
        )
    lines.append("")

    flagged = [a for a in audits if a["fabricated_count"] or a["out_of_scope_count"]]
    if flagged:
        lines.append("## Flagged systems")
        lines.append("")
        for a in sorted(flagged, key=_row_sort):
            lines.append(f"### {a['title']} (`{a['system_id']}`)")
            lines.append("")
            if a["fabricated"]:
                lines.append("**Fabricated** (not in vault — pure invention):")
                lines.append("")
                for n in a["fabricated"]:
                    lines.append(f"- `{n}`")
                lines.append("")
            if a["out_of_scope"]:
                lines.append(
                    "**Out-of-scope** (in vault but NOT a member of this system "
                    "— fine if mentioned in EXTERNAL COUPLING, suspicious "
                    "elsewhere):"
                )
                lines.append("")
                for n in a["out_of_scope"]:
                    lines.append(f"- `{n}`")
                lines.append("")

    return "\n".join(lines) + "\n"


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Audit L1 system narratives for fabrication.",
    )
    ap.add_argument(
        "project_root",
        help="Path to the UE project root (containing .aicartographer/).",
    )
    ap.add_argument(
        "--out",
        default="vault-audit.md",
        help="Output markdown report path (default: vault-audit.md).",
    )
    ap.add_argument(
        "--json",
        dest="json_out",
        default=None,
        help="Optional JSON dump path for programmatic consumption.",
    )
    args = ap.parse_args()

    project_root = Path(args.project_root).resolve()
    vault = project_root / VAULT_REL
    systems_dir = vault / "Systems"
    if not systems_dir.exists():
        print(f"[audit] no Systems/ dir at {systems_dir}", file=sys.stderr)
        return 2

    print(f"[audit] vault: {vault}")
    print(f"[audit] enumerating assets…")
    vault_assets = collect_vault_assets(vault)
    print(f"[audit] vault assets: {len(vault_assets)}")

    print(f"[audit] indexing system membership…")
    system_members = collect_system_members(vault)
    print(f"[audit] systems with members: {len(system_members)}")

    audits: List[Dict] = []
    for md in sorted(systems_dir.glob("*.md")):
        rec = audit_one(md, vault_assets, system_members)
        if rec is not None:
            audits.append(rec)
    print(f"[audit] systems audited: {len(audits)}")

    report = render_markdown_report(audits)
    out_path = Path(args.out).resolve()
    out_path.write_text(report, encoding="utf-8")
    print(f"[audit] wrote report: {out_path}")

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(audits, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[audit] wrote JSON: {args.json_out}")

    total_refs = sum(a["refs_total"] for a in audits)
    total_fab = sum(a["fabricated_count"] for a in audits)
    fab_rate = (total_fab / total_refs * 100.0) if total_refs else 0.0
    print(
        f"[audit] {total_fab}/{total_refs} fabricated = {fab_rate:.2f}% "
        f"({_verdict(fab_rate)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
