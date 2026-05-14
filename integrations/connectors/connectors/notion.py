"""Notion connector.

Polls Notion's search API for pages edited since the last cursor.
Each page is fetched, converted to a flat markdown-ish text, and
captured as a thought. Per-database allowlist optional.

Required env:
  NOTION_TOKEN                  Integration token (starts `secret_`).
                                Create at notion.so/my-integrations and
                                explicitly share the relevant pages /
                                databases with the integration in the
                                Notion UI (Notion's permission model
                                requires per-resource grant).

Optional env:
  NOTION_DATABASE_ALLOWLIST     Comma-separated database IDs. Empty =
                                every page the integration has access
                                to. IDs can be the dash-separated UUID
                                or the 32-char hex form.
  NOTION_POLL_SECONDS           Default 1200 (20 min).
  NOTION_BACKFILL_DAYS          Default 30. First-run filter on
                                last_edited_time.

State shape:
  { "last_edited_until": "2026-05-14T..." }
"""
from __future__ import annotations

import datetime as _dt
import json as _json
import typing as t

from ..base import Capture, Connector, HttpError, http_request


# Notion block_type → markdown rendering helpers. We only handle the
# common subset; unknown types render as their type name with no body
# (still searchable as a marker, not noise).
_RICH_TEXT_PROPS = {
    "paragraph", "heading_1", "heading_2", "heading_3",
    "bulleted_list_item", "numbered_list_item", "to_do", "toggle",
    "quote", "callout",
}


def _rich_text_to_str(rich: list[dict]) -> str:
    return "".join((rt.get("plain_text") or "") for rt in (rich or []))


def _render_block(b: dict) -> str | None:
    btype = b.get("type")
    body = b.get(btype) or {}
    text = _rich_text_to_str(body.get("rich_text") or [])
    if btype == "paragraph":
        return text if text else None
    if btype == "heading_1":
        return f"# {text}" if text else None
    if btype == "heading_2":
        return f"## {text}" if text else None
    if btype == "heading_3":
        return f"### {text}" if text else None
    if btype == "bulleted_list_item":
        return f"- {text}" if text else None
    if btype == "numbered_list_item":
        return f"1. {text}" if text else None
    if btype == "to_do":
        checked = body.get("checked")
        return f"[{'x' if checked else ' '}] {text}" if text else None
    if btype == "quote":
        return f"> {text}" if text else None
    if btype == "callout":
        icon = (body.get("icon") or {}).get("emoji") or "ℹ"
        return f"{icon} {text}" if text else None
    if btype == "code":
        lang = body.get("language") or ""
        return f"```{lang}\n{text}\n```" if text else None
    if btype == "divider":
        return "---"
    if btype == "child_page":
        return f"📄 (child page: {body.get('title', '')})"
    if btype == "child_database":
        return f"📊 (child database: {body.get('title', '')})"
    return None


