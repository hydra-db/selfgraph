import asyncio
import re

import pytest
from helpers import run

from selfgraph import EntityInput, LLMConfig, ValidationError
from selfgraph._ops import _require_text
from selfgraph.errors import error_reason, surface_hint
from selfgraph.extraction.chunking import _chunk_by_chars, chunk_text
from selfgraph.extraction.extractor import DefaultExtractor, _EntitiesOut
from selfgraph.llm.base import _fatal, _require_provider, _sends_temperature, resolve_llm, summarize_error
from selfgraph.models import ParsedDocument
from selfgraph.runtime import GraphSettings, _build_llm
from selfgraph.stores.falkordb import FalkorDBStore


class AuthenticationError(Exception):
    status_code = 401


class NotFoundError(Exception):
    status_code = 404


class _Attempt:
    def __init__(self, exception: Exception) -> None:
        self.exception = exception


class InstructorRetryException(Exception):
    def __init__(self, last: Exception) -> None:
        super().__init__("<failed_attempts>\n<generation number=1>")
        self.failed_attempts = [_Attempt(last)]


def test_non_retryable_errors_map_to_one_clear_message():
    config = LLMConfig(provider="gemini", model="gemini-3-flash-preview", base_url="http://x")
    auth = _fatal(AuthenticationError('{\n "error": "API key not valid"\n}'), config, "gemini/gemini-3-flash-preview")
    assert str(auth) == (
        "LLM authentication failed for provider gemini: check the API key, set by "
        "api_key in the llm config (or SELFGRAPH_LLM_API_KEY)"
    )
    missing = _fatal(InstructorRetryException(NotFoundError("404")), config, "gemini/x")
    assert "was not found for provider gemini at http://x" in str(missing)
    malformed = _fatal(ValueError("No tool calls or function call found in response"), config, "gemini/x")
    assert "did not return structured output" in str(malformed)
    missing_key = _fatal(RuntimeError("litellm.APIConnectionError: Missing Gemini API key."), config, "gemini/x")
    assert str(missing_key) == (
        "no API key for LLM provider gemini: pass api_key in the llm config (or SELFGRAPH_LLM_API_KEY), "
        "or set the provider's GEMINI_API_KEY or GOOGLE_API_KEY variable"
    )
    openai_key = RuntimeError(
        "The api_key client option must be set either by passing api_key to the client or by setting the "
        "OPENAI_API_KEY environment variable"
    )
    assert str(_fatal(openai_key, LLMConfig(provider="openai", model="gpt-4o-mini"), "openai/gpt-4o-mini")) == (
        "no API key for LLM provider openai: pass api_key in the llm config (or SELFGRAPH_LLM_API_KEY), "
        "or set the provider's OPENAI_API_KEY variable"
    )
    credentials = RuntimeError(
        "litellm.InternalServerError: InternalServerError: OpenAIException - Missing credentials. Please pass an "
        "`api_key`, `workload_identity`, `admin_api_key`, or set the `OPENAI_API_KEY` environment variable."
    )
    openai = LLMConfig(provider="openai", model="gpt-4o-mini")
    assert surface_hint(str(_fatal(credentials, openai, "openai/gpt-4o-mini"))) == (
        "no API key for LLM provider openai: pass --llm-api-key (or SELFGRAPH_LLM_API_KEY), "
        "or set the provider's OPENAI_API_KEY variable"
    )
    assert _fatal(RuntimeError("rate limited"), config, "gemini/x") is None


def test_errors_are_summarized_to_one_capped_line_and_gemini_gets_no_temperature():
    wrapped = InstructorRetryException(ValueError("\x1b[1mNo tool calls\x1b[0m\nModelResponse(...)"))
    assert summarize_error(wrapped) == "ValueError: No tool calls"
    assert len(summarize_error(RuntimeError("z" * 1000))) == 300
    assert _sends_temperature("openai/gpt-4o")
    assert not _sends_temperature("gemini/gemini-2.5-flash")
    assert not _sends_temperature("gemini/gemini-3-flash-preview")


