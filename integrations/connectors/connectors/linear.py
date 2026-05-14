"""Linear connector — STUB.

Live ingest of completed Linear issues is wired via /webhook/linear on
the MCP server. This connector handles backfill via Linear's GraphQL
API for issues closed before the webhook was configured.

To implement:
  1. POST to https://api.linear.app/graphql with Bearer auth.
  2. Query:
       query($since: DateTime, $cursor: String) {
         issues(filter: {state: {type: {eq: "completed"}}, updatedAt: {gte: $since}},
                first: 100, after: $cursor) {
           nodes { id, title, description, completedAt, team { key }, ... }
           pageInfo { hasNextPage, endCursor }
         }
       }
  3. Filter by LINEAR_TEAM_ALLOWLIST.
  4. Capture title + description + completion comment.

Required env (when implemented):
  LINEAR_API_KEY

Optional env:
  LINEAR_TEAM_ALLOWLIST    (default: all teams)
  LINEAR_BACKFILL_DAYS     (default: 30)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class LinearConnector(Connector):
    name = "linear"
    version = "0.0.0-stub"
    required_env = ("LINEAR_API_KEY",)
    optional_env = ("LINEAR_TEAM_ALLOWLIST", "LINEAR_BACKFILL_DAYS")

    def configure(self) -> bool:
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
