"""Pluggable LLM provider layer used by the batch + single-node scan paths.

Three providers are wired in today:
  - VolcengineProvider     — OpenAI-compatible Doubao endpoint at ark.cn-beijing
  - ClaudeProvider         — Anthropic /v1/messages, optionally with extended thinking
  - OpenAICompatProvider   — generic OpenAI-compatible /v1/chat/completions
                             (OpenAI itself, OpenRouter, DeepSeek, Together,
                             Groq, Fireworks, local LM Studio / Ollama, …)

The backend never persists API keys.  Every request that reaches /scan/* or
/llm/* must include a fresh `provider_config` dict from the client; this
module wraps it into the appropriate provider, runs the call, and discards.
Logs mask keys via mask_key() so accidental log scrapes don't leak secrets.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import json
from typing import Optional, Dict, Any, List


# ─────────────────────────────────────────────────────────────────────────────
# Effort → Claude extended-thinking budget.  "low" disables thinking entirely;
# the upper end is bounded by what the model accepts (Opus/Sonnet 4.x allow
# very large budgets, Haiku is more constrained).  These map by name only —
# the model decides whether the budget is honoured.
# ─────────────────────────────────────────────────────────────────────────────
EFFORT_TO_BUDGET: Dict[str, int] = {
    "low":         0,        # thinking disabled
    "medium":      4096,
    "high":        16384,
    "extra_high":  32768,
    "max":         65536,
}


@dataclass
class LLMResponse:
    raw_text: str
    tokens_in: int = 0
    tokens_out: int = 0
    thinking_tokens: int = 0     # Claude only; 0 elsewhere
    model: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)


class LLMProvider(ABC):
    @abstractmethod
    async def analyze(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 4096,
    ) -> LLMResponse:
        ...

    async def ping(self) -> LLMResponse:
        """Tiny round-trip used by /llm/test-connection.  Default impl works for
        any provider that respects the analyze() contract."""
        return await self.analyze(
            system_prompt="You are a connectivity probe. Reply with exactly one word.",
            user_prompt="Reply with the single word: PONG",
            max_tokens=32,
        )

    @property
    @abstractmethod
    def display_name(self) -> str: ...

    @property
    @abstractmethod
    def model_label(self) -> str: ...


# ─────────────────────────────────────────────────────────────────────────────
# Volcengine (Doubao) — OpenAI-compatible REST surface
# ─────────────────────────────────────────────────────────────────────────────

class VolcengineProvider(LLMProvider):
    BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"

    def __init__(self, api_key: str, endpoint: str):
        if not api_key:
            raise ValueError("Volcengine provider requires api_key")
        if not endpoint:
            raise ValueError("Volcengine provider requires endpoint id (ep-...)")
        from openai import AsyncOpenAI  # local import — keeps module import-cheap
        self._client = AsyncOpenAI(api_key=api_key, base_url=self.BASE_URL)
        self._endpoint = endpoint

    async def analyze(self, system_prompt, user_prompt, max_tokens: int = 4096) -> LLMResponse:
        resp = await self._client.chat.completions.create(
            model=self._endpoint,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=max_tokens,
        )
        choice = resp.choices[0]
        usage = resp.usage
        return LLMResponse(
            raw_text=choice.message.content or "",
            tokens_in=getattr(usage, "prompt_tokens", 0) if usage else 0,
            tokens_out=getattr(usage, "completion_tokens", 0) if usage else 0,
            model=self._endpoint,
        )

    @property
    def display_name(self) -> str:
        return "Volcengine (Doubao)"

    @property
    def model_label(self) -> str:
        return self._endpoint


# ─────────────────────────────────────────────────────────────────────────────
# Generic OpenAI-compatible provider
#
# Anything that speaks OpenAI's /v1/chat/completions surface plugs in here:
# OpenAI itself, OpenRouter, DeepSeek, Together, Groq, Fireworks, local
# LM Studio / Ollama / vLLM, Azure OpenAI in passthrough mode, etc.  We don't
# normalise the URL beyond stripping a trailing slash — if the server speaks
# the protocol the AsyncOpenAI client will reach it.
#
# Volcengine is intentionally kept separate so its hard-coded ark.cn-beijing
# base_url stays in code (the typical Doubao user only ships the endpoint id);
# this provider is the escape hatch for everyone else.
#
# No prompt caching here — caching is provider-specific and the OpenAI surface
# doesn't expose Anthropic's `cache_control` block.  Volume users on this
# provider should pick a server that has its own caching (e.g. DeepSeek's
# "context cache" headers) and drive it from outside this module if needed.
# ─────────────────────────────────────────────────────────────────────────────

class OpenAICompatProvider(LLMProvider):
    def __init__(self, api_key: str, base_url: str, model: str):
        if not api_key:
            raise ValueError("OpenAI-compatible provider requires api_key")
        if not base_url:
            raise ValueError("OpenAI-compatible provider requires base_url (e.g. https://api.openai.com/v1)")
        if not model:
            raise ValueError("OpenAI-compatible provider requires model (e.g. gpt-4o-mini, deepseek-chat)")
        from openai import AsyncOpenAI  # local import — keeps module import-cheap
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url.rstrip("/"))
        self._base_url = base_url.rstrip("/")
        self._model = model

    # Field names known to carry the visible LLM output across the wide
    # range of "OpenAI-compatible" proxies in the wild.  Order = priority.
    # When `content` is empty we walk these in order, falling back to a
    # raw-dict scan if nothing matches — so adding a new proxy to the
    # supported set typically requires nothing more than appending its
    # field name here, AND the raw dump in `extra.message_dump` lets the
    # operator identify unknown fields without touching code.
    #
    # Documented sightings:
    #   reasoning_content  — DeepSeek-R1 / Qwen-QwQ / Claude-via-LiteLLM
    #   thinking           — some self-hosted Claude proxies (one-api / new-api)
    #   thinking_text      — early DeepSeek-R1 builds
    #   reasoning          — generic OpenAI-style reasoning shim
    #   text / output_text — minimalist proxies that don't follow the
    #                        ChatCompletionMessage shape strictly
    _FALLBACK_TEXT_FIELDS: tuple = (
        "reasoning_content",
        "thinking",
        "thinking_text",
        "reasoning",
        "text",
        "output_text",
    )

    @staticmethod
    def _join_block_texts(blocks: List[Any]) -> str:
        """Anthropic-style content arrays — `[{type:'text', text:...}, ...]`
        — leak through some proxies (anything that wraps Claude / Bedrock /
        Vertex passes the native shape verbatim).  Concatenate the `text`
        slots, ignoring `thinking` / `tool_use` / unknown block types unless
        nothing else is available."""
        prefer_texts: List[str] = []
        any_texts: List[str] = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = b.get("text")
            if not isinstance(t, str) or not t.strip():
                continue
            if b.get("type") == "text":
                prefer_texts.append(t.strip())
            else:
                any_texts.append(t.strip())
        if prefer_texts:
            return "\n".join(prefer_texts)
        return "\n".join(any_texts)

    @staticmethod
    def _walk_for_text(obj: Any, path: str = "", out: Optional[List[tuple]] = None) -> List[tuple]:
        """Last-resort walker: recurse through a dict / list and collect every
        string field longer than 20 chars, paired with its path.  When all
        named-field fallbacks miss, the caller picks the longest entry as
        "probably the answer".  20 char floor filters out role names,
        finish reasons, type tags, and other short metadata."""
        if out is None:
            out = []
        if isinstance(obj, str):
            if len(obj.strip()) > 20:
                out.append((path, obj.strip()))
        elif isinstance(obj, dict):
            for k, v in obj.items():
                OpenAICompatProvider._walk_for_text(
                    v, f"{path}.{k}" if path else k, out
                )
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                OpenAICompatProvider._walk_for_text(v, f"{path}[{i}]", out)
        return out

    async def _analyze_via_stream(
        self, system_prompt: str, user_prompt: str, max_tokens: int
    ) -> str:
        """Stream-mode fallback used when non-stream returns empty content
        despite non-zero completion_tokens.

        Why this works for some broken proxies: OpenAI-compat proxies that
        route Chat Completions requests internally through OpenAI's newer
        Responses API (visible by `id` prefix `resp_...` in the response)
        sometimes mis-map content during back-conversion in the non-stream
        path.  Their stream path is usually a separate implementation and
        forwards `delta.content` chunks faithfully because there's no
        intermediate object reshape — chunks just pass through.

        Accumulate `delta.content` from each event.  Some proxies stream
        reasoning content under `delta.reasoning_content` instead — we pick
        that up too so DeepSeek-R1 / Claude-thinking-via-proxy responses
        don't slip through.

        Returns the concatenated text or "" if the stream also yielded
        nothing.  Intentionally swallows non-fatal per-chunk parse glitches
        (chunks with no `delta` field, etc.) — goal is "salvage what we
        can", not "exact replay".
        """
        chunks: List[str] = []
        stream = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=max_tokens,
            stream=True,
        )
        try:
            async for event in stream:
                if not getattr(event, "choices", None):
                    continue
                ch = event.choices[0]
                delta = getattr(ch, "delta", None)
                if delta is None:
                    continue
                # Standard content chunk.
                content_chunk = getattr(delta, "content", None)
                if isinstance(content_chunk, str) and content_chunk:
                    chunks.append(content_chunk)
                    continue
                # Reasoning-content chunk (DeepSeek-R1 / Claude thinking).
                # Pulled via model_dump so SDK pydantic stripping doesn't hide it.
                try:
                    if hasattr(delta, "model_dump"):
                        d = delta.model_dump(exclude_none=False)
                        for fname in self._FALLBACK_TEXT_FIELDS:
                            v = d.get(fname)
                            if isinstance(v, str) and v:
                                chunks.append(v)
                                break
                except Exception:
                    pass
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    await close()
                except Exception:
                    pass
        return "".join(chunks)

    async def analyze(self, system_prompt, user_prompt, max_tokens: int = 4096) -> LLMResponse:
        # CRITICAL: use `with_raw_response` to bypass pydantic parsing.  The
        # openai SDK's ChatCompletionMessage model declares only a fixed set
        # of fields (content / refusal / role / annotations / audio /
        # function_call / tool_calls) and silently DROPS everything else
        # during parse — including `reasoning_content`, `thinking`,
        # `thinking_blocks`, and any custom field a proxy invents.  By the
        # time we'd see the parsed object those fields are gone forever.
        # `with_raw_response` returns an APIResponse wrapping the raw HTTP
        # body, which we json.loads directly — preserves every field the
        # server actually sent.  Cost: one extra json.loads per call.
        raw_resp = await self._client.chat.completions.with_raw_response.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=max_tokens,
        )

        # Typed parse for usage / finish_reason — these are well-defined
        # standard fields, no proxy variance issues.
        parsed = raw_resp.parse()
        choice = parsed.choices[0] if parsed.choices else None
        usage = parsed.usage
        finish_reason = getattr(choice, "finish_reason", None) if choice else None

        # The raw HTTP body, untouched by SDK parsing.  Try multiple SDK
        # surface variations (.text property, .text() method, .json()
        # method, .http_response.text) since OpenAI's Python SDK has shifted
        # this API across minor versions.
        raw_body: Dict[str, Any] = {}
        try:
            text_attr = getattr(raw_resp, "text", None)
            if callable(text_attr):
                body_str = text_attr()
            elif isinstance(text_attr, str):
                body_str = text_attr
            else:
                body_str = None
            if body_str:
                raw_body = json.loads(body_str)
        except (json.JSONDecodeError, Exception):
            pass
        if not raw_body:
            try:
                json_method = getattr(raw_resp, "json", None)
                if callable(json_method):
                    raw_body = json_method() or {}
            except Exception:
                pass
        if not raw_body:
            try:
                http_resp = getattr(raw_resp, "http_response", None)
                if http_resp is not None:
                    body_str = getattr(http_resp, "text", "")
                    if body_str:
                        raw_body = json.loads(body_str)
            except (json.JSONDecodeError, Exception):
                pass

        # Drill to the message dict.  Standard OpenAI shape:
        # { choices: [ { message: { ... } } ] }
        raw_message: Dict[str, Any] = {}
        if isinstance(raw_body, dict):
            choices = raw_body.get("choices")
            if isinstance(choices, list) and choices:
                msg = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(msg, dict):
                    raw_message = msg

        raw_text = ""
        recovered_from: Optional[str] = None

        # 1) Standard string `content`.
        content_val = raw_message.get("content") if isinstance(raw_message, dict) else None
        if isinstance(content_val, str) and content_val.strip():
            raw_text = content_val.strip()

        # 2) Anthropic-style content as a block array (proxies that forward
        #    Bedrock / Vertex / native Claude shape verbatim).
        if not raw_text and isinstance(content_val, list):
            joined = self._join_block_texts(content_val)
            if joined:
                raw_text = joined
                recovered_from = "content[blocks]"

        # 3) Known extension fields (reasoning_content, thinking, ...).
        if not raw_text and isinstance(raw_message, dict):
            for field_name in self._FALLBACK_TEXT_FIELDS:
                val = raw_message.get(field_name)
                if isinstance(val, str) and val.strip():
                    raw_text = val.strip()
                    recovered_from = field_name
                    break

        # 4) Refusal — surfaces safety-filter rejections.
        if not raw_text and isinstance(raw_message, dict):
            refusal = raw_message.get("refusal")
            if isinstance(refusal, str) and refusal.strip():
                raw_text = f"[provider returned refusal] {refusal.strip()}"
                recovered_from = "refusal"

        # 5) Unknown-shape fallback — walk the message dict for the longest
        #    string field.  Catches proxies that put output under
        #    arbitrary paths within message (e.g. `output.parts[0].text`).
        if not raw_text and raw_message:
            candidates = self._walk_for_text(raw_message)
            if candidates:
                candidates.sort(key=lambda c: len(c[1]), reverse=True)
                path, longest = candidates[0]
                raw_text = longest
                recovered_from = f"walk-msg:{path}"

        # 6) Body-level walk — when the message dict has only metadata
        #    (e.g. `{"role": "assistant"}` with no content fields at all),
        #    the actual text must live elsewhere in the response: at the
        #    choice level (`choices[0].delta.content`,
        #    `choices[0].reasoning_content`), at the top level
        #    (`{output: "..."}`, `{response: {...}}`), or under some custom
        #    sibling key.  The body walker scans EVERYTHING from the root
        #    so we don't care which branch the text fell into.  Run this
        #    whenever message-level walking found nothing — the previous
        #    gate `not raw_message` was too strict (a message with just
        #    `{role}` is non-empty but has no usable text).
        if not raw_text and isinstance(raw_body, dict):
            candidates = self._walk_for_text(raw_body)
            # Filter out fields we already know don't carry the answer —
            # `id`, `model`, `system_fingerprint`, `object`, finish reasons,
            # role tokens, etc.  These are short usually but a long model
            # id ("claude-sonnet-4-6-anthropic-bedrock-...") could trip the
            # 20-char floor.
            EXCLUDE_PATHS = {"id", "model", "object", "system_fingerprint"}
            candidates = [
                (p, t) for p, t in candidates
                if not any(p == ex or p.endswith(f".{ex}") for ex in EXCLUDE_PATHS)
            ]
            if candidates:
                candidates.sort(key=lambda c: len(c[1]), reverse=True)
                path, longest = candidates[0]
                raw_text = longest
                recovered_from = f"walk-body:{path}"

        # 7) Stream-mode retry — proxies that internally route Chat
        #    Completions requests through OpenAI's Responses API (signaled
        #    by `id` starting with `resp_`) sometimes lose `content` in
        #    the back-conversion to Chat Completions shape.  Their
        #    streaming path is usually a separate code branch and often
        #    works correctly even when non-stream is broken.  We trigger
        #    this only when:
        #      - text extraction failed entirely
        #      - usage.completion_tokens > 0 (model DID produce output;
        #        we just couldn't find it in the response shape)
        #    The retry costs another billed call, but for a one-time L1
        #    batch that's preferable to a hard failure that wastes the
        #    user's L2 work.
        completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0
        if not raw_text and completion_tokens > 0:
            try:
                stream_text = await self._analyze_via_stream(
                    system_prompt, user_prompt, max_tokens
                )
                if stream_text.strip():
                    raw_text = stream_text.strip()
                    recovered_from = "stream-fallback"
            except Exception as stream_exc:
                # Don't mask the original empty-content failure with a
                # streaming error — just record that the fallback was
                # attempted, so the operator sees both signals.
                if isinstance(raw_body, dict):
                    raw_body = {
                        **raw_body,
                        "_stream_fallback_error": f"{type(stream_exc).__name__}: {stream_exc}"[:200],
                    }

        # Stash a dump of the FULL raw body (not just the message) when
        # extraction failed.  Critical for diagnosing proxies that put text
        # outside `choices[0].message` — the message-only dump misled us
        # into thinking the response was empty when actually `delta.content`
        # or `output` had the answer all along.  3500-char ceiling so even
        # heavily-nested responses fit; truncation marker keeps the cliff
        # visible.
        message_dump: Optional[str] = None
        if not raw_text and isinstance(raw_body, dict):
            try:
                full = json.dumps(raw_body, ensure_ascii=False, default=str)
            except Exception:
                full = str(raw_body)
            if len(full) > 3500:
                message_dump = full[:3500] + " …[truncated]"
            else:
                message_dump = full

        return LLMResponse(
            raw_text=raw_text,
            tokens_in=getattr(usage, "prompt_tokens", 0) if usage else 0,
            tokens_out=getattr(usage, "completion_tokens", 0) if usage else 0,
            model=self._model,
            extra={
                "base_url": self._base_url,
                "finish_reason": finish_reason,
                "recovered_from": recovered_from,
                "message_dump": message_dump,
            },
        )

    @property
    def display_name(self) -> str:
        # Strip protocol for log readability; full URL still in extra.
        host = self._base_url.replace("https://", "").replace("http://", "")
        return f"OpenAI-compatible ({host})"

    @property
    def model_label(self) -> str:
        return self._model


# ─────────────────────────────────────────────────────────────────────────────
# Anthropic Claude — extended thinking optional
# ─────────────────────────────────────────────────────────────────────────────

# Short-name → canonical model id mapping.  Frontend ships short names; we
# resolve them server-side so a future model bump only touches this file.
_CLAUDE_MODEL_MAP: Dict[str, str] = {
    "opus":         "claude-opus-4-7",
    "opus-4-7":     "claude-opus-4-7",
    "claude-opus-4-7": "claude-opus-4-7",

    "sonnet":       "claude-sonnet-4-6",
    "sonnet-4-6":   "claude-sonnet-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",

    "haiku":        "claude-haiku-4-5-20251001",
    "haiku-4-5":    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
}


def _resolve_claude_model(short: str) -> str:
    key = (short or "").lower().strip()
    return _CLAUDE_MODEL_MAP.get(key, short or "claude-sonnet-4-6")


class ClaudeProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "sonnet", effort: str = "medium"):
        if not api_key:
            raise ValueError("Claude provider requires api_key")
        from anthropic import AsyncAnthropic  # local import keeps cold-start cheap
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = _resolve_claude_model(model)
        self._effort = effort
        self._budget = EFFORT_TO_BUDGET.get(effort, EFFORT_TO_BUDGET["medium"])

    async def analyze(self, system_prompt, user_prompt, max_tokens: int = 4096) -> LLMResponse:
        # Anthropic requires max_tokens > thinking budget.  We keep at least
        # 4k headroom for the visible reply; for very high efforts this means
        # max_tokens silently grows above the caller's request.
        if self._budget > 0 and max_tokens <= self._budget:
            max_tokens = self._budget + 4096

        # §24 prompt caching — wrap the system prompt as a list-form text block
        # with `cache_control: ephemeral`.  SYSTEM_PROMPT is ~3500 tokens and
        # identical for every node in a batch scan; without caching we'd re-pay
        # for it on each of ~90 calls (~315k tokens of pure repetition).  With
        # the 5-min ephemeral cache: first call pays 1.25× write premium, every
        # subsequent call within 5 min pays ~0.10× — ≈89% reduction on the
        # system-prompt portion.
        #
        # The breakpoint is on the LAST cacheable block (system, since tools
        # render before system in the prefix order).  user_prompt comes after
        # the breakpoint and is NOT cached — that's correct, it varies per node.
        #
        # Caching is silent on inputs below the model's minimum prefix size
        # (Sonnet 4.6: 2048 tok; Opus/Haiku 4.x: 4096 tok).  At ~3500 tok
        # SYSTEM_PROMPT clears Sonnet's bar; if the user is on Opus/Haiku and
        # cache_creation_input_tokens stays 0 we'll see it in `extra` and can
        # decide to fold tools into the cached prefix.
        kwargs: Dict[str, Any] = {
            "model": self._model,
            "max_tokens": max_tokens,
            "system": [{
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }],
            "messages": [{"role": "user", "content": user_prompt}],
        }
        if self._budget > 0:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": self._budget}
            # Extended thinking requires temperature=1
            kwargs["temperature"] = 1.0
        else:
            kwargs["temperature"] = 0.1

        resp = await self._client.messages.create(**kwargs)

        # Concatenate text blocks; thinking blocks are not surfaced to callers.
        text_parts: list[str] = []
        for block in resp.content:
            block_type = getattr(block, "type", "")
            if block_type == "text":
                text_parts.append(getattr(block, "text", ""))
            # Ignore other block types (thinking, tool_use, etc.)

        usage = resp.usage
        # Cache hit telemetry — surfaced in `extra` so analyze_one_node can log
        # it.  If cache_read_input_tokens stays 0 across a batch, a silent
        # invalidator is at work (system prompt rebuilt with date string, tools
        # set varying, etc.) — see shared/prompt-caching.md audit checklist.
        cache_creation_in = getattr(usage, "cache_creation_input_tokens", 0) or 0 if usage else 0
        cache_read_in     = getattr(usage, "cache_read_input_tokens",     0) or 0 if usage else 0

        return LLMResponse(
            raw_text="".join(text_parts),
            tokens_in=getattr(usage, "input_tokens", 0) if usage else 0,
            tokens_out=getattr(usage, "output_tokens", 0) if usage else 0,
            # Thinking tokens are bundled into output_tokens by the API — there
            # is no separate field on `usage`.  Leave at 0; the prior code
            # mis-assigned cache_creation here, which is a different concept.
            thinking_tokens=0,
            model=self._model,
            extra={
                "effort": self._effort,
                "budget": self._budget,
                "cache_creation_input_tokens": cache_creation_in,
                "cache_read_input_tokens": cache_read_in,
            },
        )

    @property
    def display_name(self) -> str:
        return "Anthropic Claude"

    @property
    def model_label(self) -> str:
        return f"{self._model} (effort={self._effort})"


# ─────────────────────────────────────────────────────────────────────────────
# Factory + log helpers
# ─────────────────────────────────────────────────────────────────────────────

def build_provider(config: Dict[str, Any]) -> LLMProvider:
    """Build a provider from a frontend-supplied config dict.

    Expected shape:
      { provider: 'volcengine' | 'claude' | 'openai_compat',
        api_key:  '...',
        endpoint: '<volc-endpoint-id>',                  # volcengine only
        model:    'opus|sonnet|haiku',                   # claude only
                  '<arbitrary model id>',                # openai_compat only
        effort:   'low|medium|high|extra_high|max',      # claude only
        base_url: 'https://api.openai.com/v1',           # openai_compat only
      }
    """
    if not isinstance(config, dict):
        raise ValueError("provider_config must be an object")
    name = (config.get("provider") or "").lower()
    api_key = config.get("api_key") or ""

    if name == "volcengine":
        endpoint = config.get("endpoint") or ""
        return VolcengineProvider(api_key=api_key, endpoint=endpoint)
    if name == "claude":
        model = config.get("model") or "sonnet"
        effort = config.get("effort") or "medium"
        return ClaudeProvider(api_key=api_key, model=model, effort=effort)
    if name == "openai_compat":
        base_url = config.get("base_url") or ""
        model = config.get("model") or ""
        return OpenAICompatProvider(api_key=api_key, base_url=base_url, model=model)

    raise ValueError(
        f"Unknown provider: {name!r}. Expected 'volcengine', 'claude', or 'openai_compat'."
    )


def mask_key(key: Optional[str]) -> str:
    """Render an API key safe for logs.  Preserves first/last few chars so the
    operator can still tell which key is in use without exposing the secret."""
    if not key:
        return "***(empty)***"
    if len(key) <= 12:
        return "***"
    return f"{key[:7]}...{key[-4:]}"
