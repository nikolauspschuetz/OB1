#!/usr/bin/env python3
"""
Claude Code session-history importer.

Polls ~/.claude/projects/**/*.jsonl for new user turns, dedups via SHA-256
fingerprint stored in a local state file, and POSTs each new turn to OB1's
MCP server via the capture_thought tool.

Minimal port of wardenclyffe1687/Open-brain-apk's importer pattern.
Differences:
  - No launchd; runs as a one-shot or `--watch` loop (or as a cron-style
    sidecar container).
  - Talks to OB1's MCP via streamable-http, not Supabase Edge Functions.
  - Stateless re-runs are safe: each turn's content_fingerprint is the
    OB1 upsert dedup key, so re-importing the same file is a no-op.

Usage:
    OB1_URL=http://localhost:8000 \
    OB1_KEY=<mcp-access-key> \
    python3 import.py [--once] [--watch] [--source claude-code]

Env:
    CLAUDE_PROJECTS_DIR   default ~/.claude/projects
    OB1_URL               default http://localhost:8000
    OB1_KEY               required (MCP_ACCESS_KEY value)
    IMPORT_STATE_FILE     default ~/.cache/ob1/claude-code-state.json
    IMPORT_POLL_SECONDS   default 900 (15 minutes) when --watch
    IMPORT_MIN_LEN        default 40 chars — skip very short turns
    IMPORT_MAX_LEN        default 8000 chars — truncate long turns

The state file is a JSON map of {jsonl_path: last_byte_offset_seen} so the
next poll only reads new lines. Idempotent: rotating/renaming a jsonl
re-imports its content (which OB1 then dedups by fingerprint).
"""
import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.request
import urllib.error

PROJECTS_DIR = pathlib.Path(
    os.environ.get("CLAUDE_PROJECTS_DIR")
    or os.path.expanduser("~/.claude/projects")
)
OB1_URL = os.environ.get("OB1_URL", "http://localhost:8000").rstrip("/")
OB1_KEY = os.environ.get("OB1_KEY", "")
STATE_FILE = pathlib.Path(
    os.environ.get("IMPORT_STATE_FILE")
    or os.path.expanduser("~/.cache/ob1/claude-code-state.json")
)
POLL_SECONDS = int(os.environ.get("IMPORT_POLL_SECONDS", "900"))
MIN_LEN = int(os.environ.get("IMPORT_MIN_LEN", "40"))
MAX_LEN = int(os.environ.get("IMPORT_MAX_LEN", "8000"))


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def fingerprint(text: str) -> str:
    """Match db/migrations/003_dedup.sql normalization exactly."""
    normalized = " ".join(text.lower().split()).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def extract_user_turn(record: dict) -> str | None:
    """Pull the human-typed text out of a Claude Code JSONL turn.

    Claude Code's JSONL has multiple shapes; we look for the most common
    `role=user` text blocks and skip everything else (tool_use, tool_result,
    system messages, assistant turns). Conservative: better to skip an
    ambiguous record than to import noise.
    """
    if record.get("type") != "user":
        return None
    msg = record.get("message")
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return None
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t.strip())
        if parts:
            return "\n\n".join(parts)
    return None


def capture(content: str, source: str, request_id: int) -> bool:
    """POST to OB1's /mcp tools/call?name=capture_thought. Returns success."""
    if not OB1_KEY:
        print("ERROR: OB1_KEY not set", file=sys.stderr)
        return False
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": "capture_thought",
            "arguments": {"content": content[:MAX_LEN]},
        },
    }
    req = urllib.request.Request(
        f"{OB1_URL}/mcp",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-brain-key": OB1_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            # MCP returns SSE-style "event: message\ndata: {...}".
            if "Captured" in body or '"result"' in body:
                return True
            print(
                f"WARN: unexpected response: {body[:200]}",
                file=sys.stderr,
            )
            return False
    except urllib.error.HTTPError as e:
        print(f"ERROR: HTTP {e.code}: {e.read()[:200]!r}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return False


def import_file(path: pathlib.Path, last_offset: int, source: str, seen: set) -> tuple[int, int]:
    """Read new content from path starting at last_offset; capture each new
    user turn. Returns (new_offset, captured_count)."""
    if not path.exists():
        return last_offset, 0
    try:
        size = path.stat().st_size
    except OSError:
        return last_offset, 0
    if size < last_offset:
        # File was truncated/rotated; start from 0.
        last_offset = 0

    captured = 0
    request_id = 1
    with path.open("rb") as f:
        f.seek(last_offset)
        for raw in f:
            try:
                record = json.loads(raw)
            except Exception:
                continue
            text = extract_user_turn(record)
            if not text or len(text) < MIN_LEN:
                continue
            fp = fingerprint(text)
            if fp in seen:
                continue
            seen.add(fp)
            ok = capture(text, source, request_id)
            request_id += 1
            if ok:
                captured += 1
        new_offset = f.tell()
    return new_offset, captured


def run_once(source: str) -> tuple[int, int]:
    state = load_state()
    if not PROJECTS_DIR.exists():
        print(
            f"WARN: {PROJECTS_DIR} not found — nothing to import",
            file=sys.stderr,
        )
        return 0, 0
    jsonl_files = sorted(PROJECTS_DIR.rglob("*.jsonl"))
    total_captured = 0
    total_seen = 0
    seen: set = set()
    for path in jsonl_files:
        key = str(path)
        last_offset = int(state.get(key, 0))
        new_offset, captured = import_file(path, last_offset, source, seen)
        state[key] = new_offset
        if captured:
            print(f"  {path.name}: +{captured}")
            total_captured += captured
        total_seen += 1
    save_state(state)
    return total_seen, total_captured


def main():
    parser = argparse.ArgumentParser(description="Claude Code -> OB1 importer")
    parser.add_argument("--watch", action="store_true", help="poll forever")
    parser.add_argument("--once", action="store_true", help="run once and exit")
    parser.add_argument(
        "--source",
        default="claude-code",
        help="source tag stored in metadata.source",
    )
    args = parser.parse_args()
    if not args.watch and not args.once:
        args.once = True

    if args.once:
        seen, captured = run_once(args.source)
        print(f"[claude-code-import] scanned {seen} file(s), captured {captured} new turn(s)")
        return

    while True:
        try:
            seen, captured = run_once(args.source)
            print(
                f"[claude-code-import] scanned {seen} file(s), captured {captured} — sleeping {POLL_SECONDS}s",
                flush=True,
            )
        except Exception as e:
            print(f"[claude-code-import] iteration error: {e}", file=sys.stderr)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
