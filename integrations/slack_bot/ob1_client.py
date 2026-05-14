"""Thin HTTP client to the OB1 MCP server. Two operations needed:
  - capture_thought:    persist a memo
  - /dashboard-api/chat: RAG query (single-turn from the bot's POV)
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request


class OB1Error(Exception):
    pass


class OB1Client:
    def __init__(
        self,
        base_url: str | None = None,
        access_key: str | None = None,
        log: logging.Logger | None = None,
    ):
        self.base_url = (base_url or os.environ.get("OB1_URL", "http://mcp:8000")).rstrip("/")
        self.access_key = access_key or os.environ.get("OB1_KEY", "")
        self.log = log or logging.getLogger("ob1")
        if not self.access_key:
            raise OB1Error("OB1_KEY not set")

    def _post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "x-brain-key": self.access_key,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return {"status": resp.status, "body": resp.read().decode("utf-8", "replace")}
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", "replace") if e.fp else ""
            raise OB1Error(f"HTTP {e.code}: {body_text[:300]}") from e
        except urllib.error.URLError as e:
            raise OB1Error(f"transport: {e}") from e

    def capture_thought(
        self,
        content: str,
        metadata: dict | None = None,
        extract_topics: bool = False,
    ) -> str:
        """POST to /mcp tools/call capture_thought. Returns the
        confirmation string from the MCP tool (e.g. "Captured as note —
        slack, dm"). Raises OB1Error on failure."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "capture_thought",
                "arguments": {
                    "content": content[:8000],
                    "metadata": metadata or {},
                    "extract_topics": extract_topics,
                },
            },
        }
        resp = self._post("/mcp", payload)
        body = resp["body"]
        # SSE-style: parse data: line, check isError.
        for line in body.splitlines():
            if line.startswith("data: "):
                data = json.loads(line[len("data: "):])
                result = data.get("result")
                if not result:
                    err = data.get("error") or {}
                    raise OB1Error(f"jsonrpc error: {err.get('message') or err}")
                if result.get("isError"):
                    msg = ""
                    content_blocks = result.get("content") or []
                    if content_blocks and isinstance(content_blocks[0], dict):
                        msg = content_blocks[0].get("text", "")
                    raise OB1Error(msg[:300])
                text = ""
                content_blocks = result.get("content") or []
                if content_blocks and isinstance(content_blocks[0], dict):
                    text = content_blocks[0].get("text", "")
                return text
        raise OB1Error(f"no data line in response: {body[:200]}")

    def chat(self, query: str, top_k: int = 8) -> dict:
        """POST to /dashboard-api/chat for single-turn RAG.
        Returns the parsed JSON: { answer, retrieved, model }."""
        resp = self._post(
            "/dashboard-api/chat",
            {"history": [{"role": "user", "content": query}], "topK": top_k},
        )
        try:
            data = json.loads(resp["body"])
        except Exception as e:
            raise OB1Error(f"chat parse failed: {e}; body={resp['body'][:200]}") from e
        if "error" in data:
            raise OB1Error(data["error"])
        return data
