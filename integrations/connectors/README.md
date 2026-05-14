# Connectors — external knowledge-base ingestion

Modular framework for pulling external sources (Slack, Gmail, GitHub,
Linear, Figma, Notion, calendar, Claude Code session history, …) into
the active OB1 profile's brain. Every connector subclasses
`base.Connector` and overrides two methods (`configure`, `fetch_new`);
the framework handles state, dedup, fingerprinting, retries, and
posting to the MCP server's `capture_thought` tool.

**Embeddings happen automatically.** Connectors POST to
`/mcp tools/call capture_thought`, which runs the server's normal
pipeline: content fingerprint dedup → embedding via the LLM wrapper →
pgvector insert → `entity_extraction_queue` row → entity worker picks
it up. Every imported message becomes semantically searchable
alongside `obctl capture` content with no extra wiring.

## Architecture

```
integrations/connectors/
├── base.py              # Connector ABC, OB1Client, StateStore, HTTP retry helper
├── __main__.py          # CLI: --once / --watch / --source X / doctor
├── connectors/
│   ├── slack.py         # FULL — bot token + conversations.history poll
│   ├── gmail.py         # stub
│   ├── github_backfill.py
│   ├── linear.py
│   ├── calendar_ics.py
│   ├── figma.py
│   └── notion.py
└── Dockerfile           # python:3.13-alpine, stdlib only
```

Adding a new source = ~50–150 LOC subclass of `Connector` in
`connectors/`, plus one line in `REGISTRY` in `__main__.py`.

## Connector contract

```python
class MyConnector(Connector):
    name = "mything"
    version = "0.1.0"
    required_env = ("MYTHING_TOKEN",)
    optional_env = ("MYTHING_POLL_SECONDS",)

    def configure(self) -> bool:
        self.token = self.env.get("MYTHING_TOKEN", "")
        return bool(self.token)

    def fetch_new(self, state: dict) -> Iterator[Capture]:
        # Use state["cursor"] to read incrementally.
        # Yield Capture(content=..., metadata={...}, source_id=...)
        # Mutate state to advance cursor. Framework saves it.
        ...
```

## Running

### Local one-shot

```bash
cd ~/github.com/.../OB1
OB1_URL=http://localhost:18011 \
OB1_KEY=$(grep '^MCP_ACCESS_KEY=' .env.tech-screen | cut -d= -f2-) \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_ALLOWED_CHANNELS=eng-general,eng-infra \
python3 -m integrations.connectors --once --source slack
```

### Docker sidecar (recommended for ongoing sync)

Bring it up alongside the profile's stack:

```bash
IMPORTERS=1 DASHBOARD=1 WORKER=1 make up PROFILE=tech-screen
```

The compose service reads all source-specific env vars from the
active profile's `.env.<profile>` file. Sources without credentials
silently no-op — the same compose service works for every profile.

### Config readiness check

```bash
python3 -m integrations.connectors doctor
```

Prints per-connector status (which required env vars are set, which
are empty) without making any network calls.

## Source attribution metadata (uniform)

Every imported thought lands with:

```json
{
  "source": "slack",
  "source_version": "0.1.0",
  "imported_at": "2026-05-13T18:30:00Z",
  "context": "tech-screen",
  "source_id": "C01ABC/1715600000.001234",
  "source_url": "https://tech-screen.slack.com/archives/...",
  "source_actor": "U02XYZ",
  "source_actor_name": "Brian Doe",
  ...
}
```

The Slack connector additionally sets `source_channel`,
`source_thread_root`, `source_ts`. Other connectors add their own
source-specific fields (`source_pr_number` for GitHub, `source_label`
for Gmail, etc.).

## Slack setup

1. Create a Slack app: <https://api.slack.com/apps?new_app=1>.
2. **OAuth & Permissions** → add Bot Token Scopes:
   - `channels:history`
   - `groups:history` (private channels you've invited the bot to)
   - `users:read`
   - `users:read.email` (optional, for actor email)
   - `channels:read`
3. **Install to Workspace** → copy the Bot User OAuth Token
   (starts with `xoxb-`).
4. Paste into `.env.<profile>`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_ALLOWED_CHANNELS=eng-general,eng-infra
   SLACK_BACKFILL_DAYS=7
   ```
5. Invite the bot to each allowed channel (`/invite @YourBotName`).
6. Backfill one-shot:
   `IMPORTERS=1 make up PROFILE=tech-screen` (sidecar) or
   `python3 -m integrations.connectors --once --source slack`.

## Adding a new source

1. Drop `integrations/connectors/connectors/<source>.py`. Use one of
   the stubs (e.g. `gmail.py`) as a template.
2. Implement `configure()` and `fetch_new()`.
3. Add the class to `REGISTRY` in `__main__.py`.
4. Add required/optional env vars to `.env.example`.
5. Add to `ALLOW_UNREAD` in `ci/check-env-drift.sh` (importer-only
   env vars aren't read by the Deno MCP server).

That's it. No framework changes, no new compose service per source.

## Backlogged / future

- **Live ingest** via webhooks (Slack Events API, Gmail Pub/Sub,
  Notion subscriptions). Requires a public-facing URL — out of scope
  for v1 which targets laptop / private network deploys.
- **OAuth bootstrap CLI** for Google / Microsoft / Notion. One-shot
  tool that runs a loopback HTTP server, captures the auth code,
  exchanges for refresh token, prints the env block.
- **Privacy redaction**: strip SSN / API-key / credit-card patterns
  from content before storing.
- **Quota awareness**: respect per-provider rate limits beyond raw
  HTTP retry/backoff (e.g. Gmail's 1000 msg/day on free tier).