def test_llm_config_rejects_unknown_shapes_and_keys_and_takes_a_timeout():
    class Chat:
        def chat(self) -> None: ...

    with pytest.raises(ValidationError, match="llm must be an LLMConfig"):
        resolve_llm(Chat())
    with pytest.raises(ValidationError, match="got object"):
        resolve_llm(object())
    with pytest.raises(ValidationError, match="unknown key 'apikey' in llm config; did you mean 'api_key'"):
        LLMConfig(provider="openai", model="gpt-4o-mini", apikey="k")
    with pytest.raises(ValidationError, match="unknown key 'apikey' in llm config"):
        resolve_llm({"provider": "openai", "model": "gpt-4o-mini", "apikey": "k"})
    config = LLMConfig(provider="openai", model="m")
    assert (config.timeout, config.concurrency) == (120, 4)
    with pytest.raises(ValidationError, match="invalid llm config"):
        resolve_llm({"provider": "openai"})
    for fields, message in (
        ({"provider": "openai"}, "invalid llm config: model: field required"),
        ({"provider": "openai", "model": "m", "timeout": -1}, "invalid llm config: timeout: must be > 0"),
        ({"provider": "openai", "model": "m", "concurrency": 0}, "invalid llm config: concurrency: must be >= 1"),
        ({"provider": "anthropic", "model": "gemini/x"}, "provider 'anthropic' conflicts with model prefix 'gemini'"),
    ):
        with pytest.raises(ValidationError) as exc:
            LLMConfig(**fields)
        assert str(exc.value) == message


@pytest.mark.parametrize(
    ("provider", "known", "suggestion"),
    [
        ("nonesuch", ["anthropic", "gemini", "ollama", "openai"], None),
        ("opnai", ["anthropic", "gemini", "ollama", "openai"], "openai"),
        ("nope", ["poe", "openai"], None),
        ("poex", ["poe", "openai"], "poe"),
    ],
)
def test_unknown_llm_provider_suggests_only_within_one_edit(provider, known, suggestion):
    _require_provider("OpenAI", known)
    with pytest.raises(ValidationError, match=f"^unknown LLM provider '{provider}': use a litellm provider") as exc:
        _require_provider(provider, known)
    if suggestion is None:
        assert "did you mean" not in str(exc.value)
    else:
        assert str(exc.value).endswith(f"did you mean '{suggestion}'?")


def test_empty_and_wrongly_typed_text_have_distinct_messages():
    with pytest.raises(ValidationError, match="^namespace cannot be empty$"):
        _require_text("namespace", "  ")
    with pytest.raises(ValidationError, match="^namespace must be a string, got int$"):
        _require_text("namespace", 5)


def test_chunk_text_validates_sizes_defaults_the_overlap_and_splits_on_word_boundaries():
    for kwargs in ({"max_tokens": 0}, {"overlap_tokens": -1}, {"max_tokens": 8, "overlap_tokens": 8}):
        with pytest.raises(ValidationError):
            chunk_text("some text", **kwargs)
    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa " * 20
    assert chunk_text(text, max_tokens=16) == chunk_text(text, max_tokens=16, overlap_tokens=4)
    assert chunk_text(text, max_tokens=1)
    long = text * 20
    assert chunk_text(long, max_tokens=400) == chunk_text(long, max_tokens=400, overlap_tokens=64)
    assert chunk_text(long, max_tokens=400) != chunk_text(long, max_tokens=400, overlap_tokens=100)
    chunks = _chunk_by_chars(text, size=40, overlap=12)
    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk.start_offset == 0 or text[chunk.start_offset - 1] == " "
        assert chunk.end_offset == len(text) or text[chunk.end_offset] == " "
        assert len(chunk.text) <= 40


