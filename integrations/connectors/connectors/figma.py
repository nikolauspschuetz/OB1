"""Figma connector — STUB.

Polls Figma's Comments API + Versions API per file in the allowlist.
PAT auth, no OAuth. Captures comment text + author + file + frame so
the brain knows what design feedback exists per file.

To implement:
  1. For each file in FIGMA_FILE_ALLOWLIST:
     GET /v1/files/{key}/comments → capture each as a thought.
     GET /v1/files/{key}/versions → capture version descriptions.
  2. State: cursor on comment.created_at per file.

Required env (when implemented):
  FIGMA_TOKEN              (PAT from figma.com/developers/api#access-tokens)
  FIGMA_FILE_ALLOWLIST     (comma-separated file keys)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class FigmaConnector(Connector):
    name = "figma"
    version = "0.0.0-stub"
    required_env = ("FIGMA_TOKEN", "FIGMA_FILE_ALLOWLIST")
    optional_env = ()

    def configure(self) -> bool:
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
