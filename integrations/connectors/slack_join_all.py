"""Bulk-join the OB1 Slack bot to every public channel in a workspace.

By default the connector only ingests channels the bot is a member of,
and Slack requires explicit per-channel invitation. For PUBLIC channels
the bot can self-join via conversations.join (needs the `channels:join`
bot scope — already in connectors/slack-manifest.json). Private channels
still require a manual /invite; this script skips them.

Usage (from the repo root):
    python3 -m integrations.connectors.slack_join_all --env-file .env.linguado
    python3 -m integrations.connectors.slack_join_all --env-file .env.linguado --dry-run
    python3 -m integrations.connectors.slack_join_all --token xoxb-... --exclude general,random

Behavior:
  - Lists every non-archived public channel.
  - Skips channels the bot is already in (is_member=true) and any in
    --exclude.
  - Joins the rest, throttled to stay under Slack's Tier-3 rate limit
    (~50 req/min) — sleeps 1.3s between joins.
  - `already_in_channel` responses are treated as success, not error.

After it finishes, the next importer poll cycle will pick up history
from all the newly-joined channels automatically.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from .base import HttpError, http_request

API_BASE = "https://slack.com/api"
JOIN_DELAY_S = 1.3  # ~46 joins/min, safely under the Tier-3 ceiling


def _read_token_from_env_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("SLACK_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        print(f"ERROR: env file not found: {path}", file=sys.stderr)
        sys.exit(2)
    print(f"ERROR: SLACK_BOT_TOKEN not found in {path}", file=sys.stderr)
    sys.exit(2)


def _api(method: str, token: str, params: dict | None = None) -> dict:
    from urllib.parse import urlencode

    url = f"{API_BASE}/{method}"
    if params:
        url += "?" + urlencode({k: v for k, v in params.items() if v is not None})
    _status, _hdrs, body = http_request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    data = json.loads(body)
    return data


def _api_post(method: str, token: str, params: dict) -> dict:
    from urllib.parse import urlencode

    body = urlencode(params).encode("utf-8")
    _status, _hdrs, resp = http_request(
        f"{API_BASE}/{method}",
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body=body,
    )
    return json.loads(resp)


def list_public_channels(token: str) -> list[dict]:
    out: list[dict] = []
    cursor: str | None = None
    while True:
        data = _api(
            "conversations.list",
            token,
            {
                "types": "public_channel",
                "exclude_archived": "true",
                "limit": 200,
                "cursor": cursor,
            },
        )
        if not data.get("ok"):
            print(f"ERROR: conversations.list returned ok=false: {data.get('error')}", file=sys.stderr)
            sys.exit(1)
        out.extend(data.get("channels", []))
        cursor = (data.get("response_metadata") or {}).get("next_cursor") or None
        if not cursor:
            break
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="slack_join_all",
        description="Bulk-join the OB1 bot to every public Slack channel",
    )
    parser.add_argument(
        "--env-file",
        help="Path to .env.<profile> to read SLACK_BOT_TOKEN from",
    )
    parser.add_argument(
        "--token",
        help="SLACK_BOT_TOKEN directly (overrides --env-file)",
    )
    parser.add_argument(
        "--exclude",
        default="",
        help="Comma-separated channel names to skip (e.g. 'general,random,announcements')",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be joined without joining",
    )
    args = parser.parse_args()

    token = args.token
    if not token and args.env_file:
        token = _read_token_from_env_file(args.env_file)
    if not token:
        print("ERROR: provide --token or --env-file", file=sys.stderr)
        return 2
    if not token.startswith("xoxb-"):
        print(f"WARNING: expected a bot token (xoxb-...), got '{token[:8]}…'", file=sys.stderr)

    exclude = {c.strip().lstrip("#") for c in args.exclude.split(",") if c.strip()}

    # Confirm the token works + show which workspace we're acting on.
    auth = _api("auth.test", token)
    if not auth.get("ok"):
        print(f"ERROR: auth.test failed: {auth.get('error')}", file=sys.stderr)
        return 1
    print(f"workspace: {auth.get('team')}  bot: {auth.get('user')}")

    channels = list_public_channels(token)
    already_in = [c for c in channels if c.get("is_member")]
    excluded = [c for c in channels if c["name"] in exclude]
    to_join = [
        c for c in channels
        if not c.get("is_member") and c["name"] not in exclude
    ]

    print(
        f"public channels: {len(channels)} total — "
        f"{len(already_in)} already joined, {len(excluded)} excluded, "
        f"{len(to_join)} to join"
    )
    if not to_join:
        print("nothing to do.")
        return 0

    if args.dry_run:
        print("\n--dry-run — would join:")
        for c in to_join:
            print(f"  #{c['name']}  (id={c['id']})")
        return 0

    print(f"\njoining {len(to_join)} channel(s), ~{JOIN_DELAY_S}s apart...")
    joined = 0
    failed = 0
    for i, c in enumerate(to_join, 1):
        try:
            res = _api_post("conversations.join", token, {"channel": c["id"]})
        except HttpError as e:
            print(f"  [{i}/{len(to_join)}] #{c['name']}: transport error {e}", file=sys.stderr)
            failed += 1
            continue
        if res.get("ok") or res.get("error") == "already_in_channel":
            joined += 1
            print(f"  [{i}/{len(to_join)}] #{c['name']}: joined")
        else:
            failed += 1
            print(
                f"  [{i}/{len(to_join)}] #{c['name']}: FAILED ({res.get('error')})",
                file=sys.stderr,
            )
        if i < len(to_join):
            time.sleep(JOIN_DELAY_S)

    print(f"\ndone. joined={joined} failed={failed}")
    print("the next importer poll cycle will backfill history from the new channels.")
    return 1 if failed and joined == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
