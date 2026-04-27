"""Pluggable LLM provider layer used by the batch + single-node scan paths.

Two providers are wired in today:
  - VolcengineProvider — OpenAI-compatible Doubao endpoint at ark.cn-beijing
  - ClaudeProvider     — Anthropic /v1/messages, optionally with extended thinking

The backend never persists API keys.  Every request that reaches /scan/* or
/llm/* must include a fresh `provider_config` dict from the client; this
module wraps it into the appropriate provider, runs the call, and discards.
Logs mask keys via mask_key() so accidental log scrapes don't leak secrets.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Dict, Any


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

        kwargs: Dict[str, Any] = {
            "model": self._model,
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        }
        if self._budget > 0:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": self._budget}
            # Extended thinking requires temperature=1
            kwargs["temperature"] = 1.0
        else:
            kwargs["temperature"] = 0.1

        resp = await self._client.messages.create(**kwargs)

        # Concatenate text blocks; thinking blocks are not surfaced to callers
        # but we estimate their token cost from the SDK usage object so the UI
        # can show "thought for N tokens" later.
        text_parts: list[str] = []
        for block in resp.content:
            block_type = getattr(block, "type", "")
            if block_type == "text":
                text_parts.append(getattr(block, "text", ""))
            # Ignore other block types (thinking, tool_use, etc.)

        usage = resp.usage
        thinking_tokens = 0
        if usage is not None:
            # cache_creation_input_tokens / cache_read_input_tokens may exist
            # on the SDK usage object; we only need the visible accounting here.
            thinking_tokens = getattr(usage, "cache_creation_input_tokens", 0) or 0

        return LLMResponse(
            raw_text="".join(text_parts),
            tokens_in=getattr(usage, "input_tokens", 0) if usage else 0,
            tokens_out=getattr(usage, "output_tokens", 0) if usage else 0,
            thinking_tokens=thinking_tokens,
            model=self._model,
            extra={"effort": self._effort, "budget": self._budget},
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
      { provider: 'volcengine' | 'claude',
        api_key:  '...',
        endpoint: '<volc-endpoint-id>',     # volcengine only
        model:    'opus|sonnet|haiku',      # claude only
        effort:   'low|medium|high|extra_high|max',  # claude only
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

    raise ValueError(f"Unknown provider: {name!r}. Expected 'volcengine' or 'claude'.")


def mask_key(key: Optional[str]) -> str:
    """Render an API key safe for logs.  Preserves first/last few chars so the
    operator can still tell which key is in use without exposing the secret."""
    if not key:
        return "***(empty)***"
    if len(key) <= 12:
        return "***"
    return f"{key[:7]}...{key[-4:]}"
