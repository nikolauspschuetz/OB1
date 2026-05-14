"""Linear connector.

Walks Linear's GraphQL API to capture completed issues (and optionally
their comments) since a cursor. Live ingest of completion events is
already wired via /webhook/linear on the MCP server — this connector
handles backfill for issues completed before the webhook existed and
covers issue update events the webhook doesn't fire on (description
edits, comment additions, etc.).

Required env:
  LINEAR_API_KEY            Personal API key from
                            linear.app → Settings → API → Personal API keys.
                            Workspace-scoped; no OAuth.

Optional env:
  LINEAR_TEAM_ALLOWLIST     Comma-separated team keys (e.g. "ENG,INFRA").
                            Empty = all teams the key has access to.
  LINEAR_INCLUDE_COMMENTS   "true" (default) to capture issue comments
                            as separate thoughts. Set false for noisier
                            workspaces.
  LINEAR_BACKFILL_DAYS      Default 30. Filters issues by updatedAt.
  LINEAR_POLL_SECONDS       Watch-mode poll interval (default 600 = 10m).

State shape (per-key cursor, not per-team):
  { "issues_until": "2026-05-13T...", "comments_until": "..." }
"""
from __future__ import annotations

import datetime as _dt
import json as _json
import typing as t

from ..base import Capture, Connector, HttpError, http_request


