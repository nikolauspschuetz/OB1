"""GitHub backfill connector.

Live ingest of GitHub events is wired separately via /webhook/github on
the MCP server (merged PRs + releases). This connector handles the
catch-up: walks the org's repos to capture merged PRs, closed issues,
releases, and key docs from before the webhook was configured (or for
repos that never had one).

Captures one thought per item with `metadata.source=github` and rich
attribution — repo, author, source_url linking back to the canonical
GitHub page so the dashboard's source_url renders click-through.

Required env:
  GITHUB_TOKEN          Org or fine-grained PAT with at minimum
                        `repo` (for private repos) + `read:org`.
                        Public-repo-only setups can use a plain
                        public_repo scope.

  GITHUB_ORG            Org or user login. The connector walks the
                        org's repos via /orgs/{org}/repos (or
                        /users/{user}/repos as fallback for personal
                        accounts).

Optional env:
  GITHUB_REPO_ALLOWLIST  Comma-separated `repo-name` (NOT full org/repo)
                         globs to include. Empty = include all repos
                         the token can see. Glob syntax: fnmatch
                         (e.g. "linguado-*,infra-k8s-*").

  GITHUB_BACKFILL_DAYS   Days back to scan on first run per repo
                         (default 30). State file tracks per-repo
                         per-kind cursor after that, so this only
                         matters for backfill — incremental polls
                         pick up exactly where the last left off.

  GITHUB_POLL_SECONDS    Watch-mode poll interval (default 1800 = 30
                         min). GitHub's REST API allows 5000
                         requests/hour for authenticated callers, so
                         a 30-min poll across ~10 repos is well under
                         the budget.

Per-repo state shape:
  { "repos": { "owner/name": { "prs_until": "2026-05-13T...",
                                "issues_until": "...",
                                "releases_until": "..." } } }

Each "_until" is the most-recent `updated_at` (PRs/issues) or
`published_at` (releases) successfully captured. Next run filters
items strictly newer.
"""
from __future__ import annotations

import fnmatch
import typing as t

from ..base import Capture, Connector, HttpError, http_request


