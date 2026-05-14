"""GitHub backfill connector — STUB.

Live ingest of GitHub events is already wired via /webhook/github on
the MCP server (merged PRs, releases). This connector handles
*backfill*: walking the org's repos to seed the brain with merged PRs,
closed issues, and key docs from before the webhook was configured.

To implement:
  1. List repos in $GITHUB_ORG matching $GITHUB_REPO_ALLOWLIST glob.
  2. Per repo:
     - GET /repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100
       paginate while updated_at > since
     - For each: capture title + body + final reviewer comment summary
     - GET /repos/{owner}/{repo}/issues?state=closed... same pattern
     - GET /repos/{owner}/{repo}/releases for tags + release notes
     - One-shot capture of README.md, docs/* on first run per repo
  3. State: per-repo cursor (last updated_at seen).
  4. Idempotent re-runs via OB1's content_fingerprint dedup.

Required env (when implemented):
  GITHUB_TOKEN     (org PAT with read:org, repo)
  GITHUB_ORG

Optional env:
  GITHUB_REPO_ALLOWLIST   (default: all repos in the org)
  GITHUB_BACKFILL_DAYS    (default: 30)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class GitHubBackfillConnector(Connector):
    name = "github_backfill"
    version = "0.0.0-stub"
    required_env = ("GITHUB_TOKEN", "GITHUB_ORG")
    optional_env = ("GITHUB_REPO_ALLOWLIST", "GITHUB_BACKFILL_DAYS")

    def configure(self) -> bool:
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
