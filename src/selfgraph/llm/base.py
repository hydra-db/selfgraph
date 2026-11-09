from __future__ import annotations

import logging
import re
from collections.abc import Iterator, Mapping
from typing import TypeVar

from ..errors import _DANGLING, KEY_SOURCES, ExtractionError, ValidationError, error_reason, setting_hint
from ..models import LLMConfig, as_input, did_you_mean, suggest_key
from ..protocols import LLMClient

__all__ = ["build_llm_client", "resolve_llm", "summarize_error"]

T = TypeVar("T")

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_JSON_MODE_PROVIDERS = frozenset({"gemini", "vertex_ai"})
_KEY_HINT = f"check the API key, set by {KEY_SOURCES}"
_KEY_VAR = re.compile(r"\b(?!SELFGRAPH_)[A-Z][A-Z0-9_]*_API_KEY\b")
_BAD_KEY = re.compile(r"API[_ ]KEY[_ ]INVALID|api key not valid|(?:valid|invalid|incorrect) api key", re.IGNORECASE)
_MISSING_KEY = re.compile(r"missing .*api key|api_key client option must be set|missing credentials", re.IGNORECASE)
_KEY_ENV = {"gemini": "GEMINI_API_KEY or GOOGLE_API_KEY", "google": "GEMINI_API_KEY or GOOGLE_API_KEY"}
_RERAISED = ("API call failed on attempt", "Max retries exceeded")
_SUMMARY_LIMIT = 300


def _drop_reraised(record: logging.LogRecord) -> bool:
    """Drop instructor's error logs for failures SelfGraph re-raises or reports as warnings.

    @param record (logging.LogRecord): the log record.
    @return (bool): False to drop the record.
    """
    return not str(record.msg).startswith(_RERAISED)


def _sends_temperature(model: str) -> bool:
    """Report whether to send a temperature; Gemini models get none, as their sampling parameters are deprecated.

    @param model (str): the litellm model id.
    @return (bool): False for any Gemini model.
    """
    return "gemini" not in model.lower()