def test_error_reasons_fill_empty_messages_and_strip_driver_boilerplate():
    try:
        try:
            raise ConnectionRefusedError(111, "Connection refused")
        except OSError as inner:
            raise RuntimeError("Cannot connect to API: ") from inner
    except RuntimeError as exc:
        assert error_reason(exc) == "Cannot connect to API: connection refused"
    assert error_reason(RuntimeError("Socket closed unexpectedly..")) == "Socket closed unexpectedly"
    assert error_reason(RuntimeError("")) == "RuntimeError"
    boilerplate = (
        "Connection Failed. Please ensure that your database is listening on the correct host and port and that you "
        "have enabled encryption if required. Note that the default encryption setting has changed in Neo4j 4.0. "
        "See the docs for more information. Failed to establish encrypted connection"
    )
    assert error_reason(RuntimeError(f"[ConnectionResetError] {boilerplate}")) == (
        "[ConnectionResetError] Failed to establish encrypted connection"
    )
    js = (
        "Failed to connect to server. Please ensure that your database is listening on the correct host and port and "
        "that you have compatible encryption settings both on Neo4j server and driver. Note that the default "
        "encryption setting has changed in Neo4j 4.0. Caused by: socket disconnected"
    )
    assert error_reason(RuntimeError(js)) == "Failed to connect to server. Caused by: socket disconnected"


def test_falkordb_store_rejects_unknown_options():
    pytest.importorskip("falkordb")
    with pytest.raises(ValidationError, match="unknown option 'graphName' for FalkorDBStore; did you mean 'graph'"):
        FalkorDBStore("localhost", 6379, graphName="g")
    FalkorDBStore("localhost", 6379, graph="g", socket_timeout=5)


def test_settings_build_the_llm_config():
    assert _build_llm(GraphSettings(llm_model="gemini/gemini-3.7-flash")).provider == "gemini"
    with pytest.raises(ValidationError, match="provider-prefixed model"):
        _build_llm(GraphSettings(llm_model="gpt-4o-mini"))
    assert _build_llm(GraphSettings(llm_provider="gemini", llm_model="google/x")).model == "google/x"
    assert _build_llm(GraphSettings(llm_provider="openrouter", llm_model="anthropic/claude")).provider == "openrouter"
    assert _build_llm(GraphSettings(llm_provider="openai", llm_model="anthropic/x", llm_base_url="http://h")).model
    assert _build_llm(GraphSettings(llm_provider="openai", llm_model="meta-llama/x")).model == "meta-llama/x"
    defaults = _build_llm(GraphSettings(llm_model="openai/m"))
    assert (defaults.timeout, defaults.concurrency) == (120, 4)
    tuned = _build_llm(GraphSettings(llm_model="openai/m", llm_timeout="30", llm_concurrency=" 7 "))
    assert (tuned.timeout, tuned.concurrency) == (30, 7)
    with pytest.raises(ValidationError, match="llm_timeout must be a positive number of seconds"):
        _build_llm(GraphSettings(llm_model="openai/m", llm_timeout="soon"))


def test_chunks_extract_concurrently_up_to_the_setting_and_merge_in_order():
    class Gauge:
        def __init__(self, concurrency):
            self.concurrency, self.active, self.peak = concurrency, 0, 0

        async def generate(self, *, system, user, output):
            self.active += 1
            self.peak = max(self.peak, self.active)
            await asyncio.sleep(0.01)
            self.active -= 1
            if output is _EntitiesOut:
                await asyncio.sleep(0.03 if "Chunk0" in user else 0)
                return _EntitiesOut(entities=[EntityInput(type="Word", name=re.search(r"Chunk\d+", user).group(0))])
            return output()

    text = " ".join(f"Chunk{i} filler words here. " * 300 for i in range(6))
    document = ParsedDocument(text=text, media_type="text/plain")
    orders = []
    for concurrency, peak in ((1, 4), (2, 8)):
        llm = Gauge(concurrency)
        orders.append([e.name for e in run(DefaultExtractor(llm).extract(document)).entities])
        assert llm.peak == peak
    assert orders[0] == orders[1] == [f"Chunk{i}" for i in range(6)]
