"""Socket Mode bot loop + event handlers.

Hooks two Slack event types:
  - message.im  → DMs to the bot
  - app_mention → @mentions in any channel the bot is in

Both share the same router: parse → capture or query → reply.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
import typing as t

from slack_sdk.errors import SlackApiError
from slack_sdk.socket_mode import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.web import WebClient

from .ob1_client import OB1Client, OB1Error


CAPTURE_PREFIXES = ("remember:", "remember ", "note:", "note ", "capture:", "capture ")
HELP_TEXT = (
    "*Open Brain* — your team's second brain.\n"
    "• *DM me a question* to query the brain (RAG-grounded, with citations).\n"
    "• *DM me `remember: <text>`* to capture a thought.\n"
    "• *@mention me anywhere* and I'll reply in-thread.\n"
)


def make_logger() -> logging.Logger:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return logging.getLogger("slack-bot")


def parse_command(text: str, bot_user_id: str | None) -> tuple[str, str]:
    """Strip bot mention prefix, classify into ("capture" | "query" | "help", payload)."""
    # Strip leading <@BOTID> mention if present (@-mentions in channel arrive
    # as "<@U02XYZ> hello").
    if bot_user_id:
        text = re.sub(rf"^\s*<@{bot_user_id}>\s*", "", text)
    text = text.strip()
    if not text:
        return "help", ""
    lowered = text.lower()
    for prefix in CAPTURE_PREFIXES:
        if lowered.startswith(prefix):
            payload = text[len(prefix):].strip()
            if not payload:
                return "help", ""
            return "capture", payload
    if lowered in {"help", "?", "what can you do?", "what can you do"}:
        return "help", ""
    return "query", text


def render_answer_for_slack(
    answer: str,
    retrieved: list[dict],
    dashboard_url: str | None,
) -> str:
    """Convert [#xxxxxxxx] markers + retrieved set into a Slack-friendly
    message. Slack mrkdwn doesn't render markdown headings or tables
    well, but inline link syntax (<url|text>) works."""
    out = answer
    if dashboard_url and retrieved:
        # Replace [#xxxx] markers with <dashboard/thoughts/UUID|#xxxx>.
        short_to_full: dict[str, str] = {}
        for r in retrieved:
            tid = r.get("id", "")
            if tid:
                short_to_full[tid[:8]] = tid

        def sub(m: re.Match) -> str:
            short = m.group(1)
            full = short_to_full.get(short)
            if full:
                return f"<{dashboard_url}/thoughts/{full}|#{short}>"
            return m.group(0)

        out = re.sub(r"\[#([0-9a-f]{8})\]", sub, out)
    # Append a sources footer if there are retrievals at all.
    if retrieved:
        lines = ["", "_Top sources retrieved:_"]
        for r in retrieved[:5]:
            sim = r.get("similarity", 0)
            try:
                sim = float(sim)
            except (TypeError, ValueError):
                sim = 0.0
            tid = r.get("id", "")
            snippet = (r.get("content") or "").replace("\n", " ").strip()[:100]
            short = tid[:8]
            if dashboard_url and tid:
                lines.append(f"• <{dashboard_url}/thoughts/{tid}|`#{short}`> sim {sim:.2f} — {snippet}")
            else:
                lines.append(f"• `#{short}` sim {sim:.2f} — {snippet}")
        out = out + "\n" + "\n".join(lines)
    return out


class Bot:
    def __init__(self, log: logging.Logger):
        self.log = log
        self.app_token = os.environ["SLACK_APP_TOKEN"]
        self.bot_token = os.environ["SLACK_BOT_TOKEN"]
        self.dashboard_url = (os.environ.get("DASHBOARD_PUBLIC_URL") or "").rstrip("/")
        self.ob1 = OB1Client(log=log)
        self.web = WebClient(token=self.bot_token)
        # Resolve our own user_id once so we can strip @-mentions cleanly.
        try:
            self.bot_user_id = self.web.auth_test()["user_id"]
            self.log.info("bot user_id=%s", self.bot_user_id)
        except SlackApiError as e:
            self.log.error("auth_test failed: %s", e)
            self.bot_user_id = None
        self.client = SocketModeClient(
            app_token=self.app_token,
            web_client=self.web,
        )
        self.client.socket_mode_request_listeners.append(self._on_request)

    def start(self) -> None:
        self.log.info("connecting to Slack via Socket Mode")
        self.client.connect()
        # Block forever — connect() returns immediately after handshake.
        while True:
            time.sleep(60)

    def _on_request(self, client: SocketModeClient, req: SocketModeRequest) -> None:
        # Always ack first — Slack retries within 3s if we don't.
        client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
        # Defer to a worker thread so the main socket loop stays responsive.
        threading.Thread(target=self._handle, args=(req,), daemon=True).start()

    def _handle(self, req: SocketModeRequest) -> None:
        try:
            if req.type == "events_api":
                event = (req.payload or {}).get("event", {})
                etype = event.get("type")
                if etype in {"message", "app_mention"}:
                    self._handle_message(event)
                else:
                    self.log.debug("ignoring event type=%s", etype)
        except Exception as e:
            self.log.exception("handler crashed: %s", e)

    def _handle_message(self, event: dict) -> None:
        # Drop bot's own messages and edits/deletions.
        if event.get("subtype") in {"bot_message", "message_changed", "message_deleted"}:
            return
        if event.get("bot_id") or event.get("user") == self.bot_user_id:
            return
        text = event.get("text") or ""
        channel = event.get("channel")
        user = event.get("user")
        ts = event.get("ts")
        thread_ts = event.get("thread_ts") or ts
        if not text or not channel:
            return

        verb, payload = parse_command(text, self.bot_user_id)
        self.log.info("verb=%s user=%s channel=%s len=%d", verb, user, channel, len(payload))

        # Channel mentions reply in-thread; DMs reply at top-level.
        is_im = channel.startswith("D")
        reply_thread = None if is_im else thread_ts

        if verb == "help":
            self._reply(channel, HELP_TEXT, reply_thread)
            return
        if verb == "capture":
            self._capture(payload, channel, user, ts, thread_ts, reply_thread)
            return
        if verb == "query":
            self._query(payload, channel, reply_thread)
            return

    def _capture(
        self,
        text: str,
        channel: str,
        user: str | None,
        ts: str,
        thread_ts: str,
        reply_thread: str | None,
    ) -> None:
        actor_name = user or "unknown"
        try:
            user_info = self.web.users_info(user=user)["user"] if user else {}
            actor_name = user_info.get("real_name") or user_info.get("name") or user
        except Exception:
            pass
        metadata = {
            "source": "slack-bot",
            "source_channel_id": channel,
            "source_actor": user,
            "source_actor_name": actor_name,
            "source_ts": ts,
            "source_thread_root": thread_ts if thread_ts != ts else None,
        }
        try:
            confirmation = self.ob1.capture_thought(text, metadata=metadata, extract_topics=True)
            self._reply(channel, f":brain: {confirmation}", reply_thread)
        except OB1Error as e:
            self._reply(channel, f"Couldn't capture: `{e}`", reply_thread)

    def _query(self, query: str, channel: str, reply_thread: str | None) -> None:
        try:
            result = self.ob1.chat(query, top_k=8)
        except OB1Error as e:
            self._reply(channel, f"Sorry, query failed: `{e}`", reply_thread)
            return
        answer = result.get("answer") or "(no answer)"
        retrieved = result.get("retrieved") or []
        if not retrieved:
            self._reply(
                channel,
                f"{answer}\n\n_(no relevant captures found — try rephrasing or capture some context first)_",
                reply_thread,
            )
            return
        rendered = render_answer_for_slack(answer, retrieved, self.dashboard_url or None)
        self._reply(channel, rendered, reply_thread)

    def _reply(self, channel: str, text: str, thread_ts: str | None) -> None:
        try:
            self.web.chat_postMessage(
                channel=channel,
                text=text,
                thread_ts=thread_ts,
                unfurl_links=False,
                unfurl_media=False,
            )
        except SlackApiError as e:
            self.log.error("chat_postMessage failed: %s", e)


def main() -> int:
    log = make_logger()
    if not os.environ.get("SLACK_APP_TOKEN"):
        log.error("SLACK_APP_TOKEN not set (xapp-... from App-Level Tokens)")
        return 2
    if not os.environ.get("SLACK_BOT_TOKEN"):
        log.error("SLACK_BOT_TOKEN not set (xoxb-... from OAuth & Permissions)")
        return 2
    try:
        Bot(log).start()
    except KeyboardInterrupt:
        log.info("interrupted")
        return 0


if __name__ == "__main__":
    import sys
    sys.exit(main() or 0)
