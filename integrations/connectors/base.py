"""
Connector framework — abstract base + shared infrastructure for OB1
external source ingestion.

Every source (Slack, Gmail, GitHub, Linear, Figma, Notion, calendar,
Claude Code session history, …) lives as a Connector subclass that
implements three things:

  1. `configure(env)` — pull source-specific credentials/scope out of
     env vars; return True iff the connector has the minimum it needs
     to run (no credentials = silent no-op, not an error).
  2. `fetch_new(state)` — yield Capture objects for new content since
     last sync. State is a connector-private dict the framework
     loads/saves around each run.
  3. `name` / `version` class attributes — identifier stored in
     `metadata.source` of every capture so the dashboard can filter.

The framework handles:
  - Stateful polling with per-connector state files (~/.cache/ob1/
    <profile>/<connector>-state.json by default, /var/state/... in
    Docker).
  - SHA-256 content fingerprint dedup matching OB1's normalization
    (so re-runs are no-ops even after state file loss).
  - POSTing captures to OB1's /mcp tools/call capture_thought endpoint.
    The MCP server handles embedding + pgvector indexing + entity
    extraction queue automatically — connectors never bypass it.
  - --once / --watch / --source X CLI dispatch via runner.py.
  - Rate-limit and 429 backoff baked into the HTTP helper.

Adding a new source = ~50 LOC subclass. See connectors/slack.py for
the canonical full example; connectors/gmail.py etc. are stubs that
show the shape without a real implementation.
"""
from __future__ import annotations

import abc
import dataclasses
import hashlib
import json
import logging
import os
import pathlib
import sys
import time
import typing as t
import urllib.error
import urllib.parse
import urllib.request


@dataclasses.dataclass
class Capture:
    """A single piece of content ready to be sent to OB1.

    `content`: the text body that goes into thoughts.content.
    `metadata`: source-attribution fields plus any source-specific
                extras (channel, thread root, attendees, …). Framework
                injects `source`, `source_version`, `imported_at`.
    `source_id`: a stable id used by the connector to advance its
                 own state (e.g. Slack ts, Gmail Message-ID). Not
                 stored on the OB1 side; the framework dedups via
                 content fingerprint.
    """

    content: str
    metadata: dict[str, t.Any]
    source_id: str | None = None


@dataclasses.dataclass
class RunResult:
    """Returned by Connector.run_once() so the runner can log a summary."""

    connector: str
    fetched: int
    captured: int
    skipped: int
    errors: int
    duration_ms: int


# ---------------------------------------------------------------------------
# HTTP helper — stdlib only, retries 429 / 5xx with exponential backoff.
# ---------------------------------------------------------------------------

class HttpError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


def http_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
    max_retries: int = 4,
) -> tuple[int, dict[str, str], bytes]:
    """Wrapper around urllib with 429/5xx exponential backoff.

    Returns (status, headers, body_bytes). Raises HttpError on
    permanent non-2xx after retries. Honors Retry-After when present.
    """
    backoff = 1.0
    last_exc: BaseException | None = None
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, method=method, data=body)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                buf = resp.read()
                return resp.status, dict(resp.headers), buf
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            retryable = e.code in (408, 429, 500, 502, 503, 504)
            if not retryable or attempt == max_retries:
                raise HttpError(e.code, body_text) from e
            # Honor Retry-After header if present
            wait = backoff
            ra = e.headers.get("Retry-After") if hasattr(e, "headers") else None
            if ra:
                try:
                    wait = max(wait, float(ra))
                except ValueError:
                    pass
            time.sleep(wait)
            backoff = min(backoff * 2, 30.0)
            last_exc = e
        except urllib.error.URLError as e:
            if attempt == max_retries:
                raise HttpError(0, str(e)) from e
            time.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
            last_exc = e
    raise HttpError(0, f"max retries exhausted: {last_exc}")


def fingerprint(text: str) -> str:
    """SHA-256 of the normalized text — matches db/migrations/003_dedup.sql.

    Connectors don't strictly need this (OB1 dedups on the server side
    too) but having it client-side lets us skip the network call for
    already-seen content.
    """
    normalized = " ".join(text.lower().split()).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# OB1 capture client — uses /mcp tools/call capture_thought so the server's
# normal pipeline (embedding, entity extraction queue, fingerprint dedup,
# attribution log on update) runs for every imported capture.
# ---------------------------------------------------------------------------