class GitHubBackfillConnector(Connector):
    name = "github_backfill"
    version = "0.1.0"
    required_env = ("GITHUB_TOKEN", "GITHUB_ORG")
    optional_env = (
        "GITHUB_REPO_ALLOWLIST",
        "GITHUB_BACKFILL_DAYS",
        "GITHUB_POLL_SECONDS",
        "GITHUB_INCLUDE_ISSUES",
        "GITHUB_INCLUDE_RELEASES",
    )

    API = "https://api.github.com"

    def configure(self) -> bool:
        self.token = self.env.get("GITHUB_TOKEN", "").strip()
        self.org = self.env.get("GITHUB_ORG", "").strip()
        if not self.token or not self.org:
            return False
        allowlist = self.env.get("GITHUB_REPO_ALLOWLIST", "").strip()
        self.allowlist_globs = [g.strip() for g in allowlist.split(",") if g.strip()]
        self.backfill_days = int(self.env.get("GITHUB_BACKFILL_DAYS", "30"))
        self.include_issues = self.env.get("GITHUB_INCLUDE_ISSUES", "true").lower() != "false"
        self.include_releases = self.env.get("GITHUB_INCLUDE_RELEASES", "true").lower() != "false"
        return True

    def poll_seconds(self) -> int:
        return int(self.env.get("GITHUB_POLL_SECONDS", "1800"))

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ob1-connector",
        }

    def _api(self, path: str, params: dict[str, t.Any] | None = None) -> t.Any:
        """GET to GitHub API with bearer auth + pagination-friendly
        headers. Returns parsed JSON. Raises HttpError on non-2xx."""
        from urllib.parse import urlencode

        url = f"{self.API}{path}"
        if params:
            cleaned = {k: v for k, v in params.items() if v is not None}
            url += "?" + urlencode(cleaned)
        _status, _headers, body = http_request(url, headers=self._headers())
        import json as _json
        return _json.loads(body)

    def _list_repos(self) -> list[dict[str, t.Any]]:
        """List repos for the configured owner. Tries org first then
        user fallback so personal accounts work without a separate env
        var."""
        out: list[dict[str, t.Any]] = []
        for path_template in (f"/orgs/{self.org}/repos", f"/users/{self.org}/repos"):
            try:
                page = 1
                while True:
                    repos = self._api(
                        path_template,
                        {"per_page": 100, "page": page, "sort": "updated", "type": "all"},
                    )
                    if not repos:
                        break
                    out.extend(repos)
                    if len(repos) < 100:
                        break
                    page += 1
                # If we got results from the first template, don't fall through.
                if out:
                    break
            except HttpError as e:
                # 404 means try the next template; 403 means the token lacks scope.
                if e.status not in (404,):
                    self.log.warning("listing %s failed: %s", path_template, e)
                    break
        # Filter archives + forks (usually not interesting for a knowledge brain).
        filtered: list[dict[str, t.Any]] = []
        for r in out:
            if r.get("archived"):
                continue
            full = r.get("full_name") or f"{self.org}/{r.get('name', '')}"
            repo_name = r.get("name", "")
            if self.allowlist_globs:
                if not any(fnmatch.fnmatchcase(repo_name, g) for g in self.allowlist_globs):
                    continue
            filtered.append(r)
        return filtered

    def _capture_pr(self, repo: dict, pr: dict) -> Capture:
        body = (pr.get("body") or "").strip()
        # Drop GitHub-noise fold-outs and trailing checkbox lists if heavy.
        content_lines = [
            f"PR #{pr['number']} — {pr['title']}",
            f"State: {pr.get('state')}{' (merged)' if pr.get('merged_at') else ''}",
            f"Author: {pr['user']['login']}",
        ]
        if pr.get("merged_at"):
            content_lines.append(f"Merged: {pr['merged_at']}")
        if body:
            content_lines.extend(["", body])
        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"{repo['full_name']}#pr-{pr['number']}",
                "source_url": pr["html_url"],
                "source_actor": pr["user"]["login"],
                "source_repo": repo["full_name"],
                "source_kind": "pull_request",
                "source_pr_number": pr["number"],
                "source_state": pr.get("state"),
                "source_merged_at": pr.get("merged_at"),
            },
            source_id=str(pr["number"]),
        )

    def _capture_issue(self, repo: dict, issue: dict) -> Capture:
        body = (issue.get("body") or "").strip()
        content_lines = [
            f"Issue #{issue['number']} — {issue['title']}",
            f"State: {issue.get('state')}",
            f"Author: {issue['user']['login']}",
        ]
        if issue.get("closed_at"):
            content_lines.append(f"Closed: {issue['closed_at']}")
        if body:
            content_lines.extend(["", body])
        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"{repo['full_name']}#issue-{issue['number']}",
                "source_url": issue["html_url"],
                "source_actor": issue["user"]["login"],
                "source_repo": repo["full_name"],
                "source_kind": "issue",
                "source_issue_number": issue["number"],
                "source_state": issue.get("state"),
                "source_closed_at": issue.get("closed_at"),
            },
            source_id=str(issue["number"]),
        )

    def _capture_release(self, repo: dict, rel: dict) -> Capture:
        body = (rel.get("body") or "").strip()
        content_lines = [
            f"Release {rel.get('tag_name')} — {rel.get('name') or rel.get('tag_name')}",
            f"Author: {rel['author']['login']}" if rel.get("author") else "",
            f"Published: {rel.get('published_at')}",
        ]
        content_lines = [ln for ln in content_lines if ln]
        if body:
            content_lines.extend(["", body])
        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"{repo['full_name']}#release-{rel['id']}",
                "source_url": rel["html_url"],
                "source_actor": (rel.get("author") or {}).get("login"),
                "source_repo": repo["full_name"],
                "source_kind": "release",
                "source_tag": rel.get("tag_name"),
                "source_published_at": rel.get("published_at"),
            },
            source_id=str(rel["id"]),
        )

    def _walk_prs(
        self, repo: dict, since_iso: str | None,
    ) -> t.Iterator[tuple[Capture, str]]:
        """Yield (capture, updated_at) per merged-or-closed PR newer
        than since_iso. GitHub's /pulls endpoint returns updated_at
        descending; we paginate until items are <= since_iso."""
        page = 1
        while True:
            try:
                items = self._api(
                    f"/repos/{repo['full_name']}/pulls",
                    {
                        "state": "closed",
                        "sort": "updated",
                        "direction": "desc",
                        "per_page": 50,
                        "page": page,
                    },
                )
            except HttpError as e:
                self.log.warning("pulls fetch %s failed: %s", repo["full_name"], e)
                return
            if not items:
                return
            for pr in items:
                upd = pr.get("updated_at") or ""
                if since_iso and upd <= since_iso:
                    return
                yield self._capture_pr(repo, pr), upd
            if len(items) < 50:
                return
            page += 1
            if page > 20:  # safety bound — backfill chunks across runs
                return

    def _walk_issues(
        self, repo: dict, since_iso: str | None,
    ) -> t.Iterator[tuple[Capture, str]]:
        """Yield (capture, updated_at) per closed issue newer than
        since_iso. /issues includes PRs by default — filter them out
        because we already handled PRs above."""
        page = 1
        while True:
            try:
                items = self._api(
                    f"/repos/{repo['full_name']}/issues",
                    {
                        "state": "closed",
                        "sort": "updated",
                        "direction": "desc",
                        "per_page": 50,
                        "page": page,
                        "since": since_iso,
                    },
                )
            except HttpError as e:
                self.log.warning("issues fetch %s failed: %s", repo["full_name"], e)
                return
            if not items:
                return
            for issue in items:
                if "pull_request" in issue:
                    continue
                upd = issue.get("updated_at") or ""
                if since_iso and upd <= since_iso:
                    return
                yield self._capture_issue(repo, issue), upd
            if len(items) < 50:
                return
            page += 1
            if page > 20:
                return

    def _walk_releases(
        self, repo: dict, since_iso: str | None,
    ) -> t.Iterator[tuple[Capture, str]]:
        """Yield (capture, published_at) per release newer than
        since_iso. /releases is paginated, default sort = newest
        published first."""
        page = 1
        while True:
            try:
                items = self._api(
                    f"/repos/{repo['full_name']}/releases",
                    {"per_page": 30, "page": page},
                )
            except HttpError as e:
                self.log.warning("releases fetch %s failed: %s", repo["full_name"], e)
                return
            if not items:
                return
            for rel in items:
                pub = rel.get("published_at") or rel.get("created_at") or ""
                if since_iso and pub and pub <= since_iso:
                    return
                yield self._capture_release(repo, rel), pub
            if len(items) < 30:
                return
            page += 1
            if page > 10:
                return

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        # state shape: { "repos": { "<full_name>": { "prs_until": ..., "issues_until": ..., "releases_until": ... } } }
        per_repo = state.setdefault("repos", {})
        repos = self._list_repos()
        self.log.info("scanning %d repo(s) under %s", len(repos), self.org)

        # First-run cursor = "now - backfill_days".
        import datetime as _dt
        first_run_cursor = (
            _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=self.backfill_days)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        for repo in repos:
            full = repo["full_name"]
            cursors = per_repo.setdefault(full, {})

            # PRs.
            pr_since = cursors.get("prs_until") or first_run_cursor
            pr_count = 0
            highest_pr = pr_since
            for cap, upd in self._walk_prs(repo, pr_since):
                pr_count += 1
                if upd > highest_pr:
                    highest_pr = upd
                cursors["prs_until"] = highest_pr  # checkpoint per item
                yield cap

            # Issues.
            iss_count = 0
            if self.include_issues:
                iss_since = cursors.get("issues_until") or first_run_cursor
                highest_iss = iss_since
                for cap, upd in self._walk_issues(repo, iss_since):
                    iss_count += 1
                    if upd > highest_iss:
                        highest_iss = upd
                    cursors["issues_until"] = highest_iss
                    yield cap

            # Releases.
            rel_count = 0
            if self.include_releases:
                rel_since = cursors.get("releases_until") or first_run_cursor
                highest_rel = rel_since
                for cap, pub in self._walk_releases(repo, rel_since):
                    rel_count += 1
                    if pub > highest_rel:
                        highest_rel = pub
                    cursors["releases_until"] = highest_rel
                    yield cap

            if pr_count or iss_count or rel_count:
                self.log.info(
                    "  %s: %d PR(s), %d issue(s), %d release(s)",
                    full, pr_count, iss_count, rel_count,
                )
