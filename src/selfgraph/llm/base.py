from __future__ import annotations

from typing import TypeVar

from ..errors import ExtractionError
from ..models import LLMConfig
from ..protocols import LLMClient

__all__ = ["build_llm_client", "resolve_llm"]

T = TypeVar("T")


class _UnifiedLLMClient:
    def __init__(self, config: LLMConfig) -> None:
        try:
            import instructor
            from litellm import acompletion
        except ImportError as exc:  # pragma: no cover
            raise ExtractionError(
                "an LLM needs the 'instructor' and 'litellm' packages; install selfgraph[llm]"
            ) from exc
        self._client = instructor.from_litellm(acompletion)
        self._config = config
        self._model = config.model if "/" in config.model else f"{config.provider}/{config.model}"

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
        kwargs = {
            "temperature": self._config.temperature,
            "max_retries": self._config.max_retries,
            "drop_params": True,
        }
        if self._config.api_key is not None:
            kwargs["api_key"] = self._config.api_key
        if self._config.base_url is not None:
            kwargs["api_base"] = self._config.base_url
        return await self._client.chat.completions.create(
            model=self._model, messages=messages, response_model=output, **kwargs
        )


def build_llm_client(config: LLMConfig) -> LLMClient:
    """Build a unified LLM client that routes to any provider through litellm.

    @param config (LLMConfig): the provider, model, and connection settings.
    @return (LLMClient): the client.
    """
    return _UnifiedLLMClient(config)


def resolve_llm(llm: LLMConfig | LLMClient | None) -> LLMClient | None:
    """Normalise the llm argument to an LLMClient or None.

    @param llm (LLMConfig | LLMClient | None): the client argument to normalise.
    @return (LLMClient | None): the resolved client, or None.
    """
    if llm is None:
        return None
    if isinstance(llm, LLMConfig):
        return build_llm_client(llm)
    return llm