def _causes(exc: BaseException) -> Iterator[BaseException]:
    """Yield an error, the last attempt of a retry wrapper, and its cause chain.

    @param exc (BaseException): the raised error.
    @return (Iterator[BaseException]): the error and the errors behind it.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        attempts = getattr(current, "failed_attempts", None) or []
        last = getattr(attempts[-1], "exception", None) if attempts else None
        current = last if isinstance(last, BaseException) else current.__cause__


def summarize_error(exc: BaseException) -> str:
    """Summarize an error as ``ErrorType: first line``, unwrapping retry wrappers and capping the length.

    @param exc (BaseException): the error.
    @return (str): the one-line summary.
    """
    err = exc
    for err in _causes(exc):
        if not getattr(err, "failed_attempts", None):
            break
    line = next((line.strip() for line in _ANSI.sub("", str(err)).splitlines() if line.strip()), "")
    if not line or _DANGLING.search(line):
        line = _ANSI.sub("", error_reason(err))
    text = f"{type(err).__name__}: {line}"
    return text if len(text) <= _SUMMARY_LIMIT else text[: _SUMMARY_LIMIT - 3] + "..."


def _fatal(exc: BaseException, config: LLMConfig, model: str) -> ExtractionError | None:
    """Map an error no retry can fix (missing or bad key, denied access, unknown model, no structured output).

    @param exc (BaseException): the raised error.
    @param config (LLMConfig): the LLM settings, for the message.
    @param model (str): the litellm model id, for the message.
    @return (ExtractionError | None): the error to raise, or None when the call may succeed on retry or another chunk.
    """
    provider = config.provider
    for err in _causes(exc):
        name = type(err).__name__
        status = getattr(err, "status_code", None)
        text = str(err)
        if _MISSING_KEY.search(text):
            var = _KEY_ENV.get(provider.lower()) or (found.group(0) if (found := _KEY_VAR.search(text)) else None)
            own = f"the provider's {var} variable" if var else "the provider's own key variable"
            return ExtractionError(f"no API key for LLM provider {provider}: pass {KEY_SOURCES}, or set {own}")
        if name == "AuthenticationError" or status == 401 or _BAD_KEY.search(text):
            return ExtractionError(f"LLM authentication failed for provider {provider}: {_KEY_HINT}")
        if name == "PermissionDeniedError" or status == 403:
            return ExtractionError(f"LLM access denied for provider {provider} and model {config.model!r}: {_KEY_HINT}")
        if name == "NotFoundError" or status == 404 or "LLM Provider NOT provided" in text:
            where = f" at {config.base_url}" if config.base_url else ""
            return ExtractionError(
                f"LLM model {config.model!r} was not found for provider {provider}{where}: "
                f"check {setting_hint('llm_model')} and the provider"
            )
        if "MALFORMED_FUNCTION_CALL" in text or "No tool calls or function call found" in text:
            return ExtractionError(
                f"LLM model {model!r} did not return structured output; try another model for extraction"
            )
    return None


def _require_provider(provider: str, known: list[str]) -> None:
    """Reject a provider litellm does not route to, suggesting the closest known one.

    @param provider (str): the configured provider.
    @param known (list[str]): the litellm provider names.
    @return (None): nothing; raises ValidationError on an unknown provider.
    """
    name = provider.lower()
    if name in known:
        return
    hint = did_you_mean(suggest_key(name, sorted(known), 1 if len(name) < 5 else 2))
    raise ValidationError(
        f"unknown LLM provider {provider!r}: use a litellm provider such as anthropic, openai, gemini, or ollama, "
        f"or openai with base_url for an OpenAI-compatible endpoint{hint}"
    )


def check_llm_config(config: LLMConfig) -> None:
    """Reject an LLM config whose provider litellm does not route to, the check building the client runs.

    Without litellm installed the check is skipped, since building the client reports the missing package.

    @param config (LLMConfig): the LLM settings.
    @return (None): nothing; raises ValidationError on an unknown provider.
    """
    try:
        import litellm
    except ImportError:
        return
    _require_provider(config.provider, [str(getattr(p, "value", p)) for p in litellm.provider_list])


class _UnifiedLLMClient:
    def __init__(self, config: LLMConfig) -> None:
        try:
            import instructor
            import litellm
            from litellm import acompletion
        except ImportError as exc:  # pragma: no cover
            raise ExtractionError(
                "an LLM needs the 'instructor' and 'litellm' packages; pip install \"selfgraph[llm]\""
            ) from exc
        check_llm_config(config)
        litellm.suppress_debug_info = True
        litellm.set_verbose = False
        retry_logger = logging.getLogger("instructor.v2.retry")
        if _drop_reraised not in retry_logger.filters:
            retry_logger.addFilter(_drop_reraised)
        self._config = config
        self.concurrency = config.concurrency
        prefixed = config.model.lower().startswith(f"{config.provider.lower()}/")
        self._model = config.model if prefixed else f"{config.provider}/{config.model}"
        family = self._model.split("/", 1)[0].lower()
        mode = instructor.Mode.JSON if family in _JSON_MODE_PROVIDERS else instructor.Mode.TOOLS
        self._client = instructor.from_litellm(acompletion, mode=mode)

    async def generate(self, *, system: str, user: str, output: type[T]) -> T:
        """Call the model and parse its reply into the requested type.

        @param system (str): the system prompt.
        @param user (str): the user prompt.
        @param output (type[T]): the pydantic type to parse the reply into.
        @return (T): the parsed structured output.
        """
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})
        kwargs = {"max_retries": self._config.max_retries, "drop_params": True}
        if _sends_temperature(self._model):
            kwargs["temperature"] = self._config.temperature
        if self._config.api_key is not None:
            kwargs["api_key"] = self._config.api_key
        if self._config.base_url is not None:
            kwargs["api_base"] = self._config.base_url
        if self._config.timeout is not None:
            kwargs["timeout"] = self._config.timeout
        try:
            return await self._client.chat.completions.create(
                model=self._model, messages=messages, response_model=output, **kwargs
            )
        except Exception as exc:
            fatal = _fatal(exc, self._config, self._model)
            if fatal is not None:
                raise fatal from exc
            raise


def build_llm_client(config: LLMConfig) -> LLMClient:
    """Build a unified LLM client that routes to any provider through litellm.

    @param config (LLMConfig): the provider, model, and connection settings.
    @return (LLMClient): the client.
    """
    return _UnifiedLLMClient(config)


def resolve_llm(llm: LLMConfig | Mapping | LLMClient | None) -> LLMClient | None:
    """Normalise the llm argument to an LLMClient or None.

    @param llm (LLMConfig | Mapping | LLMClient | None): an LLMConfig, a mapping of its fields, or an object with
        an async ``generate(system=, user=, output=)`` method.
    @return (LLMClient | None): the resolved client, or None.
    """
    if llm is None:
        return None
    if isinstance(llm, LLMConfig):
        return build_llm_client(llm)
    if callable(getattr(llm, "generate", None)):
        return llm
    if isinstance(llm, Mapping) and ("provider" in llm or "model" in llm):
        return build_llm_client(as_input(LLMConfig, llm, "llm config"))
    raise ValidationError(
        "llm must be an LLMConfig (provider, model, api_key, base_url, timeout), a mapping of those fields, or an "
        f"LLMClient with an async generate(system=, user=, output=) method; got {type(llm).__name__}"
    )