class OB1Client:
    def __init__(self, base_url: str, access_key: str, logger: logging.Logger):
        self.base_url = base_url.rstrip("/")
        self.access_key = access_key
        self.log = logger

    def capture(
        self,
        cap: Capture,
        request_id: int = 1,
        *,
        extract_topics: bool = False,
    ) -> tuple[bool, str | None]:
        """POST capture_thought via /mcp. Returns (success, error_text).

        Content is truncated to 8000 chars to match the server's
        embedding-side cap. Metadata is passed through wholesale —
        the server allows arbitrary JSONB and the entity worker /
        dashboard read it back.

        extract_topics=False (the connector-friendly default) tells
        the server to skip the LLM metadata-extraction step. External
        sources already supply structured metadata (channel, actor,
        url) so the extraction is duplicate work AND a rate-limit
        amplifier. The entity-extraction worker still runs async via
        the entity_extraction_queue — entity/topic enrichment happens
        either way.
        """
        if not self.access_key:
            return False, "OB1_KEY not set"
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "name": "capture_thought",
                "arguments": {
                    "content": cap.content[:8000],
                    "metadata": cap.metadata,
                    "extract_topics": extract_topics,
                },
            },
        }).encode("utf-8")
        try:
            _status, _hdrs, resp_body = http_request(
                f"{self.base_url}/mcp",
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "x-brain-key": self.access_key,
                },
                body=body,
            )
        except HttpError as e:
            return False, f"transport: {e}"
        # MCP streamable-http returns SSE-style "event: message\ndata: {...}".
        text = resp_body.decode("utf-8", errors="replace")
        # Parse the data: line to inspect isError properly. A tool
        # error returns 200 OK with result.isError=true; we must not
        # treat that as success.
        data_line = next(
            (line[len("data: "):] for line in text.splitlines() if line.startswith("data: ")),
            None,
        )
        if not data_line:
            return False, f"no data line in response: {text[:200]}"
        try:
            payload = json.loads(data_line)
        except Exception as e:
            return False, f"parse failed: {e}; body={text[:200]}"
        result = payload.get("result")
        if not result:
            err = payload.get("error", {})
            return False, f"jsonrpc error: {err.get('message') or err}"
        if result.get("isError"):
            msg = ""
            content = result.get("content") or []
            if content and isinstance(content[0], dict):
                msg = content[0].get("text", "")
            return False, msg[:300]
        return True, None


# ---------------------------------------------------------------------------
# Per-connector state — JSON file at <state_dir>/<connector_name>-state.json
# Connectors decide what to store; the framework just loads/saves blindly.
# ---------------------------------------------------------------------------

