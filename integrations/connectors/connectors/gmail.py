"""Gmail connector — STUB.

Polls `users.messages.list?q=...` for new mail, captures from + subject
+ body. OAuth refresh-token auth (no GCP Pub/Sub needed for v1).

To implement:
  1. One-time CLI: integrations/connectors/oauth/gmail_init.py opens a
     browser to Google's OAuth consent screen, captures the auth code
     via a loopback HTTP server on 8765, exchanges for a refresh token,
     prints env block to copy into .env.<profile>.
  2. fetch_new: use the refresh token to mint an access token, call
     gmail.users.messages.list with q=GMAIL_QUERY, then messages.get
     per id to fetch body. Strip MIME multipart, prefer text/plain;
     html2text the body if only text/html available.
  3. State: cursor on internalDate (epoch ms); start at
     now() - GMAIL_BACKFILL_DAYS on first run.
  4. Threading: capture replies with the parent body inlined (same
     pattern as Slack).
  5. Privacy: respect GMAIL_LABEL_BLOCKLIST so personal Health/Finance
     labels never make it in.

Required env (when implemented):
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN

Optional env:
  GMAIL_QUERY          (default: "newer_than:1d -in:promotions -in:spam")
  GMAIL_LABEL_ALLOWLIST
  GMAIL_LABEL_BLOCKLIST
  GMAIL_BACKFILL_DAYS  (default: 7)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class GmailConnector(Connector):
    name = "gmail"
    version = "0.0.0-stub"
    required_env = ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN")
    optional_env = (
        "GMAIL_QUERY",
        "GMAIL_LABEL_ALLOWLIST",
        "GMAIL_LABEL_BLOCKLIST",
        "GMAIL_BACKFILL_DAYS",
    )

    def configure(self) -> bool:
        # Stub: not yet implemented. Returning False keeps the framework
        # quiet — the runner just skips this connector.
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
