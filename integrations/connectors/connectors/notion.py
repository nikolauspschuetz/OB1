"""Notion connector — STUB.

Polls Notion's search API for pages edited since the last cursor,
restricted to the database allowlist. Captures page content as
markdown via the block API.

To implement:
  1. POST /v1/search with sort=last_edited_time desc, filter=page.
  2. Filter by NOTION_DATABASE_ALLOWLIST (page.parent.database_id).
  3. GET /v1/blocks/{page_id}/children?page_size=100 to fetch body.
  4. Convert Notion blocks → markdown (paragraph, heading_1..3,
     bulleted_list_item, to_do, code, callout, …).
  5. Capture with metadata.source_url = page.url.
  6. State: cursor on last_edited_time.

Required env (when implemented):
  NOTION_TOKEN                  (integration token, secret_...)

Optional env:
  NOTION_DATABASE_ALLOWLIST     (comma-separated database IDs)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class NotionConnector(Connector):
    name = "notion"
    version = "0.0.0-stub"
    required_env = ("NOTION_TOKEN",)
    optional_env = ("NOTION_DATABASE_ALLOWLIST",)

    def configure(self) -> bool:
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