class NotionConnector(Connector):
    name = "notion"
    version = "0.1.0"
    required_env = ("NOTION_TOKEN",)
    optional_env = (
        "NOTION_DATABASE_ALLOWLIST",
        "NOTION_POLL_SECONDS",
        "NOTION_BACKFILL_DAYS",
    )

    API = "https://api.notion.com/v1"
    VERSION = "2022-06-28"

    def configure(self) -> bool:
        self.token = self.env.get("NOTION_TOKEN", "").strip()
        if not self.token:
            return False
        allowlist = self.env.get("NOTION_DATABASE_ALLOWLIST", "").strip()
        self.db_allowlist = {
            self._normalize_id(x) for x in allowlist.split(",") if x.strip()
        }
        self.backfill_days = int(self.env.get("NOTION_BACKFILL_DAYS", "30"))
        return True

    def poll_seconds(self) -> int:
        return int(self.env.get("NOTION_POLL_SECONDS", "1200"))

    @staticmethod
    def _normalize_id(id_str: str) -> str:
        """Notion IDs come as either 32-char hex or dash-separated UUID.
        Normalize to hex (no dashes) for matching."""
        return id_str.strip().replace("-", "").lower()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Notion-Version": self.VERSION,
            "Content-Type": "application/json",
            "User-Agent": "ob1-connector",
        }

    def _api(self, method: str, path: str, body: dict | None = None) -> dict:
        payload = _json.dumps(body).encode("utf-8") if body else None
        _status, _hdrs, resp = http_request(
            f"{self.API}{path}",
            method=method,
            headers=self._headers(),
            body=payload,
        )
        return _json.loads(resp)

    def _search_pages(self, after_iso: str) -> t.Iterator[dict]:
        cursor: str | None = None
        while True:
            body: dict = {
                "filter": {"value": "page", "property": "object"},
                "sort": {"direction": "ascending", "timestamp": "last_edited_time"},
                "page_size": 50,
            }
            if cursor:
                body["start_cursor"] = cursor
            try:
                data = self._api("POST", "/search", body)
            except HttpError as e:
                self.log.warning("notion search failed: %s", e)
                return
            for page in data.get("results", []):
                last_edit = page.get("last_edited_time") or ""
                if after_iso and last_edit <= after_iso:
                    continue
                # Filter by database allowlist if configured.
                if self.db_allowlist:
                    parent = page.get("parent") or {}
                    if parent.get("type") != "database_id":
                        continue
                    db_id = self._normalize_id(parent.get("database_id", ""))
                    if db_id not in self.db_allowlist:
                        continue
                yield page
            if not data.get("has_more"):
                return
            cursor = data.get("next_cursor")
            if not cursor:
                return

    def _page_title(self, page: dict) -> str:
        # Title can live in various property names (database pages
        # have a "Name" or similar title-typed property; standalone
        # pages have one at .properties.title).
        for prop in (page.get("properties") or {}).values():
            if (prop or {}).get("type") == "title":
                return _rich_text_to_str(prop.get("title") or [])
        return "(untitled)"

    def _fetch_blocks(self, page_id: str) -> list[dict]:
        out: list[dict] = []
        cursor: str | None = None
        while True:
            path = f"/blocks/{page_id}/children?page_size=100"
            if cursor:
                path += f"&start_cursor={cursor}"
            try:
                data = self._api("GET", path)
            except HttpError as e:
                self.log.warning("blocks fetch for %s failed: %s", page_id, e)
                return out
            out.extend(data.get("results", []))
            if not data.get("has_more"):
                return out
            cursor = data.get("next_cursor")
            if not cursor:
                return out

    def _capture_page(self, page: dict) -> Capture | None:
        page_id = page.get("id")
        if not page_id:
            return None
        title = self._page_title(page)
        blocks = self._fetch_blocks(page_id)
        markdown_lines: list[str] = []
        for b in blocks:
            rendered = _render_block(b)
            if rendered:
                markdown_lines.append(rendered)
        content = f"# {title}\n\n" + "\n\n".join(markdown_lines) if markdown_lines else f"# {title}"
        return Capture(
            content=content,
            metadata={
                "source_id": f"notion/{page_id}",
                "source_url": page.get("url"),
                "source_kind": "notion_page",
                "source_page_id": page_id,
                "source_page_title": title,
                "source_last_edited": page.get("last_edited_time"),
                "source_created_by": (page.get("created_by") or {}).get("id"),
                "source_last_edited_by": (page.get("last_edited_by") or {}).get("id"),
            },
            source_id=page_id,
        )

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        since = state.get("last_edited_until") or (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=self.backfill_days)
        ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        n = 0
        highest = since
        for page in self._search_pages(since):
            cap = self._capture_page(page)
            if cap is None:
                continue
            yield cap
            n += 1
            last_edit = page.get("last_edited_time") or ""
            if last_edit > highest:
                highest = last_edit
                state["last_edited_until"] = highest
        if n:
            self.log.info("notion: %d page(s) since %s", n, since)