class StateStore:
    def __init__(self, state_dir: pathlib.Path, connector_name: str):
        self.path = state_dir / f"{connector_name}-state.json"

    def load(self) -> dict[str, t.Any]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text())
        except Exception:
            return {}

    def save(self, state: dict[str, t.Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
        tmp.replace(self.path)


# ---------------------------------------------------------------------------
# Connector abstract base
# ---------------------------------------------------------------------------

class Connector(abc.ABC):
    """Subclass to add a new source. Override `configure` and
    `fetch_new`; everything else is shared infrastructure."""

    name: str = "unnamed"
    version: str = "0.1.0"

    # Connector-specific env vars the runner will summarize so a user
    # can `python -m connectors doctor` and see which are populated.
    required_env: tuple[str, ...] = ()
    optional_env: tuple[str, ...] = ()

    def __init__(
        self,
        ob1: OB1Client,
        state_dir: pathlib.Path,
        env: dict[str, str],
        logger: logging.Logger | None = None,
    ):
        self.ob1 = ob1
        self.state = StateStore(state_dir, self.name)
        self.env = env
        self.log = logger or logging.getLogger(f"connector.{self.name}")
        self._configured = False

    # ----- subclasses MUST implement these ---------------------------------

    @abc.abstractmethod
    def configure(self) -> bool:
        """Pull credentials/scope from self.env. Return True iff the
        connector has enough config to run. Empty/missing creds → False
        (silent no-op, NOT an error)."""

    @abc.abstractmethod
    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        """Yield Captures for new content since last sync. Mutate
        `state` in place to advance the cursor — the framework saves
        whatever you leave there. Raise on auth/network errors."""

    # ----- subclasses MAY override these ----------------------------------

    def poll_seconds(self) -> int:
        """Override per-source. Default 15 min."""
        return int(self.env.get(f"{self.name.upper()}_POLL_SECONDS", "900"))

    def min_content_length(self) -> int:
        return int(self.env.get(f"{self.name.upper()}_MIN_LEN", "20"))

    # ----- framework-provided machinery -----------------------------------

    def stamp_metadata(self, meta: dict[str, t.Any]) -> dict[str, t.Any]:
        """Inject source/version/imported_at without clobbering caller's
        own keys. Connectors should NOT set these themselves."""
        out = dict(meta)
        out.setdefault("source", self.name)
        out.setdefault("source_version", self.version)
        out.setdefault("imported_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        if profile := self.env.get("OB1_PROFILE"):
            out.setdefault("context", profile)
        return out

    def per_capture_delay_ms(self) -> int:
        """Throttle between captures to respect upstream rate limits.
        Override per source. Default 400ms ≈ 150 captures/min — well
        under GitHub Models' embedding limit. Worth keeping for any
        OpenAI-compatible provider."""
        return int(self.env.get(f"{self.name.upper()}_CAPTURE_DELAY_MS",
                                 self.env.get("CAPTURE_DELAY_MS", "400")))

    def capture_max_per_run(self) -> int:
        """Cap captures per run so a huge backfill doesn't block the
        watch loop forever. Connector state advances after each
        success so subsequent --watch ticks pick up where this left
        off. Default 200 per run (≈1.5 min at 400ms delay)."""
        return int(self.env.get(f"{self.name.upper()}_MAX_PER_RUN",
                                 self.env.get("CAPTURE_MAX_PER_RUN", "200")))

    def run_once(self) -> RunResult:
        """Load state, fetch new captures, POST each, save state.
        Idempotent — content_fingerprint dedups on the server side.
        Throttled — per_capture_delay_ms between captures, capped at
        capture_max_per_run captures per call so 429s don't compound."""
        if not self._configured:
            ok = self.configure()
            self._configured = ok
        if not self._configured:
            self.log.debug("%s skipped: not configured", self.name)
            return RunResult(self.name, 0, 0, 0, 0, 0)

        t0 = time.time()
        state = self.state.load()
        delay = self.per_capture_delay_ms() / 1000.0
        max_per_run = self.capture_max_per_run()
        fetched = captured = skipped = errors = 0
        rid = 1
        consecutive_errors = 0
        try:
            for cap in self.fetch_new(state):
                fetched += 1
                if len(cap.content.strip()) < self.min_content_length():
                    skipped += 1
                    continue
                cap.metadata = self.stamp_metadata(cap.metadata)
                ok, err = self.ob1.capture(cap, request_id=rid)
                rid += 1
                if ok:
                    captured += 1
                    consecutive_errors = 0
                else:
                    errors += 1
                    consecutive_errors += 1
                    if errors <= 3 or errors % 50 == 0:
                        self.log.warning(
                            "[%s] capture failed: %s", self.name, err,
                        )
                    # Likely rate-limit — back off harder to let the
                    # upstream LLM provider recover. Next run picks
                    # up the cursor.
                    if consecutive_errors >= 5:
                        self.log.warning(
                            "[%s] %d consecutive errors; stopping this run",
                            self.name, consecutive_errors,
                        )
                        break
                if captured >= max_per_run:
                    self.log.info(
                        "[%s] hit capture_max_per_run=%d; will resume next tick",
                        self.name, max_per_run,
                    )
                    break
                if delay > 0:
                    time.sleep(delay)
        except Exception as e:
            self.log.exception("%s fetch_new failed: %s", self.name, e)
            errors += 1
        finally:
            self.state.save(state)
        dur = int((time.time() - t0) * 1000)
        return RunResult(self.name, fetched, captured, skipped, errors, dur)

    def doctor(self) -> dict[str, t.Any]:
        """Return a config-readiness summary for the runner's doctor
        subcommand — names of present/missing env vars without leaking
        values."""
        out: dict[str, t.Any] = {
            "name": self.name,
            "version": self.version,
            "required_env": {},
            "optional_env": {},
            "configured": False,
        }
        for k in self.required_env:
            out["required_env"][k] = bool(self.env.get(k))
        for k in self.optional_env:
            out["optional_env"][k] = bool(self.env.get(k))
        # Don't trigger network here — just config readiness.
        if all(self.env.get(k) for k in self.required_env):
            out["configured"] = True
        return out
