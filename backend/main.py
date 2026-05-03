from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
import redis.asyncio as redis
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
from tenacity import retry, retry_if_exception_type, wait_exponential, stop_after_attempt, RetryError
import json
import os
import re
import time
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Optional, Union, Any, Literal

import vault_writer
from llm_providers import (
    LLMProvider, build_provider, mask_key, EFFORT_TO_BUDGET, LLMResponse,
)

# Default per-request concurrency cap.  Frontend may override via
# provider_config.concurrency (bounded to MAX_CONCURRENCY for safety —
# providers will rate-limit before that, but we don't want runaway tasks).
DEFAULT_CONCURRENCY = 20
MAX_CONCURRENCY = 64

# Per-LLM-call timeout in seconds.  Single-node calls and batch worker calls
# both go through asyncio.wait_for(..., timeout=PER_NODE_TIMEOUT).
PER_NODE_TIMEOUT = 90.0

# Retry policy for transient provider failures (429, 500, 502, 503, 504,
# socket timeouts).  We wrap the analyze() call in tenacity so a noisy hour
# from the provider doesn't trash a 1k-node batch.
RETRY_ATTEMPTS = 4
RETRY_WAIT = wait_exponential(multiplier=1, min=1, max=30)

redis_client: Optional[redis.Redis] = None

DEFAULT_VOCAB_PATH = Path(__file__).parent / "tag_vocabulary_default.json"

# ─────────────────────────────────────────────────────────────────────────────
# System prompt — outputs structured metadata block, then markdown body
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a senior Unreal Engine 5 systems architect.

You will receive a Blueprint's STRUCTURE (functions, properties, components,
class dependencies — extracted via C++ Reflection so the names are
authoritative) and its RUNTIME GRAPH (K2Node walk of who-calls-who within the
project). Your job is to NARRATE the runtime behaviour over that structure,
not to re-extract it.

Produce TWO sections in this exact order — no preamble, no closing remarks.

[METADATA]
{
  "intent": "<one sentence describing the core purpose>",
  "system": ["<pick 1-3 from system axis>"],
  "layer": "<pick exactly 1 from layer axis>",
  "role": "<pick exactly 1 from role axis>",
  "risk_level": "<nominal | warning | critical>"
}
[/METADATA]

