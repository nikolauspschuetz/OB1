"""Slack connector — polls conversations.history for allowed channels.

Captures each message as a thought with structured source-attribution
metadata so the dashboard can filter by channel / thread / actor and
the entity worker can pull people + tools + projects out of the body.

Required env (per profile):
  SLACK_BOT_TOKEN          xoxb-... bot token with channels:history,
                           groups:history (private channels), users:read
                           scopes. Get it from the Slack app's "OAuth
                           & Permissions" → "Bot User OAuth Token".

Optional env:
  SLACK_ALLOWED_CHANNELS   Comma-separated channel names (without #).
                           Defaults to all channels the bot is in. Use
                           this to exclude #leadership, #hr, etc.
  SLACK_BACKFILL_DAYS      How far back to look on first run (no state
                           file). Default 7.
  SLACK_MIN_LEN            Min message length to capture. Default 20.
  SLACK_POLL_SECONDS       Watch-mode poll interval. Default 300 (5m).

Live ingest (push) is a separate /webhook/slack endpoint on the MCP
server and is documented in .planning/external-sources-design.md. The
poll-based importer here works without exposing a public URL — best
for v1.
"""
from __future__ import annotations

import json
import time
import typing as t
import urllib.parse

from ..base import Capture, Connector, HttpError, http_request