class LinearConnector(Connector):
    name = "linear"
    version = "0.1.0"
    required_env = ("LINEAR_API_KEY",)
    optional_env = (
        "LINEAR_TEAM_ALLOWLIST",
        "LINEAR_INCLUDE_COMMENTS",
        "LINEAR_BACKFILL_DAYS",
        "LINEAR_POLL_SECONDS",
    )

    API = "https://api.linear.app/graphql"

    def configure(self) -> bool:
        self.api_key = self.env.get("LINEAR_API_KEY", "").strip()
        if not self.api_key:
            return False
        allowlist = self.env.get("LINEAR_TEAM_ALLOWLIST", "").strip()
        self.team_keys = [t.strip().upper() for t in allowlist.split(",") if t.strip()]
        self.include_comments = (
            self.env.get("LINEAR_INCLUDE_COMMENTS", "true").lower() != "false"
        )
        self.backfill_days = int(self.env.get("LINEAR_BACKFILL_DAYS", "30"))
        return True

    def poll_seconds(self) -> int:
        return int(self.env.get("LINEAR_POLL_SECONDS", "600"))

    def _gql(self, query: str, variables: dict | None = None) -> dict:
        body = _json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        _status, _hdrs, resp = http_request(
            self.API,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": self.api_key,
                "User-Agent": "ob1-connector",
            },
            body=body,
        )
        data = _json.loads(resp)
        if "errors" in data:
            raise HttpError(0, _json.dumps(data["errors"])[:300])
        return data.get("data", {})

    def _capture_issue(self, issue: dict) -> Capture:
        team = (issue.get("team") or {}).get("key", "")
        assignee = (issue.get("assignee") or {}).get("name") or "unassigned"
        creator = (issue.get("creator") or {}).get("name") or "unknown"
        state = (issue.get("state") or {}).get("name") or "?"
        desc = (issue.get("description") or "").strip()
        identifier = issue.get("identifier") or f"{team}-?"
        title = issue.get("title") or "(no title)"

        content_lines = [
            f"Linear {identifier}: {title}",
            f"State: {state}",
            f"Assignee: {assignee}",
            f"Creator: {creator}",
        ]
        if issue.get("completedAt"):
            content_lines.append(f"Completed: {issue['completedAt']}")
        if desc:
            content_lines.extend(["", desc])

        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"linear/issue/{identifier}",
                "source_url": issue.get("url"),
                "source_actor": (issue.get("creator") or {}).get("id"),
                "source_actor_name": creator,
                "source_kind": "linear_issue",
                "source_identifier": identifier,
                "source_team": team,
                "source_state": state,
                "source_priority": issue.get("priority"),
                "source_assignee": assignee,
                "source_completed_at": issue.get("completedAt"),
            },
            source_id=identifier,
        )

    def _capture_comment(self, comment: dict) -> Capture:
        issue = comment.get("issue") or {}
        identifier = issue.get("identifier") or "?"
        author = (comment.get("user") or {}).get("name") or "unknown"
        body = (comment.get("body") or "").strip()
        return Capture(
            content=f"Comment on Linear {identifier} by {author}:\n\n{body}",
            metadata={
                "source_id": f"linear/comment/{comment.get('id')}",
                "source_url": comment.get("url"),
                "source_actor": (comment.get("user") or {}).get("id"),
                "source_actor_name": author,
                "source_kind": "linear_comment",
                "source_identifier": identifier,
                "source_team": (issue.get("team") or {}).get("key"),
            },
            source_id=str(comment.get("id")),
        )

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        since_iso = state.get("issues_until") or (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=self.backfill_days)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        team_filter = ""
        if self.team_keys:
            keys_json = _json.dumps(self.team_keys)
            team_filter = f', team: {{ key: {{ in: {keys_json} }} }}'

        # Issues — paginate with `after` cursor.
        n_issues = 0
        highest = since_iso
        after: str | None = None
        while True:
            after_clause = f', after: "{after}"' if after else ""
            q = f"""
            query Issues {{
              issues(
                first: 50{after_clause},
                filter: {{ updatedAt: {{ gt: "{since_iso}" }}{team_filter} }},
                orderBy: updatedAt,
                sortDirection: ascending
              ) {{
                pageInfo {{ hasNextPage endCursor }}
                nodes {{
                  id identifier title description url priority completedAt updatedAt
                  state {{ name }} team {{ key }}
                  assignee {{ id name }} creator {{ id name }}
                }}
              }}
            }}"""
            try:
                data = self._gql(q)
            except HttpError as e:
                self.log.warning("linear issues query failed: %s", e)
                break
            edges = (data.get("issues") or {}).get("nodes", [])
            for issue in edges:
                yield self._capture_issue(issue)
                n_issues += 1
                upd = issue.get("updatedAt") or ""
                if upd > highest:
                    highest = upd
                    state["issues_until"] = highest
            page = (data.get("issues") or {}).get("pageInfo") or {}
            if page.get("hasNextPage"):
                after = page.get("endCursor")
                continue
            break

        # Comments — only if enabled.
        n_comments = 0
        if self.include_comments:
            c_since = state.get("comments_until") or since_iso
            highest_c = c_since
            after = None
            while True:
                after_clause = f', after: "{after}"' if after else ""
                q = f"""
                query Comments {{
                  comments(
                    first: 50{after_clause},
                    filter: {{ updatedAt: {{ gt: "{c_since}" }} }},
                    orderBy: updatedAt,
                    sortDirection: ascending
                  ) {{
                    pageInfo {{ hasNextPage endCursor }}
                    nodes {{
                      id body url updatedAt
                      user {{ id name }}
                      issue {{ identifier team {{ key }} }}
                    }}
                  }}
                }}"""
                try:
                    data = self._gql(q)
                except HttpError as e:
                    self.log.warning("linear comments query failed: %s", e)
                    break
                nodes = (data.get("comments") or {}).get("nodes", [])
                for comment in nodes:
                    yield self._capture_comment(comment)
                    n_comments += 1
                    upd = comment.get("updatedAt") or ""
                    if upd > highest_c:
                        highest_c = upd
                        state["comments_until"] = highest_c
                page = (data.get("comments") or {}).get("pageInfo") or {}
                if page.get("hasNextPage"):
                    after = page.get("endCursor")
                    continue
                break

        if n_issues or n_comments:
            self.log.info(
                "linear: %d issue(s), %d comment(s) since %s",
                n_issues, n_comments, since_iso,
            )