[ANALYSIS]
### [ INTENT ]
(One sentence. State the runtime problem this BP solves for the gameplay loop —
not what it contains. Bad: "Manages the player". Good: "Owns the player's
movement-input → animation-state pipeline so AI can drive the same character
class without reimplementing locomotion".)

### [ EXECUTION FLOW ]
(3-6 sentences of prose. Pick the dominant entry point (BeginPlay, Tick, a
named event, the most-called public function) and trace the runtime path through
specific NAMED nodes: "BeginPlay → SpawnDefaultWeapon → casts result into
CurrentWeapon → broadcasts OnWeaponEquipped → BP_HUD listens and updates the
ammo widget". Explain what state mutates and what triggers downstream. Do NOT
bullet a list of nodes — write as prose.)

### [ MEMBER INTERACTIONS ]
(For each non-trivial member, one bullet: what it does + who calls/reads/writes
it. Reference functions, properties, and dispatchers BY NAME from the provided
inventory. Skip pure getters and trivial passthrough setters. Example shapes:
- `OnDamageReceived` (event): broadcast when `CurrentHP` <= 0; consumed by
  `BP_GameMode.HandleDeath` and the death-screen widget.
- `EquipWeapon(weaponClass)` [BlueprintCallable]: spawns the actor, attaches it
  to `WeaponSocket`, casts the result into `CurrentWeapon`. Called from
  `BP_PlayerController.OnFireInput`.
- `bIsAirborne` [Replicated, BlueprintReadOnly]: written by `LandedHandler` on
  the server; read by the AnimBP's locomotion state machine.
The point is the *graph of calls*, not a member catalog.)

### [ EXTERNAL COUPLING ]
(Bullet the cross-blueprint relationships. Use the provided "Implements
interfaces" / "Hard refs" / "Soft refs" lists AS YOUR SOURCE for interface
contracts and class-level coupling; use the K2 graph edges for the actual
call-site direction. Name the other blueprint or interface explicitly with the
edge type — spawn / cast / interface_call / listens_to. If this BP is
self-contained, write "Self-contained.")

### [ ARCHITECTURAL RISK ]
(Performance bottlenecks, broken contracts, race conditions, god-object
tendencies, unguarded casts, replication smell. Tie each risk to a SPECIFIC
named member or edge. Examples:
- "Unguarded `Cast<BP_Player>` in `OnOverlapBegin` — overlapping a non-player
  pawn returns null and silently no-ops the trigger."
- "Tick reads + writes `BroadcastHealth` every frame — collapse to broadcast
  on threshold instead."
If none, output "No notable risks.")
[/ANALYSIS]

CONTROLLED VOCABULARY — pick tag values only from these lists:
- system axis: gameplay-core, combat, ai, animation, physics, network, multiplayer-meta, ui, audio, vfx, cinematic, camera, input, world, spawn, persistence, progression, economy, analytics, tooling
- layer axis: gameplay, framework, ui, data, service, tooling
- role axis: actor, component, widget, controller, gamemode, gamestate, playerstate, subsystem, interface, function-library, data-asset, data-table, struct, enum, animation-blueprint, behavior-tree

NON-NEGOTIABLE RULES
- ANTI-FABRICATION: every function / property / dispatcher / interface name
  you reference MUST appear verbatim in the provided STRUCTURE block. If a
  name is not listed, do NOT invent it. When you're unsure, prefer "the
  spawn-handling code path" over a guessed function name.
- Tone: precise, professional, factual. No conversational fluff, no marketing
  language.
- Do NOT restate the inventory — the user is reading the .md alongside this
  analysis and already sees the function / property tables. Your value is the
  NARRATIVE, not duplication.
- The `system` array MUST contain AT LEAST ONE entry — never empty `[]`.
  A blueprint may legitimately span multiple systems — list up to 3, most
  dominant first.  If a BP genuinely fits no specialised axis (utility libs,
  generic data assets, glue code), use `["gameplay-core"]` as the catch-all.
  Returning `system: []` is a contract violation and will be rejected.
- Do not invent tag values — pick ONLY from the vocabulary list above.
  If multiple are plausible, pick the one matching the asset's folder when
  obvious (`/Game/UI/...` → `ui`, `/Game/Combat/...` → `combat`), otherwise
  pick by what the BP actually does at runtime.
- METADATA block must be valid JSON.
- When STRUCTURE shows "(none)" for a section (e.g. no events), the
  corresponding bullet in MEMBER INTERACTIONS may be omitted — don't pad with
  speculation.
- DATA-ONLY ASSETS (DataTable, UDataAsset subclasses): Functions / Events /
  Dispatchers / Components / K2 graph edges will all show "(none)" — these
  assets have no runtime execution path. For these:
  · EXECUTION FLOW: write one factual sentence stating the asset is data-only
    and is read by callers at runtime (e.g. "Data-only asset — no execution
    flow. Read by callers via DataTable RowMap / DataAsset CDO at runtime.")
  · MEMBER INTERACTIONS: describe the data shape (row struct, key properties)
    rather than call patterns.
  · EXTERNAL COUPLING: focus on what consumes this asset based on hard_refs
    that point INTO this asset (those won't appear in the prompt — note this
    as "consumed by external systems via hard_ref").
  · Don't fabricate a flow. Saying "no execution flow" is correct and
    valuable here.
"""


# ─────────────────────────────────────────────────────────────────────────────
# L1 (project-level) system prompt — runs once per project, after all L2 scans.
# Input: per-blueprint metadata + asset reference graph.  Output: system
# clustering, hubs, cross-system edges, project-level narrative.
# ─────────────────────────────────────────────────────────────────────────────

L1_SYSTEM_PROMPT = """You are a senior Unreal Engine 5 systems architect with deep expertise
in gameplay framework design, blueprint orchestration, and architectural risk analysis.
You have just received per-blueprint metadata for an entire UE5 project, plus the
asset reference graph between blueprints. Your task is to synthesize this into a
coherent system-level architecture report.

INPUT
You will receive a JSON object with this shape:
{
  "project_root": "...",
  "blueprints": [
    {
      "node_id": "BP_PlayerCharacter",
      "asset_path": "/Game/...",
      "intent": "<one sentence from L2>",
      "system": ["combat", "input"],
      "layer": "gameplay",
      "role": "actor",
      "risk_level": "nominal | warning | critical",
      "outbound_edges": [
        {"target": "BP_WeaponBase", "edge_type": "spawn"}
      ]
    }
  ]
}

OUTPUT — produce TWO sections in this exact order, no preamble:

[METADATA]
{
  "systems": [
    {
      "id": "<lowercase-slug, e.g. combat-loop>",
      "axis": "<one value from system axis vocab>",
      "title": "<human-readable title, e.g. Combat Loop>",
      "members": ["<asset_path>", ...],
      "hub": "<asset_path of the central blueprint, or null>",
      "risk_level": "<max severity among members: nominal|warning|critical>"
    }
  ],
  "cross_system_edges": [
    {"from": "<system_id>", "to": "<system_id>", "weight": <int>}
  ],
  "project_risk_level": "nominal | warning | critical"
}
[/METADATA]

[ANALYSIS]
### [ PROJECT SYSTEM MAP ]
(2-4 sentences. Identify the dominant gameplay loop and how systems compose to
drive it. Name the load-bearing hubs that span multiple systems. State the
framework's overall architectural posture factually.)

### [ {SYSTEM TITLE 1} ]
- Intent: (1 sentence stating what runtime problem this system solves for the gameplay loop.)
- Composition: (Describe how members collaborate as prose, not a member list. Name
  concrete pairs of interactions that drive this system, e.g. "BP_PlayerCharacter
  spawns BP_WeaponBase via EquipWeapon, and forwards input through the
  IWeaponInterface; BP_GameMode listens to OnPlayerDeath broadcast from
  BP_HealthComponent." 2-4 sentences. Skip the inventory — the .md frontmatter
  already lists members.)
- Critical Path: (Trace the system's main runtime flow through specific named
  members. Identify the hub blueprint and explain why the others converge on it,
  or state "no clear hub" with a one-line reason.)
- Risk: (Cross-member risk patterns: god-object hubs, missing decoupling, brittle
  contracts, cyclic event broadcasts. If none, "No notable risks.")

### [ {SYSTEM TITLE 2} ]
...

### [ CROSS-SYSTEM COUPLING ]
(For each cross_system_edge with weight >= 2, describe the relationship between
the two systems in one sentence — name the typical edge kind driving it
(spawn / interface_call / cast / listens_to) and which blueprints sit on each end.
Flag cycles, god-object hubs, layering violations. If clean, output "No notable
coupling issues.")
[/ANALYSIS]

CONTROLLED VOCABULARY — system axis values must come from this list (same as L2):
gameplay-core, combat, ai, animation, physics, network, multiplayer-meta, ui, audio,
vfx, cinematic, camera, input, world, spawn, persistence, progression, economy,
analytics, tooling

RULES
- Cluster blueprints into 3-8 systems. Avoid single-member systems unless the blueprint
  is genuinely standalone (subsystem, persistent manager); otherwise fold it into the
  closest larger system.
- A blueprint MAY appear in multiple systems' members lists when it legitimately spans
  them (e.g. a weapon BP may belong to both "combat" and "spawn"). Use the L2 system
  tags as the primary signal for multi-membership.
- cross_system_edges: only emit edges where weight >= 2 (at least two outbound edges
  from system A to system B). Compute weight by counting outbound_edges from members
  of A whose target resolves to a member of B.
- METADATA must be valid JSON. The "members" list must contain asset_path strings
  exactly as they appear in the input.
- Tone: precise, professional, factual. No conversational fluff, no marketing language.
- Do not invent vocabulary values. If unsure, pick the closest from the list.
"""

# ─────────────────────────────────────────────────────────────────────────────
# L1 (per-system) — analyses ONE system in isolation given its members'
# already-tagged L2 metadata.  Replaces the old project-wide clustering pass:
# the L2 prompt now produces system tags directly (controlled vocab), and L1's
# job becomes "narrate this single system's internal architecture" rather than
# "decide which BPs cluster together".  Batch L1 = loop this over discovered
# system tags.  See HANDOFF Phase 2 refactor.
# ─────────────────────────────────────────────────────────────────────────────

L1_SYSTEM_SCOPED_PROMPT = """You are a senior Unreal Engine 5 systems architect.

You will receive metadata for ONE system in a UE5 project — a set of blueprints
that share the same `system` tag (e.g. "combat", "input", "ui") assigned by the
L2 pass. Your job is to narrate THIS system's internal architecture: how its
members interact at runtime, what external systems it depends on, and what
risks live within it.

INPUT
You will receive a JSON object with this shape:
{
  "system_id": "combat",
  "members": [
    {
      "node_id": "BP_PlayerCharacter",
      "asset_path": "/Game/...",
      "title": "BP_PlayerCharacter",
      "node_type": "Blueprint",
      "intent": "<one sentence from L2>",
      "layer": "gameplay",
      "role": "actor",
      "risk_level": "nominal | warning | critical",
      "outbound_edges": [
        {"target": "BP_WeaponBase", "edge_type": "spawn", "in_system": true},
        {"target": "BP_HUDWidget", "edge_type": "function_call", "in_system": false}
      ]
    },
    ...
  ]
}

`in_system: true` means the edge target is a member of THIS system; `false`
means it points outside (likely to another system). Use this distinction to
separate INTERNAL CALL FLOW from EXTERNAL COUPLING.

OUTPUT — produce TWO sections in this exact order, no preamble:

[METADATA]
{
  "system_id": "<input system_id verbatim>",
  "title": "<2-4 word human-readable title, e.g. 'Combat Loop'>",
  "intent": "<one sentence describing what runtime problem this system OWNS>",
  "system_risk_level": "<nominal | warning | critical>",
  "hub": "<asset_path of THE central blueprint that other members converge on, OR null if the system has no clear hub (e.g. a flat collection of independent helpers)>",
  "external_dependencies": [
    {"target_system": "<other system tag the L2 vocab uses>",
     "via": "function_call | spawn | listens_to | interface_call | cast",
     "examples": ["<member name within THIS system that drives the edge>", ...]}
  ]
}
[/METADATA]

[ANALYSIS]
### [ INTENT ]
(One sentence: this system's runtime responsibility for the gameplay loop.)

### [ MEMBERS ]
(For each member, one bullet: `BP_Foo (role)` — one-sentence runtime role
within THIS system. Reference at most 8 members; if there are more, group the
trailing ones as "...plus N similar role-X helpers".)

### [ INTERNAL CALL FLOW ]
(2-4 sentences of prose tracing how members interact at runtime. Pick the
dominant entry member (likely the gameplay-facing actor / controller) and
trace 2-3 hops through `in_system: true` edges only. Name members verbatim
from the input.)

### [ EXTERNAL COUPLING ]
(Bullet list. For each entry in METADATA.external_dependencies, one line
naming the other system, the edge type, and which members of THIS system
participate. If self-contained, write "Self-contained.")

### [ ARCHITECTURAL RISK ]
(Bullet list of risks tied to specific named members of THIS system. If
none, "No notable risks.")
[/ANALYSIS]

NON-NEGOTIABLE RULES
- ANTI-FABRICATION: every member name / edge target you reference MUST
  appear verbatim in the input. Don't invent.
- This is a SINGLE-SYSTEM analysis. Don't catalogue the whole project.
- METADATA must be valid JSON.
- Tone: precise, professional, factual.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Language directive — appended to system prompts when provider_config.language
# == "zh". Vocabulary tag values stay English (they're consumed as keys by the
# frontend); only the human-readable narrative shifts to Chinese.
# ─────────────────────────────────────────────────────────────────────────────

_LANGUAGE_DIRECTIVE_ZH = """\

[OUTPUT LANGUAGE]
请使用简体中文撰写所有叙事性文本：
- METADATA 块中 `intent` / `title` 字段必须为简体中文。
- ANALYSIS 块中所有 ###  标题下的正文必须为简体中文。
- ★ 例外：以下内容保持英文 / 原样不译（它们是前端解析所用的键或资产标识）：
  · 受控词表取值（system axis / layer / role / risk_level / id slug 等）
  · JSON 字段名、asset_path、blueprint / function / variable / dispatcher 等标识符
  · `### [ ... ]` 章节标题（INTENT / EXECUTION FLOW / MEMBER INTERACTIONS / EXTERNAL COUPLING / ARCHITECTURAL RISK / PROJECT SYSTEM MAP / CROSS-SYSTEM COUPLING）保持英文，正文用中文。
  · 项目系统标题（### [ {SYSTEM TITLE} ] 中的 SYSTEM TITLE）按 METADATA 里 `title` 字段一致输出（中文）。
- 中文风格：技术、克制、不加感叹号或营销腔。叙事要具体——直接点名"BP_X 调用 BP_Y 的 Z 函数"，不要写"它会调用相关组件"这种模糊表述。
"""


def _apply_language(system_prompt: str, language: Optional[str]) -> str:
    """Append a language directive to the system prompt. No-op for None / 'en'."""
    if language == "zh":
        return system_prompt.rstrip() + "\n" + _LANGUAGE_DIRECTIVE_ZH
    return system_prompt


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

class EdgePayload(BaseModel):
    target: str
    edge_type: str = "function_call"
    refs: List[str] = []
    label: Optional[str] = None


class ASTNodePayload(BaseModel):
    node_id: str
    asset_path: str
    title: Optional[str] = None
    node_type: str = "Blueprint"
    parent_class: Optional[str] = None
    ast_data: Optional[Dict] = None
    outbound_edges: List[EdgePayload] = []


class ProviderConfig(BaseModel):
    """Per-request LLM provider config — never persisted server-side.

    The frontend stores this in localStorage and ships it with every scan
    request.  We build the provider, run the call, and discard the dict.
    """
    provider: Literal["volcengine", "claude", "openai_compat"]
    api_key: str
    endpoint: Optional[str] = None       # volcengine: model endpoint id (ep-...)
    model: Optional[str] = None          # claude: short name or canonical id
                                          # openai_compat: arbitrary model id
    effort: Optional[str] = None         # claude: low|medium|high|extra_high|max
    base_url: Optional[str] = None       # openai_compat: full /v1 base URL
    concurrency: Optional[int] = None    # batch worker pool size override
    language: Optional[Literal["en", "zh"]] = None  # narrative output language


class BatchScanRequest(BaseModel):
    nodes: List[ASTNodePayload]
    project_root: Optional[str] = None
    provider_config: ProviderConfig


class SingleScanRequest(BaseModel):
    node: ASTNodePayload
    project_root: str
    provider_config: ProviderConfig


class TestConnectionRequest(BaseModel):
    provider_config: ProviderConfig


class L1ScanRequest(BaseModel):
    """Project-level clustering pass.  Backend reads existing L2 metadata from
    the vault; the request body only needs project_root + provider_config."""
    project_root: str
    provider_config: ProviderConfig


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    total_nodes: int
    completed_nodes: int
    failed_nodes: int
    skipped_nodes: int = 0
    node_statuses: Dict[str, str] = {}
    # Per-node failure reasons.  Populated only for FAILED entries — the
    # exception message at the analyze_one_node level (LLM error / parse
    # error / vault writer error).  Kept in a separate dict so the existing
    # node_statuses contract stays a flat str→str map.
    node_errors: Dict[str, str] = {}
    # Task-level error (e.g. provider init failed before any node ran).
    error: Optional[str] = None


class WriteNotesRequest(BaseModel):
    project_root: str
    relative_path: str
    content: str


# ─────────────────────────────────────────────────────────────────────────────
# LLM response parser (unchanged from prior version)
# ─────────────────────────────────────────────────────────────────────────────

_METADATA_RE = re.compile(r"\[METADATA\](.*?)\[/METADATA\]", re.DOTALL)
_ANALYSIS_RE = re.compile(r"\[ANALYSIS\](.*?)\[/ANALYSIS\]", re.DOTALL)


def _strip_md_fences(text: str) -> str:
    """Remove markdown code fences (``` and ```json) from anywhere in a
    string.  Used both as a pre-filter and to clean fence-wrapped JSON
    that some models put INSIDE [METADATA]...[/METADATA] tags."""
    text = re.sub(r"```[a-zA-Z]*\s*\n", "", text)
    text = re.sub(r"\n```", "", text)
    return text.strip()


def _extract_metadata_block(raw: str) -> Optional[str]:
    """Find a JSON METADATA block in an LLM response, tolerating the four
    most common formatting deviations we've seen in the wild from
    OpenAI-compatible providers (DeepSeek, Qwen, Claude-via-LiteLLM, …):

    1) Strict ``[METADATA]...[/METADATA]`` form (what the prompt asks for).
    2) The same form, but with markdown code fences INSIDE the tags —
       i.e. ``[METADATA]\\n```json\\n{...}\\n```\\n[/METADATA]``.  Common
       output shape from Claude when asked for structured JSON inside a
       human-readable wrapper; the model treats the JSON as "code" and
       fences it.
    3) The whole METADATA block wrapped in code fences from the outside
       (``` ```json\\n[METADATA]...[/METADATA]\\n``` ```).
    4) Tags dropped entirely — model just emits the bare JSON object.

    Returns the JSON-text (suitable for ``json.loads``) or ``None`` when
    nothing parse-worthy turns up.
    """
    # (1) Strict tags — but ALWAYS strip fences from the captured content
    #     before returning.  This solves case (2) above: a model that puts
    #     ```json…``` INSIDE [METADATA]…[/METADATA] would previously match
    #     here and immediately fail json.loads on the fence chars.
    m = _METADATA_RE.search(raw)
    if m:
        return _strip_md_fences(m.group(1))

    # (3) Strip outer fences and retry.
    cleaned = _strip_md_fences(raw)
    m = _METADATA_RE.search(cleaned)
    if m:
        return _strip_md_fences(m.group(1))

    # (3) Bare-JSON fallback — find the first balanced {...} that parses.
    start = cleaned.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(cleaned)):
        c = cleaned[i]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                cand = cleaned[start:i + 1]
                try:
                    json.loads(cand)
                    return cand
                except json.JSONDecodeError:
                    return None
    return None

# Allowed system axis values — must stay in sync with the SYSTEM_PROMPT
# vocabulary block.  Used as a guard against weak LLMs that hallucinate tag
# values like "blueprint" or "core" that aren't in the controlled list.
_SYSTEM_AXIS_VOCAB = frozenset({
    "gameplay-core", "combat", "ai", "animation", "physics", "network",
    "multiplayer-meta", "ui", "audio", "vfx", "cinematic", "camera", "input",
    "world", "spawn", "persistence", "progression", "economy", "analytics",
    "tooling",
})


def parse_llm_response(raw: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "intent": None, "tags": [], "risk_level": "nominal",
        "analysis_markdown": raw, "parse_ok": False,
    }
    md_text = _extract_metadata_block(raw)
    body_match = _ANALYSIS_RE.search(raw)

    if md_text:
        try:
            md_obj = json.loads(md_text)
            out["intent"] = md_obj.get("intent")
            risk = (md_obj.get("risk_level") or "nominal").lower()
            if risk not in ("nominal", "warning", "critical"):
                risk = "nominal"
            out["risk_level"] = risk
            tags: List[str] = []
            # Filter LLM-output system tags through the vocabulary guard so
            # weak models that ignore the controlled list don't pollute the
            # frontmatter with junk axes (Cropout demo: volcengine doubao
            # was emitting "blueprint", "characters" etc. that broke L1
            # batch's system_id discovery).
            llm_systems_raw = md_obj.get("system") or []
            llm_systems_clean = [
                str(s).strip().lower() for s in llm_systems_raw
                if isinstance(s, str) and str(s).strip().lower() in _SYSTEM_AXIS_VOCAB
            ]
            for s in llm_systems_clean[:3]:
                tags.append(f"#system/{s}")
            if md_obj.get("layer"):
                tags.append(f"#layer/{md_obj['layer']}")
            if md_obj.get("role"):
                tags.append(f"#role/{md_obj['role']}")
            out["tags"] = tags
            # Stash whether the LLM actually produced a usable system tag —
            # the caller (analyze_one_node) uses this to decide whether to
            # apply a path-derived fallback before writing the file.
            out["had_system_tag"] = len(llm_systems_clean) > 0
            out["parse_ok"] = True
        except (json.JSONDecodeError, AttributeError) as e:
            print(f"[SYS_WARN] METADATA block malformed: {e}")

    if body_match:
        out["analysis_markdown"] = body_match.group(1).strip()

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Provider call wrapper — applies tenacity retry + per-call timeout
# ─────────────────────────────────────────────────────────────────────────────

class LLMRetryableError(Exception):
    """Raised by call_llm_with_retry when the underlying call failed in a way
    that's worth retrying (rate limit, timeout, 5xx).  Tenacity catches this."""


@retry(
    retry=retry_if_exception_type(LLMRetryableError),
    wait=RETRY_WAIT,
    stop=stop_after_attempt(RETRY_ATTEMPTS),
    reraise=True,
)
async def _call_with_retry(
    provider: LLMProvider,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 4096,
) -> LLMResponse:
    try:
        return await asyncio.wait_for(
            provider.analyze(system_prompt, user_prompt, max_tokens=max_tokens),
            timeout=PER_NODE_TIMEOUT,
        )
    except asyncio.TimeoutError as e:
        raise LLMRetryableError(f"LLM call timeout after {PER_NODE_TIMEOUT}s") from e
    except Exception as e:
        # Heuristic: assume HTTP-style error message contains a retryable status.
        msg = str(e).lower()
        if any(t in msg for t in ("429", "rate", "500", "502", "503", "504", "overloaded", "timeout", "connection")):
            raise LLMRetryableError(str(e)) from e
        raise


async def call_llm(
    provider: LLMProvider,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 4096,
) -> LLMResponse:
    """Call the provider with retry + timeout.  Non-retryable errors propagate.

    `max_tokens` defaults to 4096 — sufficient for L2 single-blueprint
    analysis.  L1 system synthesis runs longer (multi-BP narrative + larger
    METADATA payload) AND reasoning models (DeepSeek-R1, o1, QwQ) burn
    additional tokens on chain-of-thought before the final answer; callers
    in those paths should pass max_tokens=8192 or higher.
    """
    try:
        return await _call_with_retry(provider, system_prompt, user_prompt, max_tokens=max_tokens)
    except RetryError as e:
        # Surface the underlying cause for cleaner error messages.
        cause = e.last_attempt.exception() if e.last_attempt else e
        raise RuntimeError(f"LLM call exhausted retries: {cause}") from cause


# ─────────────────────────────────────────────────────────────────────────────
# Single-node analyze pipeline — shared by /scan/single and the batch worker.
# Pure function: caller supplies provider; we run prompt → parse → vault write
# and return the parsed result.  No Redis state mutation here.
# ─────────────────────────────────────────────────────────────────────────────

# §24 cost optimization #2 — data-only assets (DataTable, UDataAsset subclasses)
# never have a meaningful execution flow.  Their answer to the LLM prompt is
# always some variant of "Data-only asset — no execution flow" (see the
# DATA-ONLY ASSETS clause in SYSTEM_PROMPT).  Burning ~2k tokens per call to
# get a templated answer is wasteful — short-circuit with a deterministic
# template instead.  Saves ~14 LLM calls × ~2k tokens = ~28k tokens per full
# Cropout scan, on top of the prompt-cache savings.
#
# When this short-circuit fires we log [DATA_ONLY_TEMPLATE] so cost auditing
# can see how many calls were saved per scan run.

# Vocabulary used by the templated analysis_markdown — matches the
# `node_type → role` mapping in SYSTEM_PROMPT's controlled list.
_DATA_ONLY_NODE_TYPES = frozenset({"DataAsset", "DataTable"})


def _build_data_only_parsed(node: ASTNodePayload) -> Dict[str, Any]:
    """Build a templated `parsed` dict for a data-only asset, matching the
    shape `parse_llm_response` would return on a successful LLM run.

    System tag is intentionally left empty — the path-derived fallback below
    fills it the same way it would for a real LLM response with a missing
    `#system/...`, so DT_Jobs still ends up under the right system bucket.
    """
    is_table = node.node_type == "DataTable"
    role = "data-table" if is_table else "data-asset"

    if is_table:
        intent = (
            f"Static row table read by callers via DataTable RowMap at runtime; "
            f"no execution flow."
        )
        flow = (
            "Data-only asset — no execution flow. Rows are read by callers "
            "via `UDataTable::FindRow` / `GetRowMap` at runtime."
        )
    else:
        intent = (
            f"Data asset providing static configuration; read by callers via "
            f"the CDO at runtime; no execution flow."
        )
        flow = (
            "Data-only asset — no execution flow. The CDO is loaded by callers "
            "(typically through `TSoftObjectPtr` resolution or direct hard ref) "
            "and its properties are read at runtime."
        )

    markdown = (
        f"### [ INTENT ]\n{intent}\n\n"
        f"### [ EXECUTION FLOW ]\n{flow}\n\n"
        f"### [ MEMBER INTERACTIONS ]\n"
        f"Refer to the Properties block below for the data shape; this asset "
        f"has no functions, events, or dispatchers (data-only).\n\n"
        f"### [ EXTERNAL COUPLING ]\n"
        f"Consumed by external systems via `hard_ref` — see `hard_refs` in the "
        f"frontmatter for outbound references this asset declares; the inbound "
        f"side (who reads this asset) is surfaced via Lv4 CallTrace once "
        f"reverse-edge indexing lands.\n\n"
        f"### [ ARCHITECTURAL RISK ]\nNo notable risks.\n"
    )

    # `tags` only carries layer + role here.  System tag is added by the
    # path-derived fallback in analyze_one_node — same code path the LLM
    # response takes when the model fails to emit a `#system/...`.
    return {
        "intent": intent,
        "tags": [f"#layer/data", f"#role/{role}"],
        "risk_level": "nominal",
        "analysis_markdown": markdown,
        "parse_ok": True,
        "had_system_tag": False,
    }


async def analyze_one_node(
    provider: LLMProvider,
    node: ASTNodePayload,
    project_root: Optional[str],
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Returns: {parsed: ..., write_result: {...} | None, llm_response: LLMResponse}"""
    user_prompt = _build_user_prompt(node)
    system_prompt = _apply_language(SYSTEM_PROMPT, language)

    # §24 #2 — data-only short-circuit.  Skip the LLM call entirely for
    # DataTable / UDataAsset subclasses; their narrative is templated.  The
    # rest of the function (path-fallback for system tag, vault write) runs
    # unchanged so the .md ends up shaped identically to an LLM-generated one.
    if node.node_type in _DATA_ONLY_NODE_TYPES:
        parsed = _build_data_only_parsed(node)
        # Synthesize an LLMResponse so callers (batch worker, /scan/single)
        # don't crash when reading `result["llm_response"].tokens_in`.  Zero
        # tokens reflects reality — we never made the call.  (LLMResponse is
        # already imported at module top; no local import needed.)
        llm_response = LLMResponse(
            raw_text=parsed["analysis_markdown"],
            tokens_in=0,
            tokens_out=0,
            thinking_tokens=0,
            model="(template)",
            extra={"data_only_template": True, "node_type": node.node_type},
        )
        print(
            f"[DATA_ONLY_TEMPLATE] {node.asset_path} ({node.node_type}) — "
            f"skipped LLM call, used template (saved ~2k tokens)"
        )
    else:
        llm_response = await call_llm(provider, system_prompt, user_prompt)
        parsed = parse_llm_response(llm_response.raw_text)

        # §24 #1 — log Anthropic prompt-cache telemetry.  In a healthy batch
        # scan the first node pays cache_creation, every subsequent node hits
        # cache_read.  If cache_read stays 0 across a batch, a silent
        # invalidator is at work — see shared/prompt-caching.md audit table.
        cache_read   = (llm_response.extra or {}).get("cache_read_input_tokens", 0) or 0
        cache_create = (llm_response.extra or {}).get("cache_creation_input_tokens", 0) or 0
        if cache_read or cache_create:
            print(
                f"[CACHE] {node.asset_path} "
                f"in={llm_response.tokens_in} "
                f"cache_read={cache_read} "
                f"cache_create={cache_create} "
                f"out={llm_response.tokens_out}"
            )

    # Path-derived system fallback — when the LLM gives us no usable system
    # tag (weak instruction-following on Cropout demo: volcengine doubao
    # was emitting empty `system: []` for ~92% of BPs), fall back to the
    # first folder under `/Game/`.  Lowercased to match the controlled-vocab
    # convention so frontend cardwall / L1 batch see consistent tags.  Without
    # this, the BP lands in the `_unassigned` bucket and L1 batch never sees
    # it as a member of any system.  Applied whether parse_ok or not — even a
    # malformed LLM response shouldn't strand the BP outside any system.
    #
    # §23 hardening: the fallback now gates on _SYSTEM_AXIS_VOCAB so junk
    # folder names ("Blueprint", "Villagers", "Core") don't leak into the
    # tag space.  Pre-§23 the BTT_StuckRecover under /Game/Blueprint/Villagers
    # got tagged `#system/blueprint` (not in vocab) which then surfaced an
    # empty Systems/blueprint.md.  Phase B (§22.5 #4) DataTable/DataAsset
    # support amplifies the issue — DT_Jobs lives at /Game/Blueprint/Villagers
    # too, so without this guard every new data asset would inherit the same
    # junk axis.
    has_system = any(t.startswith("#system/") for t in (parsed.get("tags") or []))
    if not has_system:
        m = re.match(r"^/Game/([^/]+)/", node.asset_path or "")
        folder = m.group(1).lower().strip() if m else ""
        fallback_axis = folder if folder in _SYSTEM_AXIS_VOCAB else "gameplay-core"
        # System tags must come first so existing `tags[0].startswith("#system/")`
        # callers stay happy.
        system_tag = f"#system/{fallback_axis}"
        rebuilt = [system_tag]
        for t in parsed.get("tags") or []:
            if not t.startswith("#system/"):
                rebuilt.append(t)
        parsed["tags"] = rebuilt
        print(
            f"[SYS_FALLBACK] {node.asset_path} got no usable system tag — "
            f"falling back to path-derived '{fallback_axis}' "
            f"(folder='{folder}', vocab_hit={folder in _SYSTEM_AXIS_VOCAB}, "
            f"parse_ok={parsed.get('parse_ok')})"
        )

    write_result = None
    if project_root:
        title = node.title or node.asset_path.split("/")[-1].split(".")[-1] or node.node_id
        # Pull structured AST fields out of ast_data so write_node_file can
        # persist them in the frontmatter `exports`, `components`, `variables`,
        # `properties`, `function_flags`, `class_dependencies` blocks.  The
        # frontend (both batch and single-node paths) ships these under the
        # same keys; missing keys are tolerated and default to [] / {}.
        # Without this propagation the LLM scan wipes the framework-scan
        # skeleton's reflection blocks — which is the bug §15 documents,
        # extended in §21.5 (A2) to cover properties/flags/deps.
        ast = node.ast_data if isinstance(node.ast_data, dict) else {}
        class_deps_raw = ast.get("class_dependencies") or {}
        class_deps: Dict[str, List[str]] = {}
        if isinstance(class_deps_raw, dict):
            for axis in ("hard_refs", "soft_refs", "interfaces"):
                vals = class_deps_raw.get(axis) or []
                if isinstance(vals, list) and vals:
                    class_deps[axis] = [str(x) for x in vals]
        function_flags_raw = ast.get("function_flags") or {}
        function_flags: Dict[str, List[str]] = {}
        if isinstance(function_flags_raw, dict):
            for fname, flags in function_flags_raw.items():
                if isinstance(flags, list):
                    function_flags[str(fname)] = [str(x) for x in flags]
        properties_raw = ast.get("properties") or []
        properties: List[Dict[str, Any]] = []
        if isinstance(properties_raw, list):
            for p in properties_raw:
                if isinstance(p, dict) and p.get("name"):
                    properties.append({
                        "name": str(p["name"]),
                        "type": str(p.get("type", "")),
                        "flags": [str(x) for x in (p.get("flags") or []) if x],
                    })

        record = vault_writer.NodeRecord(
            node_id=node.node_id,
            title=title,
            asset_path=node.asset_path,
            node_type=node.node_type,
            parent_class=node.parent_class,
            ast_data=node.ast_data,
            edges_out=[
                vault_writer.Edge(
                    target=e.target, edge_type=e.edge_type,
                    refs=e.refs, label=e.label,
                ) for e in node.outbound_edges
            ],
            intent=parsed["intent"],
            risk_level=parsed["risk_level"],
            tags=parsed["tags"],
            full_analysis_markdown=parsed["analysis_markdown"],
            exports_functions=list(ast.get("exports_functions") or []),
            exports_events=list(ast.get("exports_events") or []),
            exports_dispatchers=list(ast.get("exports_dispatchers") or []),
            variables=list(ast.get("variables") or []),
            components=list(ast.get("components") or []),
            properties=properties,
            function_flags=function_flags,
            class_dependencies=class_deps,
        )
        write_result = vault_writer.write_node_file(
            project_root=project_root,
            node=record,
            model=provider.model_label,
            engine_version="5.7",
            language=language,
        )

    return {
        "parsed": parsed,
        "write_result": write_result,
        "llm_response": llm_response,
    }


# ─────────────────────────────────────────────────────────────────────────────
# User-prompt builder — separates the now-rich structural context (Reflection
# exports / properties / class deps) from the raw K2 edge walk so the LLM
# treats them as authoritative inventory rather than blob to extract from.
# Caps each section to keep token budget manageable on big BPs.  When
# Reflection data is missing (older plugin), we fall back to dumping the
# legacy ast_data JSON so the LLM still has something — it just gets less
# aid against fabrication.
# ─────────────────────────────────────────────────────────────────────────────

# Hard caps on how many items per section we ship to the LLM.  Real BPs rarely
# exceed these; runaways (auto-generated DataAssets, library BPs with hundreds
# of helpers) get tail-trimmed with a "+N more" hint.
_MAX_ITEMS_PER_SECTION = 64
# Hard cap on the legacy fallback JSON dump; matches the original 8000-char
# truncation so behaviour is unchanged when Reflection isn't available.
_LEGACY_AST_DUMP_CAP = 8000


def _format_list(items: List[str], cap: int = _MAX_ITEMS_PER_SECTION) -> str:
    if not items:
        return "(none)"
    if len(items) <= cap:
        return ", ".join(items)
    return ", ".join(items[:cap]) + f", … (+{len(items) - cap} more)"


def _format_function_inventory(
    names: List[str],
    flags_by_name: Dict[str, List[str]],
    label: str,
    cap: int = _MAX_ITEMS_PER_SECTION,
) -> str:
    if not names:
        return f"- {label}: (none)"
    rendered: List[str] = []
    for n in names[:cap]:
        flags = flags_by_name.get(n) or []
        rendered.append(f"{n}({', '.join(flags)})" if flags else n)
    suffix = f" … (+{len(names) - cap} more)" if len(names) > cap else ""
    return f"- {label}: {', '.join(rendered)}{suffix}"


def _format_properties(properties: List[Dict[str, Any]], cap: int = _MAX_ITEMS_PER_SECTION) -> List[str]:
    if not properties:
        return ["- Properties: (none surfaced via Reflection)"]
    out = ["- Properties (name : type [flags]):"]
    for p in properties[:cap]:
        name = p.get("name", "")
        ptype = p.get("type", "")
        flags = p.get("flags") or []
        flag_str = f" [{', '.join(flags)}]" if flags else ""
        out.append(f"    · {name} : {ptype}{flag_str}")
    if len(properties) > cap:
        out.append(f"    · … (+{len(properties) - cap} more)")
    return out


def _format_edges_block(edges: Dict[str, Any]) -> List[str]:
    """Pretty-print the K2 edge walk grouped by edge_type.  Limits per-kind
    so a hub BP doesn't gobble the whole context window."""
    if not edges or not isinstance(edges, dict):
        return ["- K2 graph edges: (none)"]
    out = ["- K2 graph edges (this BP → others, observed via UEdGraph walk):"]
    for kind, entries in edges.items():
        if not isinstance(entries, list) or not entries:
            continue
        out.append(f"    {kind}:")
        for e in entries[:_MAX_ITEMS_PER_SECTION]:
            if not isinstance(e, dict):
                continue
            target = e.get("target", "?")
            refs = e.get("refs") or []
            refs_str = "; ".join(str(r) for r in refs[:6])
            if len(refs) > 6:
                refs_str += f"; +{len(refs) - 6}"
            out.append(f"      · → {target}" + (f"  ({refs_str})" if refs_str else ""))
        if len(entries) > _MAX_ITEMS_PER_SECTION:
            out.append(f"      · … (+{len(entries) - _MAX_ITEMS_PER_SECTION} more)")
    return out


def _build_user_prompt(node: ASTNodePayload) -> str:
    """Compose the structured user prompt for a single-node analysis.

    A2 contract: when ast_data carries the Reflection enrichment fields
    (`function_flags`, `properties`, `class_dependencies`), present them as
    a tidy inventory so the LLM treats them as ground truth.  When they're
    missing (older plugin), fall back to a JSON dump of ast_data so the
    behaviour matches pre-A2 backends.
    """
    ast = node.ast_data if isinstance(node.ast_data, dict) else {}
    has_reflection = any(
        ast.get(k) for k in ("function_flags", "properties", "class_dependencies")
    )

    header = (
        f"Analyze this UE5 Blueprint.\n"
        f"Blueprint Path: {node.asset_path}\n"
        f"Title: {node.title or node.node_id}\n"
        f"Type: {node.node_type}"
        + (f"\nParent class: {node.parent_class}" if node.parent_class else "")
    )

    if not has_reflection:
        # Legacy path — pre-A2 plugin or DataAsset-class that the bridge
        # didn't enrich.  Hand the LLM the raw blob.
        ast_string = json.dumps(node.ast_data)[:_LEGACY_AST_DUMP_CAP] if node.ast_data else "Empty AST"
        return f"{header}\n\nAST Data:\n{ast_string}"

    # A2 enriched path — structured sections.
    fns = list(ast.get("exports_functions") or [])
    events = list(ast.get("exports_events") or [])
    dispatchers = list(ast.get("exports_dispatchers") or [])
    flags_by_name = ast.get("function_flags") or {}
    if not isinstance(flags_by_name, dict):
        flags_by_name = {}
    properties = ast.get("properties") or []
    if not isinstance(properties, list):
        properties = []
    components_raw = ast.get("components") or []
    components: List[Dict[str, Any]] = [c for c in components_raw if isinstance(c, dict)]
    class_deps = ast.get("class_dependencies") or {}
    if not isinstance(class_deps, dict):
        class_deps = {}
    edges = ast.get("edges") or {}

    sections: List[str] = [
        header,
        "",
        "STRUCTURE — extracted from C++ Reflection + AssetRegistry. TRUST these names; if you reference a function / property / interface NOT listed below, that is a fabrication.",
        "",
        _format_function_inventory(fns, flags_by_name, "Functions"),
        _format_function_inventory(events, flags_by_name, "Events"),
        _format_function_inventory(dispatchers, flags_by_name, "Dispatchers"),
    ]

    sections.extend(_format_properties(properties))

    if components:
        rendered_components: List[str] = []
        for c in components[:_MAX_ITEMS_PER_SECTION]:
            name = c.get("name", "")
            klass = c.get("class", "")
            parent = c.get("parent", "")
            label = f"{name}:{klass}"
            if parent:
                label += f" (under {parent})"
            rendered_components.append(label)
        if len(components) > _MAX_ITEMS_PER_SECTION:
            rendered_components.append(f"… (+{len(components) - _MAX_ITEMS_PER_SECTION} more)")
        sections.append(f"- Components: {', '.join(rendered_components)}")
    else:
        sections.append("- Components: (none)")

    sections.append(
        f"- Implements interfaces: {_format_list([str(x) for x in (class_deps.get('interfaces') or [])])}"
    )
    sections.append(
        f"- Hard refs (loaded classes under /Game/): {_format_list([str(x) for x in (class_deps.get('hard_refs') or [])])}"
    )
    sections.append(
        f"- Soft refs (TSoftClassPtr / TSoftObjectPtr): {_format_list([str(x) for x in (class_deps.get('soft_refs') or [])])}"
    )

    sections.append("")
    sections.append("RUNTIME GRAPH — what THIS BP does to others (K2Node walk).")
    sections.extend(_format_edges_block(edges))

    return "\n".join(sections)


# ─────────────────────────────────────────────────────────────────────────────
# Background batch worker — bounded concurrency, per-node timeout & retry
# ─────────────────────────────────────────────────────────────────────────────

async def process_batch_ast_task(
    task_id: str,
    nodes: List[ASTNodePayload],
    project_root: Optional[str],
    provider_config_dict: Dict[str, Any],
):
    total_nodes = len(nodes)
    failed = 0
    completed = 0
    skipped = 0

    # Build provider once per task (cheap — just an SDK client).  The dict
    # is dropped at function exit; we never persist it.
    try:
        provider = build_provider(provider_config_dict)
    except Exception as e:
        await redis_client.hset(f"task:{task_id}", "status", "FAILED")
        await redis_client.hset(f"task:{task_id}", "error", f"provider_init_failed: {e}")
        print(f"[SYS_ERR] Provider init failed for task {task_id}: {e}")
        return

    print(
        f"[SYS_LOG] Batch {task_id}: provider={provider.display_name} "
        f"model={provider.model_label} key={mask_key(provider_config_dict.get('api_key'))} "
        f"nodes={total_nodes}"
    )

    asset_hashes: Dict[str, str] = {}
    if project_root:
        existing_manifest = vault_writer.load_manifest(project_root)
        asset_hashes.update(existing_manifest.get("asset_hashes", {}))

    # Redis 3.0.504 (bundled) does not support multi-field HSET; pipeline single-field writes.
    async with redis_client.pipeline(transaction=False) as pipe:
        pipe.hset(f"task:{task_id}", "status", "PROCESSING")
        pipe.hset(f"task:{task_id}", "total_nodes", total_nodes)
        pipe.hset(f"task:{task_id}", "completed_nodes", 0)
        pipe.hset(f"task:{task_id}", "failed_nodes", 0)
        pipe.hset(f"task:{task_id}", "skipped_nodes", 0)
        await pipe.execute()

    if project_root:
        vault_writer.ensure_vault_layout(project_root, DEFAULT_VOCAB_PATH)

    # Per-task semaphore bounded by config (frontend may override default).
    raw_concurrency = provider_config_dict.get("concurrency") or DEFAULT_CONCURRENCY
    concurrency = max(1, min(int(raw_concurrency), MAX_CONCURRENCY))
    semaphore = asyncio.Semaphore(concurrency)

    async def process_single_node(node: ASTNodePayload):
        nonlocal completed, failed, skipped
        try:
            ast_hash = vault_writer.compute_ast_hash(node.ast_data)

            # Incremental skip — same AST AND a real LLM-analysed .md already
            # exists in the vault. is_unchanged() does both checks; passing
            # node_type lets it find the right Blueprints/CPP/Interfaces subdir.
            if project_root and vault_writer.is_unchanged(
                project_root, node.node_id, ast_hash, node.node_type,
            ):
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "SKIPPED")
                await redis_client.hincrby(f"task:{task_id}", "skipped_nodes", 1)
                skipped += 1
                asset_hashes[node.node_id] = ast_hash
                return

            async with semaphore:
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "PROCESSING")
                result = await analyze_one_node(
                    provider, node, project_root,
                    language=provider_config_dict.get("language"),
                )
                parsed = result["parsed"]
                write_result = result["write_result"]

                # Stash parsed markdown so legacy clients reading
                # /scan/result/{task_id}/{node_id} still work.
                await redis_client.set(f"result:{task_id}:{node.node_id}", parsed["analysis_markdown"])

                if write_result:
                    asset_hashes[node.node_id] = write_result["ast_hash"]

                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "COMPLETED")
                await redis_client.hincrby(f"task:{task_id}", "completed_nodes", 1)
                completed += 1

        except Exception as e:
            # Persist both the FAILED marker AND the actual exception text so
            # the frontend can surface real diagnostics ("LLM call exhausted
            # retries: rate limit", "Vault write: permission denied", etc.)
            # instead of the opaque "backend marked node FAILED" placeholder.
            err_text = f"{type(e).__name__}: {e}"[:1000]
            print(f"[SYS_ERR] Failed to process node {node.node_id}: {err_text}")
            try:
                await redis_client.hset(f"task:{task_id}:nodes", node.node_id, "FAILED")
                await redis_client.hset(f"task:{task_id}:errors", node.node_id, err_text)
                await redis_client.hincrby(f"task:{task_id}", "failed_nodes", 1)
            except Exception as inner:
                print(f"[SYS_ERR] Could not record FAILED for {node.node_id}: {inner}")
            failed += 1

    await asyncio.gather(*(process_single_node(n) for n in nodes), return_exceptions=True)

    if project_root:
        try:
            counts = vault_writer.rebuild_backlinks(
                project_root,
                language=provider_config_dict.get("language"),
            )
            print(f"[VAULT] backlinks: {counts}")
            vault_writer.update_manifest(
                project_root,
                completed=completed,
                failed=failed,
                skipped=skipped,
                asset_hashes=asset_hashes,
            )
        except Exception as e:
            print(f"[SYS_ERR] Vault post-processing failed: {e}")

    final_status = "COMPLETED" if failed == 0 else "PARTIAL_FAIL" if completed > 0 else "FAILED"
    await redis_client.hset(f"task:{task_id}", "status", final_status)
    print(
        f"[SYS_LOG] Batch {task_id} done. status={final_status} "
        f"completed={completed} failed={failed} skipped={skipped}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI lifespan + app
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client
    app.state.redis_available = False
    try:
        redis_host = os.getenv("REDIS_HOST", "localhost")
        redis_port = int(os.getenv("REDIS_PORT", 6379))
        redis_client = redis.Redis(
            host=redis_host, port=redis_port, db=0,
            decode_responses=True, socket_connect_timeout=5,
        )
        await redis_client.ping()
        app.state.redis_available = True
        print("[ SYS_NOMINAL ] Redis connected. Batch Cartography ONLINE.")
    except (RedisConnectionError, RedisTimeoutError):
        print("[ SYS_WARNING ] Redis unavailable. Running in degraded mode.")
        app.state.redis_available = False
        redis_client = None

    yield

    if app.state.redis_available and redis_client:
        await redis_client.close()
        print("[SYS_LOG] Redis connection closed")


app = FastAPI(title="AICartographer Brain", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    # Lazy reconnect — lifespan only probes Redis once at startup, so if Redis
    # was down at boot we'd be stuck in degraded mode forever even after Redis
    # comes back.  When the cached flag is False, try a quick ping; on success
    # we flip back to nominal.  When the flag is already True, we trust it
    # (avoids burning a TCP roundtrip on every health poll, which the frontend
    # makes on a short interval).
    global redis_client
    if not getattr(app.state, "redis_available", False):
        try:
            if redis_client is None:
                redis_host = os.getenv("REDIS_HOST", "localhost")
                redis_port = int(os.getenv("REDIS_PORT", 6379))
                redis_client = redis.Redis(
                    host=redis_host, port=redis_port, db=0,
                    decode_responses=True, socket_connect_timeout=2,
                )
            await redis_client.ping()
            app.state.redis_available = True
            print("[ SYS_NOMINAL ] Redis reconnected via /api/health probe.")
        except (RedisConnectionError, RedisTimeoutError):
            # Stay degraded; next poll will retry.
            pass
    return {
        "status": "SYS_NOMINAL",
        "redis_available": getattr(app.state, "redis_available", False),
        "version": "2.0.0",  # bumped — provider abstraction + per-request keys
    }


# ─────────────────────────────────────────────────────────────────────────────
# LLM provider endpoints — connection test + per-request credentials
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/v1/llm/test-connection")
async def test_llm_connection(req: TestConnectionRequest):
    """Verify a provider config can reach the model and return a short reply.

    Used by the Settings panel's "Test connection" button.  Sends a tiny
    PONG-style probe so connectivity issues surface in seconds.
    """
    cfg = req.provider_config.model_dump()
    print(f"[LLM] test-connection provider={cfg.get('provider')} key={mask_key(cfg.get('api_key'))}")
    try:
        provider = build_provider(cfg)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid provider config: {e}")

    started = time.monotonic()
    try:
        resp = await asyncio.wait_for(provider.ping(), timeout=30.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Connection test timed out after 30s.")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Provider call failed: {e}")
    elapsed_ms = int((time.monotonic() - started) * 1000)

    return {
        "ok": True,
        "provider": provider.display_name,
        "model": provider.model_label,
        "latency_ms": elapsed_ms,
        "tokens_in": resp.tokens_in,
        "tokens_out": resp.tokens_out,
        "thinking_tokens": resp.thinking_tokens,
        "sample_text": (resp.raw_text or "").strip()[:200],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Single-node scan — synchronous, used by Lv2 "Deep reasoning" button
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/v1/scan/single")
async def scan_single_node(req: SingleScanRequest):
    cfg = req.provider_config.model_dump()
    print(
        f"[LLM] scan/single node={req.node.node_id} provider={cfg.get('provider')} "
        f"key={mask_key(cfg.get('api_key'))}"
    )
    try:
        provider = build_provider(cfg)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid provider config: {e}")

    if req.project_root:
        try:
            vault_writer.ensure_vault_layout(req.project_root, DEFAULT_VOCAB_PATH)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Vault layout failed: {e}")

    try:
        result = await analyze_one_node(
            provider, req.node, req.project_root,
            language=req.provider_config.language,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM scan failed: {e}")

    parsed = result["parsed"]
    write_result = result["write_result"] or {}
    llm_response: LLMResponse = result["llm_response"]

    # Best-effort backlink rebuild — single-node edits the new file's outbound
    # links into other notes' BACKLINKS regions.  Failure here is non-fatal.
    if req.project_root:
        try:
            vault_writer.rebuild_backlinks(
                req.project_root,
                language=req.provider_config.language,
            )
        except Exception as e:
            print(f"[SYS_WARN] Single-node backlink rebuild failed: {e}")

    return {
        "ok": True,
        "vault_path": write_result.get("path"),
        "ast_hash": write_result.get("ast_hash"),
        "notes_review_needed": write_result.get("notes_review_needed", False),
        "intent": parsed["intent"],
        "tags": parsed["tags"],
        "risk_level": parsed["risk_level"],
        "parse_ok": parsed["parse_ok"],
        "analysis_markdown": parsed["analysis_markdown"],
        "tokens_in": llm_response.tokens_in,
        "tokens_out": llm_response.tokens_out,
        "thinking_tokens": llm_response.thinking_tokens,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Batch endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/v1/scan/batch", status_code=202)
async def create_batch_scan_task(request: BatchScanRequest, background_tasks: BackgroundTasks):
    if not getattr(app.state, "redis_available", False) or redis_client is None:
        raise HTTPException(status_code=503, detail="Batch Cartography Engine offline. Redis required.")
    task_id = str(uuid.uuid4())

    # Redis 3.0.504 (bundled) does not support multi-field HSET; pipeline single-field writes.
    async with redis_client.pipeline(transaction=False) as pipe:
        pipe.hset(f"task:{task_id}", "status", "PENDING")
        pipe.hset(f"task:{task_id}", "total_nodes", len(request.nodes))
        pipe.hset(f"task:{task_id}", "completed_nodes", 0)
        pipe.hset(f"task:{task_id}", "failed_nodes", 0)
        pipe.hset(f"task:{task_id}", "skipped_nodes", 0)
        if request.nodes:
            for node in request.nodes:
                pipe.hset(f"task:{task_id}:nodes", node.node_id, "PENDING")
        await pipe.execute()

    cfg_dict = request.provider_config.model_dump()
    background_tasks.add_task(
        process_batch_ast_task, task_id, request.nodes, request.project_root, cfg_dict,
    )
    return {"task_id": task_id}


@app.get("/api/v1/scan/status/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis offline")
    task_data = await redis_client.hgetall(f"task:{task_id}")
    if not task_data:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    node_statuses = await redis_client.hgetall(f"task:{task_id}:nodes")
    node_errors = await redis_client.hgetall(f"task:{task_id}:errors")
    return TaskStatusResponse(
        task_id=task_id,
        status=task_data.get("status", "PENDING"),
        total_nodes=int(task_data.get("total_nodes", 0)),
        completed_nodes=int(task_data.get("completed_nodes", 0)),
        failed_nodes=int(task_data.get("failed_nodes", 0)),
        skipped_nodes=int(task_data.get("skipped_nodes", 0)),
        node_statuses=node_statuses or {},
        node_errors=node_errors or {},
        error=task_data.get("error"),
    )


@app.get("/api/v1/scan/result/{task_id}/{node_id}")
async def get_node_result(task_id: str, node_id: str):
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis offline")
    result = await redis_client.get(f"result:{task_id}:{node_id}")
    if not result:
        raise HTTPException(status_code=404, detail=f"Result for {node_id} not found")
    return {"analysis": result}


# ─────────────────────────────────────────────────────────────────────────────
# L1 (per-system) — Phase 2 refactor.
#
# Two flavours, both backed by analyze_one_system_l1():
#   - single-system (system_id query param present): one LLM call, scoped to
#     members of that one system.  Triggered by the Lv1 page button.
#   - batch (no system_id): discover all distinct system tags from the vault's
#     L2 frontmatter, sequentially call single-system for each.  Triggered by
#     the Settings panel's "Run LLM analysis" with L1 checked.
#
# The OLD project-clustering L1 (parse_l1_response, process_l1_task,
# L1_SYSTEM_PROMPT) is kept below as dead code for diff legibility but is no
# longer reachable — the endpoint dispatches to the new code paths only.
# ─────────────────────────────────────────────────────────────────────────────

def parse_l1_system_response(raw: str) -> Dict[str, Any]:
    """Per-system L1 parser.  Extracts the new METADATA shape:
    {system_id, title, intent, system_risk_level, external_dependencies}.
    Always returns a dict with parse_ok set; never raises."""
    out: Dict[str, Any] = {
        "system_id": "",
        "title": "",
        "intent": None,
        "system_risk_level": "nominal",
        "hub": None,
        "external_dependencies": [],
        "analysis_markdown": raw,
        "parse_ok": False,
    }
    md_text = _extract_metadata_block(raw)
    body_match = _ANALYSIS_RE.search(raw)

    if md_text:
        try:
            md_obj = json.loads(md_text)
            out["system_id"] = str(md_obj.get("system_id") or "")
            out["title"] = str(md_obj.get("title") or "")
            out["intent"] = md_obj.get("intent")
            risk = (md_obj.get("system_risk_level") or "nominal").lower()
            if risk not in ("nominal", "warning", "critical"):
                risk = "nominal"
            out["system_risk_level"] = risk
            # Hub designation — `null` is a legitimate value (some systems
            # are flat collections of helpers without a clear central node)
            # so we accept `None` and let the writer skip the ★ marker.
            hub_val = md_obj.get("hub")
            out["hub"] = str(hub_val).strip() if isinstance(hub_val, str) and hub_val.strip() else None
            ext = md_obj.get("external_dependencies") or []
            if isinstance(ext, list):
                out["external_dependencies"] = [e for e in ext if isinstance(e, dict)]
            out["parse_ok"] = True
        except (json.JSONDecodeError, AttributeError) as e:
            print(f"[SYS_WARN] L1 system METADATA malformed: {e}")

    if body_match:
        out["analysis_markdown"] = body_match.group(1).strip()

    return out


# Hard cap on the per-system input size — at 150 KB JSON we trim outbound
# edges before re-serialising.  Matches the old project-wide cap.
_L1_SYSTEM_PROMPT_CAP = 150_000


async def analyze_one_system_l1(
    provider: LLMProvider,
    project_root: str,
    system_id: str,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """L1 base function — analyse ONE system.

    Reads vault L2 metadata, filters to members tagged with `system_id`,
    annotates outbound edges with `in_system` based on the title set, calls
    the LLM with L1_SYSTEM_SCOPED_PROMPT, parses, and writes the per-system
    .md.  Returns {parsed, write_path, llm_response, member_count}.

    Raises ValueError if no L2-scanned members carry this system tag.
    """
    all_meta = vault_writer.collect_l2_metadata(project_root)
    members = [m for m in all_meta if system_id in (m.get("system") or [])]
    if not members:
        raise ValueError(
            f"No L2-scanned blueprints carry the '{system_id}' system tag yet. "
            f"Run an L2 scan (Settings → Run LLM analysis with L2 checked) first."
        )

    member_titles = {m.get("title") for m in members if m.get("title")}
    for m in members:
        for e in m.get("outbound_edges") or []:
            if isinstance(e, dict):
                e["in_system"] = e.get("target") in member_titles

    payload = {"system_id": system_id, "members": members}
    user_prompt = json.dumps(payload, ensure_ascii=False)
    if len(user_prompt) > _L1_SYSTEM_PROMPT_CAP:
        # Trim outbound_edges per member; preserves member roster.
        for m in members:
            m["outbound_edges"] = (m.get("outbound_edges") or [])[:8]
        user_prompt = json.dumps(payload, ensure_ascii=False)

    system_prompt = _apply_language(L1_SYSTEM_SCOPED_PROMPT, language)
    # L1 system synthesis runs significantly longer than L2 single-BP — the
    # METADATA block alone can hit ~1 KB and the ANALYSIS body 2-3 KB, plus
    # reasoning models (DeepSeek-R1, o1, QwQ) silently consume thousands of
    # tokens on chain-of-thought before they emit the visible reply.  At
    # 4096 max_tokens those models routinely return finish_reason="length"
    # with `content` = "" — which surfaced as the empty-raw-output L1 batch
    # failures.  8192 leaves headroom for both narrative + reasoning.
    llm_response = await call_llm(provider, system_prompt, user_prompt, max_tokens=8192)
    parsed = parse_l1_system_response(llm_response.raw_text)

    write_path: Optional[str] = None
    if parsed["parse_ok"]:
        write_path = vault_writer.write_system_l1_narrative(
            project_root=project_root,
            system_id=system_id,
            metadata={
                "title": parsed["title"] or system_id,
                "intent": parsed["intent"],
                "system_risk_level": parsed["system_risk_level"],
                "hub": parsed.get("hub"),
                "external_dependencies": parsed["external_dependencies"],
            },
            analysis_markdown=parsed["analysis_markdown"],
            members=members,
            model=provider.model_label,
            language=language,
        )

    return {
        "parsed": parsed,
        "write_path": write_path,
        "llm_response": llm_response,
        "member_count": len(members),
    }


async def process_system_l1_task(
    task_id: str,
    project_root: str,
    system_id: str,
    provider_config_dict: Dict[str, Any],
) -> None:
    """Background worker — single-system L1.  Persists the same
    {status, total_nodes, completed_nodes, failed_nodes, node_statuses}
    schema as the L2 batch worker so the frontend's polling code is shared."""
    assert redis_client is not None

    async def set_status(status: str) -> None:
        await redis_client.hset(f"task:{task_id}", "status", status)

    try:
        provider = build_provider(provider_config_dict)
    except Exception as e:
        await set_status("FAILED")
        await redis_client.hset(f"task:{task_id}", "error", f"Invalid provider config: {e}")
        return

    print(
        f"[L1-system] task={task_id} system={system_id} "
        f"provider={provider.display_name} model={provider.model_label}"
    )

    try:
        await set_status("PROCESSING")
        await redis_client.hset(f"task:{task_id}:nodes", system_id, "PROCESSING")

        result = await asyncio.wait_for(
            analyze_one_system_l1(
                provider, project_root, system_id,
                language=provider_config_dict.get("language"),
            ),
            timeout=180.0,
        )

        if not result["parsed"]["parse_ok"]:
            llm_resp = result.get("llm_response")
            raw_snip = (getattr(llm_resp, "raw_text", "") or "")[:600]
            snip_disp = raw_snip.replace("\r", " ").replace("\n", " ↵ ").strip()
            extra = getattr(llm_resp, "extra", {}) or {}
            tokens_in = getattr(llm_resp, "tokens_in", 0)
            tokens_out = getattr(llm_resp, "tokens_out", 0)
            diag_parts = [f"tokens={tokens_in}/{tokens_out}"]
            fr = extra.get("finish_reason")
            if fr:
                diag_parts.append(f"finish_reason={fr}")
            if extra.get("recovered_from"):
                diag_parts.append(f"recovered_from={extra['recovered_from']}")
            diag = " ".join(diag_parts)
            err = (
                f"L1 system response had no parseable METADATA block. [{diag}] "
                f"LLM raw output (first 600 chars): {snip_disp or '<empty>'}"
            )
            msg_dump = extra.get("message_dump")
            if not raw_snip and msg_dump:
                err += f" | raw message dict: {msg_dump}"
            await redis_client.hset(f"task:{task_id}", "status", "FAILED")
            await redis_client.hset(f"task:{task_id}", "error", err)
            await redis_client.hset(f"task:{task_id}:nodes", system_id, "FAILED")
            await redis_client.hset(f"task:{task_id}:errors", system_id, err)
            await redis_client.hincrby(f"task:{task_id}", "failed_nodes", 1)
            await redis_client.set(f"result:{task_id}:{system_id}", result["llm_response"].raw_text)
            return

        await redis_client.set(
            f"result:{task_id}:{system_id}",
            result["parsed"]["analysis_markdown"],
        )
        async with redis_client.pipeline(transaction=False) as pipe:
            pipe.hset(f"task:{task_id}", "status", "COMPLETED")
            pipe.hset(f"task:{task_id}", "completed_nodes", 1)
            pipe.hset(f"task:{task_id}:nodes", system_id, "COMPLETED")
            await pipe.execute()
        print(f"[L1-system] task={task_id} done — {result['member_count']} members analysed")

    except Exception as e:
        err_text = f"{type(e).__name__}: {e}"[:1000]
        print(f"[SYS_ERR] L1 system {system_id} task={task_id} failed: {err_text}")
        try:
            async with redis_client.pipeline(transaction=False) as pipe:
                pipe.hset(f"task:{task_id}", "status", "FAILED")
                pipe.hset(f"task:{task_id}", "failed_nodes", 1)
                pipe.hset(f"task:{task_id}", "error", err_text)
                pipe.hset(f"task:{task_id}:nodes", system_id, "FAILED")
                pipe.hset(f"task:{task_id}:errors", system_id, err_text)
                await pipe.execute()
        except Exception as inner:
            print(f"[SYS_ERR] Could not record FAILED for {system_id}: {inner}")


async def process_batch_l1_task(
    task_id: str,
    project_root: str,
    provider_config_dict: Dict[str, Any],
) -> None:
    """Background worker — batch L1: discover system tags from vault L2
    metadata, then call analyze_one_system_l1 sequentially for each.

    Sequential rather than concurrent because per-system L1 isn't a hot loop
    and serial calls keep token spend predictable + log lines readable.  When
    one system fails, the others still run — failures land in node_errors."""
    assert redis_client is not None

    async def set_status(status: str) -> None:
        await redis_client.hset(f"task:{task_id}", "status", status)

    try:
        provider = build_provider(provider_config_dict)
    except Exception as e:
        await set_status("FAILED")
        await redis_client.hset(f"task:{task_id}", "error", f"Invalid provider config: {e}")
        return

    all_meta = vault_writer.collect_l2_metadata(project_root)
    system_ids = sorted({s for m in all_meta for s in (m.get("system") or [])})
    if not system_ids:
        await set_status("FAILED")
        await redis_client.hset(
            f"task:{task_id}", "error",
            "No L2-scanned blueprints with system tags found. Run an L2 scan first.",
        )
        return

    print(
        f"[L1-batch] task={task_id} systems={len(system_ids)} ({','.join(system_ids)}) "
        f"provider={provider.display_name} model={provider.model_label}"
    )

    async with redis_client.pipeline(transaction=False) as pipe:
        pipe.hset(f"task:{task_id}", "status", "PROCESSING")
        pipe.hset(f"task:{task_id}", "total_nodes", len(system_ids))
        for sid in system_ids:
            pipe.hset(f"task:{task_id}:nodes", sid, "PENDING")
        await pipe.execute()

    completed = 0
    failed = 0
    for sid in system_ids:
        try:
            await redis_client.hset(f"task:{task_id}:nodes", sid, "PROCESSING")
            result = await asyncio.wait_for(
                analyze_one_system_l1(
                    provider, project_root, sid,
                    language=provider_config_dict.get("language"),
                ),
                timeout=180.0,
            )
            if not result["parsed"]["parse_ok"]:
                # Surface the LLM's actual reply + provider diagnostics so the
                # user can see WHY the parse failed.  When raw_text is empty
                # but tokens_out > 0, the model DID produce output — it just
                # landed in a non-standard field that our extraction didn't
                # know about.  In that case we surface a dump of the raw
                # message dict so the operator can identify the unknown
                # field (e.g. `output.parts[0].text`) and we can add it to
                # the fallback list with one line of code.
                llm_resp = result.get("llm_response")
                raw_snip = (getattr(llm_resp, "raw_text", "") or "")[:600]
                snip_disp = raw_snip.replace("\r", " ").replace("\n", " ↵ ").strip()
                extra = getattr(llm_resp, "extra", {}) or {}
                tokens_in = getattr(llm_resp, "tokens_in", 0)
                tokens_out = getattr(llm_resp, "tokens_out", 0)
                diag_parts = [f"tokens={tokens_in}/{tokens_out}"]
                fr = extra.get("finish_reason")
                if fr:
                    diag_parts.append(f"finish_reason={fr}")
                if extra.get("recovered_from"):
                    diag_parts.append(f"recovered_from={extra['recovered_from']}")
                diag = " ".join(diag_parts)
                err_msg = (
                    f"L1 response had no parseable METADATA block. [{diag}] "
                    f"LLM raw output (first 600 chars): {snip_disp or '<empty>'}"
                )
                # Append raw message dump only when raw_text was empty AND
                # the provider gave us a dump — otherwise the dump is just
                # the same content we already showed.
                msg_dump = extra.get("message_dump")
                if not raw_snip and msg_dump:
                    err_msg += f" | raw message dict: {msg_dump}"
                raise RuntimeError(err_msg)
            await redis_client.set(
                f"result:{task_id}:{sid}",
                result["parsed"]["analysis_markdown"],
            )
            await redis_client.hset(f"task:{task_id}:nodes", sid, "COMPLETED")
            await redis_client.hincrby(f"task:{task_id}", "completed_nodes", 1)
            completed += 1
        except Exception as e:
            # 4500 char ceiling — large enough to fit the provider's full
            # raw-body dump (up to 3500 chars) plus the diagnostic prefix
            # plus the raw_text snip, so the operator can identify unknown
            # proxy field shapes from the error pane alone without digging
            # into uvicorn logs.
            err_text = f"{type(e).__name__}: {e}"[:4500]
            print(f"[SYS_ERR] L1 system {sid} (batch task={task_id}) failed: {err_text}")
            try:
                await redis_client.hset(f"task:{task_id}:nodes", sid, "FAILED")
                await redis_client.hset(f"task:{task_id}:errors", sid, err_text)
                await redis_client.hincrby(f"task:{task_id}", "failed_nodes", 1)
            except Exception as inner:
                print(f"[SYS_ERR] Could not record batch-L1 FAILED for {sid}: {inner}")
            failed += 1

    final_status = (
        "COMPLETED" if failed == 0
        else "PARTIAL_FAIL" if completed > 0
        else "FAILED"
    )
    await redis_client.hset(f"task:{task_id}", "status", final_status)
    print(
        f"[L1-batch] task={task_id} done. status={final_status} "
        f"completed={completed} failed={failed}"
    )


# ── Legacy project-wide L1 (unused after Phase 2 refactor; kept for now) ────

def parse_l1_response(raw: str) -> Dict[str, Any]:
    """Mirror of parse_llm_response, but extracts the L1 metadata shape:
    {systems: [...], cross_system_edges: [...], project_risk_level: "..."}."""
    out: Dict[str, Any] = {
        "systems": [], "cross_system_edges": [],
        "project_risk_level": "nominal",
        "analysis_markdown": raw, "parse_ok": False,
    }
    md_text = _extract_metadata_block(raw)
    body_match = _ANALYSIS_RE.search(raw)

    if md_text:
        try:
            md_obj = json.loads(md_text)
            systems_in = md_obj.get("systems") or []
            if isinstance(systems_in, list):
                out["systems"] = [s for s in systems_in if isinstance(s, dict)]
            edges_in = md_obj.get("cross_system_edges") or []
            if isinstance(edges_in, list):
                out["cross_system_edges"] = [e for e in edges_in if isinstance(e, dict)]
            risk = (md_obj.get("project_risk_level") or "nominal").lower()
            if risk not in ("nominal", "warning", "critical"):
                risk = "nominal"
            out["project_risk_level"] = risk
            out["parse_ok"] = True
        except (json.JSONDecodeError, AttributeError) as e:
            print(f"[SYS_WARN] L1 METADATA block malformed: {e}")

    if body_match:
        out["analysis_markdown"] = body_match.group(1).strip()

    return out


async def process_l1_task(task_id: str, project_root: str, provider_config_dict: Dict[str, Any]) -> None:
    """Background task: collect L2 metadata → LLM → write _overview.md + l1_overview.json."""
    assert redis_client is not None

    async def set_status(status: str) -> None:
        await redis_client.hset(f"task:{task_id}", "status", status)

    try:
        provider = build_provider(provider_config_dict)
    except Exception as e:
        await set_status("FAILED")
        await redis_client.hset(f"task:{task_id}", "error", f"Invalid provider config: {e}")
        return

    print(
        f"[L1] task={task_id} provider={provider.display_name} "
        f"model={provider.model_label} key={mask_key(provider_config_dict.get('api_key'))} "
        f"root={project_root}"
    )

    try:
        await set_status("PROCESSING")
        blueprints = vault_writer.collect_l2_metadata(project_root)
        if not blueprints:
            await set_status("FAILED")
            await redis_client.hset(
                f"task:{task_id}", "error",
                "No L2-scanned blueprints found in vault. Run an L2 scan first.",
            )
            return

        await redis_client.hset(f"task:{task_id}", "total_nodes", len(blueprints))

        l1_input = {"project_root": project_root, "blueprints": blueprints}
        # Cap input size — long projects with verbose intents could otherwise
        # blow past the model's context.  Trim outbound_edges if the payload
        # gets unwieldy.  150kb of JSON ≈ 35-45k tokens which is comfortable
        # for Sonnet/Opus and Volcengine endpoints.
        user_prompt = json.dumps(l1_input, ensure_ascii=False)
        if len(user_prompt) > 150_000:
            for bp in l1_input["blueprints"]:
                bp["outbound_edges"] = bp.get("outbound_edges", [])[:8]
            user_prompt = json.dumps(l1_input, ensure_ascii=False)

        l1_prompt = _apply_language(L1_SYSTEM_PROMPT, provider_config_dict.get("language"))
        try:
            llm_response = await asyncio.wait_for(
                provider.analyze(l1_prompt, user_prompt),
                timeout=180.0,
            )
        except asyncio.TimeoutError:
            await set_status("FAILED")
            await redis_client.hset(f"task:{task_id}", "error", "L1 LLM call timed out after 180s.")
            return

        parsed = parse_l1_response(llm_response.raw_text)
        if not parsed["parse_ok"]:
            await set_status("FAILED")
            await redis_client.hset(
                f"task:{task_id}", "error",
                "L1 response did not contain a parseable METADATA block.",
            )
            await redis_client.set(f"result:{task_id}:_overview", llm_response.raw_text)
            return

        write_result = vault_writer.write_l1_overview(
            project_root=project_root,
            metadata={
                "systems": parsed["systems"],
                "cross_system_edges": parsed["cross_system_edges"],
                "project_risk_level": parsed["project_risk_level"],
            },
            analysis_markdown=parsed["analysis_markdown"],
            model=provider.model_label,
            # Pass the L2 metadata we already collected so the per-system
            # writer can resolve member asset_paths → vault filenames + the
            # right Blueprints/Interfaces/Components subdir.
            member_meta=blueprints,
            language=provider_config_dict.get("language"),
        )

        await redis_client.set(f"result:{task_id}:_overview", parsed["analysis_markdown"])

        async with redis_client.pipeline(transaction=False) as pipe:
            pipe.hset(f"task:{task_id}", "status", "COMPLETED")
            pipe.hset(f"task:{task_id}", "completed_nodes", 1)
            pipe.hset(f"task:{task_id}", "system_count", write_result["system_count"])
            pipe.hset(f"task:{task_id}:nodes", "_overview", "COMPLETED")
            await pipe.execute()
        print(f"[L1] task={task_id} done — {write_result['system_count']} system(s) written")

    except Exception as e:
        print(f"[SYS_ERR] L1 task {task_id} failed: {e}")
        try:
            async with redis_client.pipeline(transaction=False) as pipe:
                pipe.hset(f"task:{task_id}", "status", "FAILED")
                pipe.hset(f"task:{task_id}", "failed_nodes", 1)
                pipe.hset(f"task:{task_id}", "error", str(e)[:500])
                pipe.hset(f"task:{task_id}:nodes", "_overview", "FAILED")
                await pipe.execute()
        except Exception as inner:
            print(f"[SYS_ERR] Could not record L1 FAILED for {task_id}: {inner}")


@app.post("/api/v1/scan/l1", status_code=202)
async def create_l1_scan_task(
    request: L1ScanRequest,
    background_tasks: BackgroundTasks,
    system_id: Optional[str] = None,
):
    """L1 scan dispatcher.

    - `system_id=combat` → analyse a single system (Lv1 page button).
    - no `system_id` → batch all discovered systems sequentially (Settings
      panel "Run LLM analysis" with L1 checked).

    Either flow uses the per-system L1 base function; the batch worker just
    discovers system_ids from vault frontmatter and loops.  Both report
    progress through the same /scan/status schema as the L2 batch worker."""
    if not getattr(app.state, "redis_available", False) or redis_client is None:
        raise HTTPException(status_code=503, detail="L1 scan requires Redis.")
    if not request.project_root:
        raise HTTPException(status_code=400, detail="project_root is required.")

    task_id = str(uuid.uuid4())
    cfg_dict = request.provider_config.model_dump()

    if system_id:
        # Single-system mode: total_nodes=1, node_id = system_id.
        async with redis_client.pipeline(transaction=False) as pipe:
            pipe.hset(f"task:{task_id}", "status", "PENDING")
            pipe.hset(f"task:{task_id}", "stage", "L1-single")
            pipe.hset(f"task:{task_id}", "system_id", system_id)
            pipe.hset(f"task:{task_id}", "total_nodes", 1)
            pipe.hset(f"task:{task_id}", "completed_nodes", 0)
            pipe.hset(f"task:{task_id}", "failed_nodes", 0)
            pipe.hset(f"task:{task_id}", "skipped_nodes", 0)
            pipe.hset(f"task:{task_id}:nodes", system_id, "PENDING")
            await pipe.execute()
        background_tasks.add_task(
            process_system_l1_task, task_id, request.project_root, system_id, cfg_dict,
        )
    else:
        # Batch mode: total_nodes set inside the worker once it discovers
        # system tags.  Frontend should not assume total_nodes > 0 until
        # status leaves PENDING.
        async with redis_client.pipeline(transaction=False) as pipe:
            pipe.hset(f"task:{task_id}", "status", "PENDING")
            pipe.hset(f"task:{task_id}", "stage", "L1-batch")
            pipe.hset(f"task:{task_id}", "total_nodes", 0)
            pipe.hset(f"task:{task_id}", "completed_nodes", 0)
            pipe.hset(f"task:{task_id}", "failed_nodes", 0)
            pipe.hset(f"task:{task_id}", "skipped_nodes", 0)
            await pipe.execute()
        background_tasks.add_task(
            process_batch_l1_task, task_id, request.project_root, cfg_dict,
        )

    return {"task_id": task_id}


# ─────────────────────────────────────────────────────────────────────────────
# Vault endpoints (unchanged)
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_vault_path(project_root: str, relative_path: str) -> Path:
    root = vault_writer.vault_root(project_root).resolve()
    target = (root / relative_path).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(status_code=400, detail="Path escapes vault root")
    return target


@app.get("/api/v1/vault/list")
async def vault_list(project_root: str):
    root = vault_writer.vault_root(project_root)
    if not root.exists():
        return {"project_root": project_root, "exists": False, "files": []}
    files = []
    for p in root.rglob("*.md"):
        files.append({
            "relative_path": str(p.relative_to(root)).replace("\\", "/"),
            "title": p.stem,
            "subdir": str(p.parent.relative_to(root)).replace("\\", "/"),
            "size": p.stat().st_size,
        })
    manifest = vault_writer.load_manifest(project_root)
    return {
        "project_root": project_root,
        "exists": True,
        "files": files,
        "manifest": manifest,
    }


@app.get("/api/v1/vault/read")
async def vault_read(project_root: str, relative_path: str):
    target = _resolve_vault_path(project_root, relative_path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {relative_path}")
    text = target.read_text(encoding="utf-8")
    fm = vault_writer.read_existing_frontmatter(target) or {}
    return {
        "relative_path": relative_path,
        "frontmatter": fm,
        "content": text,
    }


@app.put("/api/v1/vault/notes")
async def vault_write_notes(req: WriteNotesRequest):
    try:
        result = vault_writer.write_user_notes(req.project_root, req.relative_path, req.content)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write notes: {e}")


@app.post("/api/v1/vault/rebuild-backlinks")
async def vault_rebuild_backlinks(project_root: str, language: Optional[str] = None):
    try:
        counts = vault_writer.rebuild_backlinks(project_root, language=language)
        return {"project_root": project_root, **counts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Apply rename — migrate a vault .md to match a UE asset rename
# ─────────────────────────────────────────────────────────────────────────────
# Wired to the TopBar stale-asset dropdown's "Apply rename" button.  Body
# and NOTES sections are preserved; only `title` + `asset_path` (and a new
# `previous_asset_path` audit field) get updated, and the file is moved
# to a filename derived from new_name.

class ApplyRenameRequest(BaseModel):
    project_root: str
    old_relative_path: str
    new_name: str
    new_asset_path: str


@app.post("/api/v1/vault/apply-rename")
async def vault_apply_rename(req: ApplyRenameRequest):
    try:
        result = vault_writer.apply_rename(
            req.project_root,
            req.old_relative_path,
            req.new_name,
            req.new_asset_path,
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"apply-rename failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Delete vault file — applied for `removed` stale events.
# ─────────────────────────────────────────────────────────────────────────────
# Wired to the TopBar stale-asset dropdown's Apply button on a deleted asset.
# Removes the .md file (path-traversal-checked).  NOTES live in the same file
# so they go away too — that's intended: the asset is gone, the note is moot.

class DeleteVaultFileRequest(BaseModel):
    project_root: str
    relative_path: str


@app.post("/api/v1/vault/delete-file")
async def vault_delete_file(req: DeleteVaultFileRequest):
    try:
        return vault_writer.delete_vault_file(req.project_root, req.relative_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"delete-file failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Find vault note by asset_path — used by framework-scan to preserve a user's
# manually-organised folder structure.  If a .md exists anywhere in vault with
# `asset_path: <X>` in its frontmatter, return that relative path so the next
# scan can rewrite it in place instead of dropping a fresh copy at the
# deterministic Blueprints/<Name>.md and orphaning the user's moved file.

@app.get("/api/v1/vault/find-by-asset")
async def vault_find_by_asset(project_root: str, asset_path: str):
    rel = vault_writer.find_vault_note_for_asset(project_root, asset_path)
    return {"asset_path": asset_path, "relative_path": rel}


# ─────────────────────────────────────────────────────────────────────────────
# Vault export — bundle the entire vault into a single JSON document
# ─────────────────────────────────────────────────────────────────────────────
# Lets users hand the project graph to any external LLM (ChatGPT web, Claude.ai)
# without paying for API tokens.  scope=l1 keeps only Systems/*, scope=l2 keeps
# only Blueprints/Components/Interfaces, scope=all (default) bundles both.
# Each entry carries the raw frontmatter (already nested-schema, see §5) plus
# the markdown body so an external reader doesn't need our normalize step.

def _strip_frontmatter_text(raw: str) -> str:
    """Return the markdown body sans `---\\n...\\n---\\n` header (if present)."""
    if not raw.startswith("---\n"):
        return raw
    end = raw.find("\n---\n", 4)
    if end == -1:
        return raw
    return raw[end + 5:]


@app.get("/api/v1/vault/export")
async def vault_export(project_root: str, scope: str = "all"):
    if scope not in {"all", "l1", "l2"}:
        raise HTTPException(status_code=400, detail="scope must be one of: all | l1 | l2")
    root = vault_writer.vault_root(project_root)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Vault not found at {root}")

    systems: List[Dict[str, Any]] = []
    blueprints: List[Dict[str, Any]] = []

    for p in sorted(root.rglob("*.md")):
        rel = str(p.relative_to(root)).replace("\\", "/")
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            print(f"[VAULT] export: skip {rel} ({e})")
            continue
        fm = vault_writer.read_existing_frontmatter(p) or {}
        body = _strip_frontmatter_text(text)

        entry = {
            "relative_path": rel,
            "frontmatter": fm,
            "body": body,
            "size": p.stat().st_size,
        }

        # Bucket by subdir.  Systems/* → L1; everything else → L2.  _meta and
        # _systems (legacy) are dropped from the export — they're redundant
        # given the per-file frontmatter.
        top = rel.split("/", 1)[0] if "/" in rel else ""
        if top in {"_meta", "_systems"}:
            continue
        if top == "Systems":
            if scope in {"all", "l1"}:
                systems.append(entry)
        else:
            if scope in {"all", "l2"}:
                blueprints.append(entry)

    manifest = vault_writer.load_manifest(project_root)
    return {
        "project_root": project_root,
        "scope": scope,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "manifest": manifest,
        "systems": systems,
        "blueprints": blueprints,
        "counts": {
            "systems": len(systems),
            "blueprints": len(blueprints),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Cross-BP call-trace (A3, HANDOFF §19.3 + §21.5) — concentric BFS view.
# ─────────────────────────────────────────────────────────────────────────────
# Walks the vault's frontmatter `edges:` blocks BFS-style from a root asset,
# returning nodes (with their BFS layer_distance) and edges suitable for the
# Lv4 CallTrace concentric layout.  Edge `target` values in frontmatter are
# resolved titles (not asset_paths), so we build a title → asset_path index
# from the vault first and translate during traversal.
#
# Bounded by max_depth (default 3) and max_nodes (default 100) — these match
# §19.3's MVP guardrails so a hub BP can't blow up the graph.  Returns a
# `truncated` flag when we hit max_nodes with the BFS frontier still non-empty
# so the UI can surface "+N nodes elided" honestly.

DEFAULT_CALLTRACE_DEPTH = 3
DEFAULT_CALLTRACE_NODES = 100
ALLOWED_EDGE_TYPES = {
    "function_call", "interface_call", "cast", "spawn", "listens_to",
    "inheritance", "delegate",
}


def _build_calltrace_index(project_root: str) -> Dict[str, Any]:
    """Walks vault/*.md once, returns:
      asset_to_record:    asset_path → {title, relative_path, node_type, intent,
                                        risk_level, edges (nested)}
      title_to_asset:     resolved-target-name → asset_path
      reverse_adjacency:  callee_asset → [{source: caller_asset, edge_type, refs}]

    Edges in frontmatter are stored under nested `edges:` blocks with
    `target = <title>` (not asset_path).  We keep edges as-is for outbound BFS;
    reverse_adjacency is the same data inverted (callee → callers) for inbound
    BFS.  Self-edges and edges with no matching target asset are simply skipped
    — they're cross-engine references or stale entries from before a rename.
    """
    root = vault_writer.vault_root(project_root)
    asset_to_record: Dict[str, Dict[str, Any]] = {}
    title_to_asset: Dict[str, str] = {}
    reverse_adjacency: Dict[str, List[Dict[str, Any]]] = {}
    if not root.exists():
        return {
            "asset_to_record": asset_to_record,
            "title_to_asset": title_to_asset,
            "reverse_adjacency": reverse_adjacency,
        }

    for path in root.rglob("*.md"):
        if path.name.startswith("_"):
            continue
        # Skip Systems aggregate pages — they describe a system, not a
        # call-graph node, and their `edges` block (if any) is L1-derived.
        if path.parent.name == "Systems":
            continue
        fm = vault_writer.read_existing_frontmatter(path)
        if not fm or not isinstance(fm, dict):
            continue
        asset_path = fm.get("asset_path")
        if not isinstance(asset_path, str) or not asset_path:
            continue

        title = path.stem
        record = {
            "title": title,
            "relative_path": str(path.relative_to(root)).replace("\\", "/"),
            "asset_path": asset_path,
            "node_type": fm.get("type") or fm.get("node_type") or "Blueprint",
            "intent": fm.get("intent"),
            "risk_level": fm.get("risk_level") or "nominal",
            "edges": fm.get("edges") if isinstance(fm.get("edges"), dict) else {},
        }
        asset_to_record[asset_path] = record
        title_to_asset[title] = asset_path

    # Second pass: invert edges into reverse_adjacency.  Done after asset/title
    # indexing because edge `target` values are titles that need resolving to
    # asset_paths via title_to_asset.  Skipped types and unresolvable targets
    # mirror the outbound BFS's filtering so the two directions stay symmetric.
    for caller_asset, rec in asset_to_record.items():
        edges_block = rec.get("edges") or {}
        if not isinstance(edges_block, dict):
            continue
        for edge_type, entries in edges_block.items():
            if edge_type not in ALLOWED_EDGE_TYPES:
                continue
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                target_title = entry.get("target")
                if not isinstance(target_title, str) or not target_title:
                    continue
                target_asset = title_to_asset.get(target_title)
                if not target_asset:
                    continue
                refs = entry.get("refs") or []
                reverse_adjacency.setdefault(target_asset, []).append({
                    "source": caller_asset,
                    "edge_type": edge_type,
                    "refs": [str(r) for r in refs] if isinstance(refs, list) else [],
                })

    return {
        "asset_to_record": asset_to_record,
        "title_to_asset": title_to_asset,
        "reverse_adjacency": reverse_adjacency,
    }


ALLOWED_CALLTRACE_DIRECTIONS = {"outbound", "inbound"}


@app.get("/api/v1/calltrace")
async def vault_calltrace(
    project_root: str,
    root_asset_path: str,
    max_depth: int = DEFAULT_CALLTRACE_DEPTH,
    max_nodes: int = DEFAULT_CALLTRACE_NODES,
    edge_types: Optional[str] = None,
    direction: str = "outbound",
):
    if not project_root:
        raise HTTPException(status_code=400, detail="project_root is required")
    if not root_asset_path:
        raise HTTPException(status_code=400, detail="root_asset_path is required")

    direction = (direction or "outbound").lower().strip()
    if direction not in ALLOWED_CALLTRACE_DIRECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"direction must be one of {sorted(ALLOWED_CALLTRACE_DIRECTIONS)}",
        )

    # Sanitise depth / nodes — accept any positive int but clamp to sane upper
    # bounds so a malformed query string can't make the BFS run away.
    max_depth = max(0, min(int(max_depth), 8))
    max_nodes = max(1, min(int(max_nodes), 500))

    requested_types: Optional[set[str]] = None
    if edge_types:
        wanted = {t.strip() for t in edge_types.split(",") if t.strip()}
        # Silently drop unknown edge types rather than 400 — keeps the URL
        # forgiving when the client URL-encodes an unfamiliar type.
        requested_types = wanted & ALLOWED_EDGE_TYPES
        if not requested_types:
            requested_types = None  # treat empty filter as "all types"

    index = _build_calltrace_index(project_root)
    asset_to_record = index["asset_to_record"]
    title_to_asset = index["title_to_asset"]
    reverse_adjacency = index["reverse_adjacency"]

    if root_asset_path not in asset_to_record:
        raise HTTPException(
            status_code=404,
            detail=f"No vault note found with asset_path={root_asset_path}. "
                   f"Run a project scan first.",
        )

    nodes_out: List[Dict[str, Any]] = []
    edges_out: List[Dict[str, Any]] = []
    visited: Dict[str, int] = {root_asset_path: 0}
    queue: List[tuple[str, int]] = [(root_asset_path, 0)]
    truncated = False

    while queue and len(nodes_out) < max_nodes:
        cur, depth = queue.pop(0)
        rec = asset_to_record.get(cur)
        if not rec:
            # Edge endpoint that resolved to a vault title but has no record
            # (race against a vault edit) — emit as a stub so the UI can still
            # plot it without dangling references.
            nodes_out.append({
                "asset_path": cur,
                "title": cur.rsplit("/", 1)[-1].split(".")[0] if "/" in cur else cur,
                "layer": depth,
                "node_type": "Blueprint",
                "intent": None,
                "risk_level": "nominal",
                "missing": True,
            })
            continue
        nodes_out.append({
            "asset_path": cur,
            "title": rec["title"],
            "layer": depth,
            "node_type": rec["node_type"],
            "intent": rec.get("intent"),
            "risk_level": rec.get("risk_level") or "nominal",
        })
        if depth >= max_depth:
            continue

        # ── Outbound: follow rec["edges"] (cur → neighbours)
        # ── Inbound:  follow reverse_adjacency[cur] (callers → cur)
        # In both cases the emitted edge keeps its real direction
        # (source = caller, target = callee).  Layer reflects BFS distance from
        # root, so for inbound the root sits at the centre and its callers
        # ring outward at layer 1, callers-of-callers at layer 2, etc.
        if direction == "outbound":
            for edge_type, entries in (rec["edges"] or {}).items():
                if not isinstance(entries, list):
                    continue
                if requested_types and edge_type not in requested_types:
                    continue
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    target_title = entry.get("target")
                    if not isinstance(target_title, str) or not target_title:
                        continue
                    target_asset = title_to_asset.get(target_title)
                    if not target_asset:
                        # Target not in vault (engine class, stale rename) — skip.
                        continue
                    refs = entry.get("refs") or []
                    edges_out.append({
                        "source": cur,
                        "target": target_asset,
                        "edge_type": edge_type,
                        "refs": [str(r) for r in refs] if isinstance(refs, list) else [],
                    })
                    if target_asset not in visited:
                        visited[target_asset] = depth + 1
                        if len(nodes_out) + len(queue) < max_nodes:
                            queue.append((target_asset, depth + 1))
                        else:
                            truncated = True
        else:  # inbound
            for caller_entry in reverse_adjacency.get(cur, []):
                edge_type = caller_entry["edge_type"]
                if requested_types and edge_type not in requested_types:
                    continue
                caller_asset = caller_entry["source"]
                edges_out.append({
                    "source": caller_asset,
                    "target": cur,
                    "edge_type": edge_type,
                    "refs": list(caller_entry.get("refs") or []),
                })
                if caller_asset not in visited:
                    visited[caller_asset] = depth + 1
                    if len(nodes_out) + len(queue) < max_nodes:
                        queue.append((caller_asset, depth + 1))
                    else:
                        truncated = True

    if queue:
        truncated = True

    return {
        "root": root_asset_path,
        "direction": direction,
        "max_depth": max_depth,
        "max_nodes": max_nodes,
        "edge_types": sorted(requested_types) if requested_types else None,
        "nodes": nodes_out,
        "edges": edges_out,
        "truncated": truncated,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
