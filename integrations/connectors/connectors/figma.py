"""Figma connector.

Polls Figma's REST API for comments + versions on each file in the
allowlist. Comments are the high-signal target (where design feedback
lives); versions give a coarse "what changed when" timeline that ties
discussions to specific file states.

No OAuth — Figma's developer PATs are workspace-wide and stable. Each
file in `FIGMA_FILE_ALLOWLIST` is polled independently; per-file
cursor on comment created_at.

Required env:
  FIGMA_TOKEN              Personal Access Token from
                           figma.com/developers/api → "Personal access tokens"
                           Scopes needed: file_content:read, file_comments:read
                           (default scopes work for the free tier).
  FIGMA_FILE_ALLOWLIST     Comma-separated Figma file keys. Find the
                           key in any file URL:
                              https://www.figma.com/file/<KEY>/<name>
                           or  https://www.figma.com/design/<KEY>/<name>
                           Example: AbCdEfG12345,XyZ987654

Optional env:
  FIGMA_POLL_SECONDS       Watch-mode poll interval (default 900 = 15 min).
                           Figma rate limit is 5000 req/day per token, very
                           generous; 15 min × N files is fine.
  FIGMA_INCLUDE_VERSIONS   "true" (default) to capture file-version
                           descriptions as their own thoughts.

Per-file state shape:
  { "files": { "<key>": { "comments_until": "2026-05-13T...",
                          "versions_until": "..." } } }

Each "_until" is the most-recent created_at successfully captured.
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector, HttpError, http_request


class FigmaConnector(Connector):
    name = "figma"
    version = "0.1.0"
    required_env = ("FIGMA_TOKEN", "FIGMA_FILE_ALLOWLIST")
    optional_env = ("FIGMA_POLL_SECONDS", "FIGMA_INCLUDE_VERSIONS")

    API = "https://api.figma.com"

    def configure(self) -> bool:
        self.token = self.env.get("FIGMA_TOKEN", "").strip()
        allowlist = self.env.get("FIGMA_FILE_ALLOWLIST", "").strip()
        self.file_keys = [k.strip() for k in allowlist.split(",") if k.strip()]
        if not self.token or not self.file_keys:
            return False
        self.include_versions = (
            self.env.get("FIGMA_INCLUDE_VERSIONS", "true").lower() != "false"
        )
        self._user_cache: dict[str, str] = {}
        self._file_meta_cache: dict[str, dict[str, str]] = {}
        return True

    def poll_seconds(self) -> int:
        return int(self.env.get("FIGMA_POLL_SECONDS", "900"))

    def _headers(self) -> dict[str, str]:
        return {
            "X-Figma-Token": self.token,
            "Accept": "application/json",
            "User-Agent": "ob1-connector",
        }

    def _api(self, path: str) -> t.Any:
        import json as _json

        _status, _hdrs, body = http_request(
            f"{self.API}{path}",
            headers=self._headers(),
        )
        return _json.loads(body)

    def _file_meta(self, key: str) -> dict[str, str]:
        """Cache file name + thumbnail per key; used to enrich capture
        metadata so we don't repeat the GET file call per comment."""
        if key in self._file_meta_cache:
            return self._file_meta_cache[key]
        try:
            data = self._api(f"/v1/files/{key}?depth=1")
        except HttpError as e:
            self.log.warning("file meta fetch for %s failed: %s", key, e)
            self._file_meta_cache[key] = {"name": key}
            return self._file_meta_cache[key]
        meta = {
            "name": data.get("name") or key,
            "version": data.get("version") or "",
            "thumbnail_url": data.get("thumbnailUrl") or "",
        }
        self._file_meta_cache[key] = meta
        return meta

    def _capture_comment(self, key: str, file_meta: dict, comment: dict) -> Capture:
        author = (comment.get("user") or {})
        author_name = author.get("handle") or author.get("img_url") or "unknown"
        body = (comment.get("message") or "").strip()
        # Figma comments can include @-mentions encoded as
        # `@[Name](user-id)`. Leave them as-is; the text is searchable.
        url = f"https://www.figma.com/file/{key}?node-id={comment.get('client_meta', {}).get('node_id', '')}#comment-{comment.get('id')}"
        return Capture(
            content=f"Comment on Figma file '{file_meta.get('name')}' by {author_name}:\n\n{body}",
            metadata={
                "source_id": f"figma/{key}/comment/{comment.get('id')}",
                "source_url": url,
                "source_actor": author.get("id"),
                "source_actor_name": author_name,
                "source_file_key": key,
                "source_file_name": file_meta.get("name"),
                "source_kind": "figma_comment",
                "source_comment_id": comment.get("id"),
                "source_parent_id": comment.get("parent_id") or None,
                "source_resolved": comment.get("resolved_at") is not None,
            },
            source_id=str(comment.get("id")),
        )

    def _capture_version(self, key: str, file_meta: dict, version: dict) -> Capture:
        author = (version.get("user") or {})
        author_name = author.get("handle") or "unknown"
        label = version.get("label") or "(no label)"
        desc = (version.get("description") or "").strip()
        content_lines = [
            f"Figma file '{file_meta.get('name')}' new version by {author_name}",
            f"Label: {label}",
        ]
        if desc:
            content_lines.extend(["", desc])
        url = f"https://www.figma.com/file/{key}/?version-id={version.get('id')}"
        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"figma/{key}/version/{version.get('id')}",
                "source_url": url,
                "source_actor": author.get("id"),
                "source_actor_name": author_name,
                "source_file_key": key,
                "source_file_name": file_meta.get("name"),
                "source_kind": "figma_version",
                "source_version_id": version.get("id"),
                "source_label": label,
            },
            source_id=str(version.get("id")),
        )

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        # state shape: { "files": { "<key>": { "comments_until": ..., "versions_until": ... } } }
        per_file = state.setdefault("files", {})
        self.log.info("scanning %d file(s)", len(self.file_keys))

        for key in self.file_keys:
            cursors = per_file.setdefault(key, {})
            file_meta = self._file_meta(key)

            # Comments — paginated by `before`/`after` is awkward;
            # /v1/files/<key>/comments returns ALL comments. We filter
            # client-side by created_at > cursor.
            try:
                cdata = self._api(f"/v1/files/{key}/comments")
            except HttpError as e:
                self.log.warning("comments fetch %s failed: %s", key, e)
                continue
            comments = cdata.get("comments", [])
            cursor_c = cursors.get("comments_until") or ""
            highest_c = cursor_c
            n_c = 0
            # Comments arrive newest-first; reverse so older yield first
            # (so the per-message cursor advances monotonically).
            for c in sorted(comments, key=lambda x: x.get("created_at", "")):
                ts = c.get("created_at") or ""
                if cursor_c and ts <= cursor_c:
                    continue
                yield self._capture_comment(key, file_meta, c)
                n_c += 1
                if ts > highest_c:
                    highest_c = ts
                    cursors["comments_until"] = highest_c

            # Versions — only if enabled.
            n_v = 0
            if self.include_versions:
                try:
                    vdata = self._api(f"/v1/files/{key}/versions")
                except HttpError as e:
                    self.log.warning("versions fetch %s failed: %s", key, e)
                else:
                    versions = vdata.get("versions", [])
                    cursor_v = cursors.get("versions_until") or ""
                    highest_v = cursor_v
                    for v in sorted(versions, key=lambda x: x.get("created_at", "")):
                        ts = v.get("created_at") or ""
                        if cursor_v and ts <= cursor_v:
                            continue
                        yield self._capture_version(key, file_meta, v)
                        n_v += 1
                        if ts > highest_v:
                            highest_v = ts
                            cursors["versions_until"] = highest_v

            if n_c or n_v:
                self.log.info(
                    "  %s (%s): %d comment(s), %d version(s)",
                    key, file_meta.get("name"), n_c, n_v,
                )