class SlackConnector(Connector):
    name = "slack"
    version = "0.1.0"
    required_env = ("SLACK_BOT_TOKEN",)
    optional_env = (
        "SLACK_ALLOWED_CHANNELS",
        "SLACK_BACKFILL_DAYS",
        "SLACK_MIN_LEN",
        "SLACK_POLL_SECONDS",
    )

    API_BASE = "https://slack.com/api"

    def configure(self) -> bool:
        self.token = self.env.get("SLACK_BOT_TOKEN", "").strip()
        if not self.token:
            return False
        self.allowed_channels = {
            c.strip() for c in self.env.get("SLACK_ALLOWED_CHANNELS", "").split(",") if c.strip()
        }
        self.backfill_days = int(self.env.get("SLACK_BACKFILL_DAYS", "7"))
        self._user_cache: dict[str, dict[str, str]] = {}
        self._workspace_url: str | None = None
        return True

    def _api(self, method: str, **params: t.Any) -> dict[str, t.Any]:
        """GET to Slack Web API. Tokens go in the Authorization header
        (bot tokens). Returns the parsed JSON; raises on `ok=false`."""
        url = f"{self.API_BASE}/{method}"
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        status, _hdrs, body = http_request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        data = json.loads(body)
        if not data.get("ok"):
            # auth_test failures show as `not_authed` / `invalid_auth`;
            # surface clearly so docs can guide remediation.
            err = data.get("error", "unknown_error")
            raise HttpError(status, f"slack {method} returned ok=false: {err}")
        return data

    def _resolve_workspace_url(self) -> str:
        """One-time auth.test to learn workspace domain for deep links."""
        if self._workspace_url:
            return self._workspace_url
        data = self._api("auth.test")
        # auth.test returns url like "https://my-team.slack.com/"
        self._workspace_url = data.get("url", "https://slack.com/").rstrip("/")
        return self._workspace_url

    def _resolve_user(self, user_id: str) -> dict[str, str]:
        """Cache user_id → {name, real_name, email}."""
        if user_id in self._user_cache:
            return self._user_cache[user_id]
        try:
            data = self._api("users.info", user=user_id)
        except HttpError as e:
            self.log.debug("users.info failed for %s: %s", user_id, e)
            self._user_cache[user_id] = {"name": user_id, "real_name": user_id}
            return self._user_cache[user_id]
        u = data.get("user", {})
        profile = u.get("profile", {})
        info = {
            "name": u.get("name") or user_id,
            "real_name": u.get("real_name") or profile.get("real_name") or user_id,
            "email": profile.get("email", ""),
        }
        self._user_cache[user_id] = info
        return info

    def _list_channels(self) -> list[dict[str, t.Any]]:
        """Public + private channels the bot is a member of."""
        out: list[dict[str, t.Any]] = []
        cursor: str | None = None
        while True:
            data = self._api(
                "users.conversations",
                types="public_channel,private_channel",
                limit=200,
                cursor=cursor,
                exclude_archived=True,
            )
            for ch in data.get("channels", []):
                name = ch.get("name", "")
                if self.allowed_channels and name not in self.allowed_channels:
                    continue
                out.append(ch)
            cursor = data.get("response_metadata", {}).get("next_cursor") or None
            if not cursor:
                break
        return out

    def _format_message(
        self,
        channel: dict[str, t.Any],
        msg: dict[str, t.Any],
        parent: dict[str, t.Any] | None,
    ) -> Capture | None:
        text = msg.get("text", "")
        if not text:
            return None
        # Skip bot messages (including OB1's own webhook captures bouncing
        # back through a bot integration) and join/leave noise.
        if msg.get("subtype") in {"channel_join", "channel_leave", "bot_message"}:
            return None
        user_id = msg.get("user") or msg.get("bot_id") or "unknown"
        user_info = self._resolve_user(user_id) if user_id != "unknown" else {"name": "bot", "real_name": "bot"}
        ts = msg.get("ts", "")
        thread_ts = msg.get("thread_ts") or ts

        # Replies prepend the parent text for thread coherence.
        content_parts: list[str] = []
        if parent and parent.get("ts") != ts:
            parent_user = self._resolve_user(parent.get("user") or "unknown")
            content_parts.append(
                f"[thread parent — {parent_user.get('real_name', '')}] {parent.get('text', '').strip()}"
            )
        content_parts.append(f"{user_info.get('real_name', '')}: {text.strip()}")
        content = "\n\n".join(content_parts)

        workspace = self._resolve_workspace_url()
        ts_for_url = ts.replace(".", "")
        url = f"{workspace}/archives/{channel['id']}/p{ts_for_url}"
        if thread_ts != ts:
            url += f"?thread_ts={thread_ts}&cid={channel['id']}"

        return Capture(
            content=content,
            metadata={
                "source_id": f"{channel['id']}/{ts}",
                "source_actor": user_id,
                "source_actor_name": user_info.get("real_name") or user_info.get("name"),
                "source_actor_email": user_info.get("email") or None,
                "source_url": url,
                "source_channel": channel.get("name"),
                "source_channel_id": channel.get("id"),
                "source_thread_root": thread_ts if thread_ts != ts else None,
                "source_ts": ts,
            },
            source_id=ts,
        )

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        # state shape: { "channels": { "<channel_id>": "<last_ts>" } }
        per_channel = state.setdefault("channels", {})
        channels = self._list_channels()
        self.log.info("scanning %d channel(s)", len(channels))

        backfill_oldest = str(int(time.time()) - self.backfill_days * 86400)

        for ch in channels:
            ch_id = ch["id"]
            ch_name = ch.get("name", ch_id)
            oldest = per_channel.get(ch_id, backfill_oldest)
            cursor: str | None = None
            count = 0

            def advance(ts: str) -> None:
                """Per-message cursor advance. Checkpoint state every
                yield so a mid-batch break (rate limit, max_per_run)
                doesn't lose progress."""
                current = per_channel.get(ch_id, oldest)
                if ts > current:
                    per_channel[ch_id] = ts

            while True:
                try:
                    data = self._api(
                        "conversations.history",
                        channel=ch_id,
                        oldest=per_channel.get(ch_id, oldest),
                        limit=200,
                        cursor=cursor,
                    )
                except HttpError as e:
                    self.log.warning("conversations.history failed for #%s: %s", ch_name, e)
                    break
                messages = data.get("messages", [])
                # API returns newest first; reverse so we yield oldest-first.
                for msg in reversed(messages):
                    cap = self._format_message(ch, msg, parent=None)
                    if cap:
                        count += 1
                        yield cap
                    ts = msg.get("ts", "")
                    if ts:
                        advance(ts)
                    # Pull thread replies for messages that have them.
                    if msg.get("thread_ts") == msg.get("ts") and int(msg.get("reply_count", 0)) > 0:
                        try:
                            replies_data = self._api(
                                "conversations.replies",
                                channel=ch_id,
                                ts=msg["ts"],
                            )
                        except HttpError as e:
                            self.log.debug("replies fetch failed: %s", e)
                            continue
                        for rep in replies_data.get("messages", [])[1:]:  # skip parent
                            rep_cap = self._format_message(ch, rep, parent=msg)
                            if rep_cap:
                                count += 1
                                yield rep_cap
                            rts = rep.get("ts", "")
                            if rts:
                                advance(rts)
                cursor = data.get("response_metadata", {}).get("next_cursor") or None
                if not cursor or not messages:
                    break
            self.log.info("  #%s: %d new", ch_name, count)
