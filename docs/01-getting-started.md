# Build Your Open Brain (Local Docker Compose)

> **This fork's canonical setup path.** Boots a fully self-hosted Open Brain — Postgres + pgvector + the MCP server — as Docker containers on your machine. The only outbound network call is to your chosen LLM provider for embeddings and metadata extraction. No Supabase, no OpenRouter required.
>
> **Prefer the original Supabase Cloud + OpenRouter path?** See [`legacy/01-getting-started-supabase.md`](legacy/01-getting-started-supabase.md). That path is preserved in this fork for one release before removal.

About 5 minutes. Two services run on your machine:

- **Postgres + pgvector** — your thoughts database, vector search, metadata
- **MCP server** — Deno container exposing 4 MCP tools to any AI client

One outbound dependency (your choice):

- **GitHub Models** (recommended; covered by Copilot Pro/Business)
- **Anthropic Claude** for chat + GitHub Models for embeddings
- **OpenRouter** (legacy upstream default)
- **Ollama** (full air-gap, no outbound calls — see notes below)

---

![Step 1](https://img.shields.io/badge/Step_1-Prerequisites-1E88E5?style=for-the-badge)

You need three things installed locally:

- **Docker Desktop** (or any Docker Engine 24+ with `docker compose` v2)
- **`make`** — ships with macOS / standard on Linux / WSL on Windows
- **`openssl`** — ships with macOS / standard on Linux / available in Git Bash on Windows

Verify:

```bash
docker --version          # Docker version 24.0+ ...
docker compose version    # Docker Compose version v2.20+ ...
make --version            # GNU Make 3.81 or later
openssl version           # LibreSSL or OpenSSL
```

✅ **Done when:** All four commands return a version.

---

![Step 2](https://img.shields.io/badge/Step_2-Configure_.env-F4511E?style=for-the-badge)

Clone (or `cd` into your existing checkout) and bootstrap `.env`:

```bash
cp .env.example .env
make env
```

`make env` does two things:

1. Creates `.env` from `.env.example` if it doesn't exist.
2. Generates a strong `MCP_ACCESS_KEY` for you if it's blank.

Now open `.env` and fill in two more values:

- **`DB_PASSWORD`** — generate with `openssl rand -hex 24`. This password is local to your container; nobody else sees it.
- **`EMBEDDING_API_KEY`** — your LLM provider key. See Step 3 for which provider to use.

> [!IMPORTANT]
> `.env` is gitignored. Never commit it. The repo would reject it via the automated review anyway.

✅ **Done when:** `.env` has values for `DB_PASSWORD`, `MCP_ACCESS_KEY`, and `EMBEDDING_API_KEY`.

---

![Step 3](https://img.shields.io/badge/Step_3-Pick_an_LLM_Backend-FB8C00?style=for-the-badge)

`.env.example` ships with four pre-configured blocks. Pick one.

<details>
<summary>🔵 <strong>3.A — GitHub Models (recommended)</strong></summary>

If you have **GitHub Copilot Pro or Business**, you already have access to GitHub Models at no marginal cost (within rate limits). It's OpenAI-compatible, ships `text-embedding-3-small` (1536-dim — matches our schema), and works as a drop-in replacement for OpenAI/OpenRouter.

1. Create a GitHub PAT at [github.com/settings/tokens](https://github.com/settings/tokens) with the `models:read` scope (fine-grained tokens work too).
2. In `.env`, set:
   ```
   EMBEDDING_API_BASE=https://models.github.ai/inference
   EMBEDDING_API_KEY=<your-github-pat>
   EMBEDDING_MODEL=openai/text-embedding-3-small
   CHAT_PROVIDER=openai
   CHAT_MODEL=openai/gpt-4o-mini
   ```
3. Leave `CHAT_API_BASE` and `CHAT_API_KEY` blank — they default to the embedding values.

</details>

<details>
<summary>🟣 <strong>3.B — Anthropic Claude (chat) + GitHub Models (embeddings)</strong></summary>

Claude doesn't ship an embedding model, so embeddings go through an OpenAI-compatible endpoint while chat / metadata extraction goes to Claude directly.

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com).
2. Get a GitHub PAT (see 3.A) for embeddings.
3. In `.env`:
   ```
   EMBEDDING_API_BASE=https://models.github.ai/inference
   EMBEDDING_API_KEY=<your-github-pat>
   EMBEDDING_MODEL=openai/text-embedding-3-small

   CHAT_PROVIDER=anthropic
   ANTHROPIC_API_KEY=<your-anthropic-key>
   ANTHROPIC_CHAT_MODEL=claude-haiku-4-5-20251001
   ```

</details>

<details>
<summary>🟢 <strong>3.C — OpenRouter (legacy upstream default)</strong></summary>

Works, but you're paying for a router on top of OpenAI. Included for parity with upstream Open Brain.

1. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), add ~$5 in credits.
2. In `.env`, swap to the OpenRouter block (commented in `.env.example`).

</details>

<details>
<summary>⚫ <strong>3.D — Ollama (full air-gap)</strong></summary>

Zero outbound network calls. Requires a local Ollama install with both an embedding model and a chat model pulled.

> [!CAUTION]
> Ollama's `nomic-embed-text` produces **768-dim** embeddings, not 1536. Before the first `make up` you must edit `db/migrations/001_init.sql` and `db/migrations/002_search_function.sql` and change every `vector(1536)` to `vector(768)`. After thoughts exist in the database, you cannot change embedding dimensions without re-embedding everything.

1. `ollama pull nomic-embed-text && ollama pull llama3.1:8b`
2. In `.env`, swap to the Ollama block.

</details>

✅ **Done when:** Your `.env` has a single uncommented LLM block with valid keys.

---

![Step 4](https://img.shields.io/badge/Step_4-Boot_the_Stack-43A047?style=for-the-badge)

One command:

```bash
make setup
```

This runs:

1. `make doctor` — checks Docker, ports, `.env` completeness
2. `make build` — builds the MCP server image
3. `make up` — starts both containers
4. `make verify` — calls `/healthz` and the MCP `tools/list` endpoint
5. `make urls` — prints your MCP Server URL and Connection URL

If you'd rather run them one at a time, `make help` lists every target.

> [!NOTE]
> First boot takes ~30s while pgvector initializes the database from `db/migrations/`. Subsequent restarts are sub-second.

✅ **Done when:** `make verify` prints `OK — MCP server is responding.`

---

![Step 5](https://img.shields.io/badge/Step_5-Connect_to_Your_AI-5C6BC0?style=for-the-badge)

Get your URLs:

```bash
make urls
```

You'll see something like:

```text
MCP Server URL:     http://localhost:8000
MCP Connection URL: http://localhost:8000?key=<MCP_ACCESS_KEY>
Header alternative: -H 'x-brain-key: <MCP_ACCESS_KEY>'
```

Pick your AI client below.

<details>
<summary>🤖 <strong>5.1 — Claude Desktop</strong></summary>

1. Settings → Connectors → Add custom connector
2. Name: `Open Brain`
3. Remote MCP server URL: paste the **MCP Connection URL**
4. Click **Add**

> [!NOTE]
> Claude Desktop accepts `http://localhost` URLs — no HTTPS or tunnel required. If you connect from another device on your LAN, replace `localhost` with your machine's IP.

</details>

<details>
<summary>🤖 <strong>5.2 — ChatGPT</strong></summary>

> [!WARNING]
> ChatGPT's MCP connector requires an **HTTPS** URL accessible from ChatGPT's servers. `http://localhost` will not work. Expose the server via a tunnel:
>
> ```bash
> # Cloudflare (free, no account required for quick tests)
> cloudflared tunnel --url http://localhost:8000
> # → https://random-name.trycloudflare.com
> ```
>
> Then use `https://random-name.trycloudflare.com?key=<your-key>` as the MCP endpoint URL in ChatGPT's Apps & Connectors → Create flow. Set Authentication: No Authentication.

</details>

<details>
<summary>🤖 <strong>5.3 — Claude Code</strong></summary>

```bash
claude mcp add --transport http open-brain \
  http://localhost:8000 \
  --header "x-brain-key: <your-MCP_ACCESS_KEY>"
```

</details>

<details>
<summary>🤖 <strong>5.4 — OpenAI Codex</strong></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.open-brain]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "http://localhost:8000?key=<your-MCP_ACCESS_KEY>"
]
startup_timeout_sec = 30
```

</details>

<details>
<summary>🤖 <strong>5.5 — Cursor / VS Code Copilot / Windsurf</strong></summary>

If your client supports remote HTTP MCP servers, paste the **MCP Connection URL** directly. If it only supports local stdio, bridge via `supergateway`:

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--streamableHttp",
        "http://localhost:8000?key=<your-MCP_ACCESS_KEY>"
      ]
    }
  }
}
```

</details>

✅ **Done when:** Your AI client lists 4 Open Brain tools: `search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`.

---

![Step 6](https://img.shields.io/badge/Step_6-Capture_a_Test_Thought-8E24AA?style=for-the-badge)

In your connected AI:

```text
Remember this: Sarah mentioned she's thinking about leaving her job to start a consulting business
```

Then:

```text
What did I capture about Sarah?
```

You should see your captured thought retrieved by semantic search.

Verify it landed in the database:

```bash
make psql
```

```sql
select id, content, metadata->'topics' as topics, created_at
  from thoughts order by created_at desc limit 5;
\q
```

✅ **Done when:** A row exists in the `thoughts` table with your captured content and a populated `metadata` jsonb.

---

## Day-2 Operations

| Task | Command |
| --- | --- |
| Tail logs | `make logs` |
| Stop the stack | `make down` |
| Restart MCP server only | `make restart` |
| Open psql shell | `make psql` |
| Print connection URLs | `make urls` |
| Rotate MCP access key | `make rotate-key` |
| Wipe everything (data volume + images) | `make nuke` |

## Terminal client: `obctl`

`bin/obctl` is a small Deno CLI that talks to your local MCP server. Useful for capturing thoughts from scripts, cron jobs, or git hooks without going through an AI client.

```bash
# Install onto PATH (requires deno; install with: curl -fsSL https://deno.land/install.sh | sh)
make obctl-install

# Use
obctl capture "Decided to migrate the payments service to pgbouncer this sprint"
obctl search "payments migration"
obctl list --days 7 --type idea
obctl stats
obctl health

# Pipe a longer thought from another tool
git log --oneline -1 | obctl capture --stdin
```

Or run it without installing:

```bash
bin/obctl capture "..."
```

## Optional: AWS Bedrock via LiteLLM gateway

Bedrock isn't OpenAI-compatible (SigV4 signing, per-model request shapes). This fork ships a [LiteLLM](https://github.com/BerriAI/litellm) container under the `bedrock` compose profile that translates OpenAI-format requests to Bedrock. The MCP server keeps speaking OpenAI to a local URL; LiteLLM does the SigV4 dance.

### Enable

1. Have AWS credentials with Bedrock access (and the model IDs in `ci/litellm-config.yaml` enabled in your account/region).
2. In `.env`, set:
   ```
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   AWS_REGION=us-east-1
   AWS_SESSION_TOKEN=        # only if using temp creds
   ```
3. Point the MCP server at LiteLLM. Add to `.env`:
   ```
   CHAT_PROVIDER=openai
   CHAT_API_BASE=http://litellm:4000
   CHAT_API_KEY=anything       # LiteLLM doesn't validate; the MCP server still sends Bearer
   CHAT_MODEL=bedrock/claude-haiku
   ```
4. Bring up the stack with the bedrock profile:
   ```bash
   BACKEND=bedrock make up
   # or: docker compose --profile bedrock up -d
   ```

`docker compose ps` should show three services: `db`, `mcp`, and `litellm` on port 4000.

### Embedding-dimension caveat

> [!CAUTION]
> Bedrock embedding models produce **different dimensions than `text-embedding-3-small`'s 1536**:
>
> - Cohere `embed-english-v3` → **1024**
> - Titan `embed-text-v2` → **1024** (also supports 512 / 256 with the `dimensions` param)
>
> The `thoughts.embedding` column and `match_thoughts` function are sized to 1536. If you route embeddings through Bedrock, you must:
>
> 1. Edit `db/migrations/001_init.sql` and `db/migrations/002_search_function.sql` — change every `vector(1536)` to `vector(1024)`.
> 2. Wipe the data volume before first boot: `make clean`.
>
> After thoughts exist, you cannot change embedding dimensions without re-embedding everything.
>
> **Recommended hybrid:** keep embeddings on GitHub Models (1536, no schema change) and route only chat through Bedrock. That's what the example `.env` block in `.env.example` Block E sets up.

### Available routes

`ci/litellm-config.yaml` defines:

| Route name | Underlying Bedrock model | Use |
| --- | --- | --- |
| `bedrock/claude-haiku` | `anthropic.claude-3-5-haiku-20241022-v1:0` | Fast chat / metadata extraction |
| `bedrock/claude-sonnet` | `anthropic.claude-3-5-sonnet-20241022-v2:0` | Higher-quality chat |
| `bedrock/cohere-embed-english` | `cohere.embed-english-v3` | Embeddings (1024-dim) |
| `bedrock/titan-embed-v2` | `amazon.titan-embed-text-v2:0` | Embeddings (1024-dim) |

Add more by editing `ci/litellm-config.yaml` and restarting: `BACKEND=bedrock make restart`.

### Verify your AWS access without committing to running Bedrock

```bash
# After setting AWS_* in .env (or .env.<profile>):
make verify-bedrock
# or:
make verify-bedrock PROFILE=work BEDROCK_CHAT_MODEL=bedrock/claude-sonnet
```

This boots a one-shot LiteLLM container on port 14000 (so it doesn't clash with any running stack), makes one chat request and one embeddings request through it with your real AWS credentials, reports timing + response shape, and tears down. Costs a few cents. Run it before flipping your real `.env` to point chat or embeddings at LiteLLM — if `verify-bedrock` fails you'll see the LiteLLM error in clear text (model access not enabled in your account, region mismatch, expired creds, etc.) without breaking your live stack.

## Optional: Multi-environment profiles

Run multiple isolated Open Brain stacks side-by-side, each with its own use-case identity. Common pattern: a "work" brain that captures from your work GitHub org, a "personal" brain for life logistics, an "engineering" brain for ADRs and infra decisions. Each profile gets its own:

- Compose project (`ob1-<profile>` — e.g. `ob1-work`)
- Postgres volume (data is fully isolated)
- Ports (you pick non-conflicting `MCP_PORT` / `DB_PORT` per profile)
- MCP access key (so you can revoke one without affecting others)
- Env file (`.env.<profile>`)

### Bootstrap a new profile

```bash
make profile-init NAME=work
# edit .env.work — set DB_PASSWORD, EMBEDDING_API_KEY, and pick non-default ports
# (e.g. MCP_PORT=18001, DB_PORT=65433)
make up PROFILE=work
make urls PROFILE=work       # prints the work brain's connection URL
```

Repeat for `personal`, `engineering`, etc. — pick different ports each time.

### Use a profile

Every operational target accepts `PROFILE=<name>`:

```bash
make up      PROFILE=work
make logs    PROFILE=work
make psql    PROFILE=work
make verify  PROFILE=work
make rotate-key PROFILE=work
make down    PROFILE=work
```

`obctl` supports `--profile` (or `OB1_PROFILE` env) to read the right env file:

```bash
obctl --profile work    capture "Shipped pgbouncer migration today"
obctl --profile personal capture "Meal plan for next week"
obctl --profile work    search "pgbouncer"
```

### List active profiles

```bash
make profile-list
```

Output shows each known profile, its env file, compose project name, and whether it's running.

### Smoke tests don't touch real profiles

`make smoke` and `make smoke-webhook` always run under a fixed throwaway profile (`ob1-smoke` on port 18000, `.env.smoke` from `ci/.env.ci`). They never touch your real `.env` or any `.env.<profile>` you've set up. Safe to run while real profiles are live.

## Optional: Prometheus metrics

The MCP server exposes Prometheus text-format metrics at `GET /metrics`. Default is unauthenticated (typical pattern for a private-network scrape); set `METRICS_TOKEN` in `.env` and your scraper sends `Authorization: Bearer <token>` if you expose the server publicly.

```bash
make metrics    # curl /metrics on the running stack
```

What's exposed:

| Metric | Type | Labels | What |
| --- | --- | --- | --- |
| `ob1_captures_total` | counter | `source` | Captured thoughts by source (`mcp`, `github_webhook`) |
| `ob1_searches_total` / `ob1_lists_total` / `ob1_stats_total` | counter | — | MCP tool call counts |
| `ob1_embedding_requests_total` | counter | `outcome` | Embedding API calls (`success`, `error`, `mock`) |
| `ob1_chat_requests_total` | counter | `provider`, `outcome` | Chat / metadata extraction calls (`openai`, `anthropic`, `mock`) |
| `ob1_webhook_deliveries_total` | counter | `event`, `outcome` | GitHub webhook deliveries (`captured`, `skipped`, `invalid_signature`, `ping`, `error`) |
| `ob1_thoughts_total` | gauge | — | Current row count in the thoughts table (cached up to 30s) |
| `ob1_uptime_seconds` | gauge | — | Process uptime |
| `ob1_build_info` | gauge | `version` | Build info; value always 1 |
| `ob1_embedding_duration_seconds` | histogram | — | Embedding request latency |
| `ob1_chat_duration_seconds` | histogram | — | Chat / metadata extraction latency |
| `ob1_capture_duration_seconds` | histogram | — | Full capture pipeline latency |

Sample Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: open-brain
    static_configs:
      - targets: ['localhost:8000']
    # If METRICS_TOKEN is set:
    # authorization:
    #   credentials_file: /etc/ob1/metrics-token
```

## Optional: GitHub webhook capture

Capture merged PRs and published releases from any GitHub repo as Open Brain thoughts. Useful for keeping a searchable timeline of what shipped, by whom, and where — without manually capturing anything.

### Enable it

1. Generate a webhook secret and put it in `.env`:
   ```bash
   echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
   make restart
   ```
2. Make your server reachable from GitHub. `localhost:8000` won't work — GitHub's servers need to reach it. A free tunnel works for testing:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   # → https://random-name.trycloudflare.com
   ```
   For permanent use, deploy behind your own HTTPS endpoint (Caddy, nginx, ngrok, fly.io, etc.).
3. In your GitHub repo (or org) → Settings → Webhooks → Add webhook:
   - **Payload URL:** `https://<your-public-url>/webhook/github`
   - **Content type:** `application/json`
   - **Secret:** the `GITHUB_WEBHOOK_SECRET` value from your `.env`
   - **Events:** "Let me select" → check **Pull requests** and **Releases**
4. Click **Add webhook**. GitHub sends a `ping` event immediately — if the delivery shows ✅, you're connected.

### What gets captured

| Event | When | Captured content |
| --- | --- | --- |
| `pull_request` (closed + merged) | A PR is merged | Title, repo, author, +/- line counts, files changed, URL |
| `release` (published) | A release is published | Tag, repo, author, release notes (truncated to 800 chars), URL |
| `ping` | GitHub setup probe | Acknowledged, not stored |
| Other events | — | Acknowledged, not stored (`captured: false`) |

Each captured thought gets:
- `metadata.type = "reference"`
- `metadata.topics = ["github", "<repo-name>", "pr-merged" or "release"]`
- `metadata.people = ["<author-login>"]`
- `metadata.source = "github_webhook"`
- `metadata.github = { event, repo, number/tag, url, ... }`

So `obctl list --topic pr-merged --days 30` gives you a month of merged PRs across every repo you've connected. `obctl search "authentication middleware"` finds them by content.

### Disable

Empty out `GITHUB_WEBHOOK_SECRET` in `.env` and `make restart`. The endpoint returns 404 when not configured.

### Local validation

`make smoke-webhook` boots the stack with `LLM_MOCK=true` + a test secret, posts synthetic ping / PR-merged / release deliveries with correctly computed HMAC signatures, asserts each is captured, asserts a bad signature returns 401, and tears down. No real GitHub connection or LLM credentials needed.

## Optional: Linear, Sentry, and Generic webhook capture

Besides GitHub, the server can ingest webhooks from Linear (issue completed), Sentry (issue resolved), and any custom source via a generic Bearer-auth endpoint.

| Source | Endpoint | Auth | Trigger event |
| --- | --- | --- | --- |
| Linear | `POST /webhook/linear` | `linear-signature` HMAC-SHA-256 of body | `Issue` `update` events with `state.type=completed` |
| Sentry | `POST /webhook/sentry` | `sentry-hook-signature` HMAC-SHA-256 of body | `issue.resolved` |
| Generic | `POST /webhook/generic` | `Authorization: Bearer <secret>` | Body: `{"content":"...","metadata":{...}}` |

All three honor the same enable-by-secret pattern as GitHub: leave the env var empty, the endpoint returns 404. Each captures with `metadata.source = "<name>_webhook"` so you can `obctl list --source linear_webhook` etc.

Set the secrets in `.env`:

```
LINEAR_WEBHOOK_SECRET=$(openssl rand -hex 32)
SENTRY_WEBHOOK_SECRET=$(openssl rand -hex 32)
GENERIC_WEBHOOK_SECRET=$(openssl rand -hex 32)
make restart
```

Configure each source to POST to your tunneled URL and use the corresponding secret. `make smoke-webhook` exercises all four sources end-to-end with synthetic payloads.

## Smoke testing without LLM credentials

`LLM_MOCK=true` makes the server return deterministic stub embeddings and metadata — no LLM provider calls. Useful for verifying the stack works before you commit credentials.

```bash
make smoke
```

This boots a fresh stack with `LLM_MOCK=true`, captures a sentinel sentence via `obctl`, searches for it (mock embeddings are identity-only, so exact-string searches hit 100%), lists, runs stats, and tears down. Round-trip in under 30 seconds, zero credentials needed.

> [!IMPORTANT]
> Mock embeddings carry no semantic signal. Real captures need a real LLM provider. After smoke testing, set `LLM_MOCK=false` (or remove it) and add your `EMBEDDING_API_KEY` before capturing anything you want to retrieve later.

---

## Troubleshooting

<details>
<summary>❌ <strong>make verify</strong> returns 401</summary>

`MCP_ACCESS_KEY` in `.env` doesn't match what the server booted with. Either re-run `make up` (the container picks up `.env` on start) or run `make rotate-key` and update your AI client.

</details>

<details>
<summary>❌ <strong>make verify</strong> returns 500 / embedding error</summary>

Your LLM provider key is invalid, your embedding model name is wrong, or you've hit a rate limit. Check `make logs` for the underlying error from the MCP container. Confirm `EMBEDDING_API_BASE`, `EMBEDDING_API_KEY`, and `EMBEDDING_MODEL` match your chosen provider.

</details>

<details>
<summary>❌ Database init didn't run / tables missing</summary>

The init scripts in `db/migrations/` only run on **first boot** when the data volume is empty. If you previously booted with a different schema, run `make clean` (destructive — wipes the volume) then `make up`.

</details>

<details>
<summary>❌ Port 8000 (or 5432) already in use</summary>

Change `MCP_PORT` (or `DB_PORT`) in `.env` to a free port and re-run `make up`. The host port is configurable; the container ports are fixed.

</details>

<details>
<summary>❌ Search returns no results</summary>

Capture at least one thought first. Then try with a lower threshold: ask your AI to "search with threshold 0.3". If the embedding column is null on your test row, the embedding API call failed during capture — check `make logs`.

</details>

---

## What's next

Your Open Brain is live and self-hosted. From here:

- **[Companion Prompts](02-companion-prompts.md)** — Memory migration, capture templates, weekly review
- **[`/recipes`](../recipes/)** — Bulk-import data from Gmail, ChatGPT, Obsidian, X, Instagram, Google Takeout
- **[`/integrations`](../integrations/)** — Slack/Discord capture, alternate deployment targets
- **[Tool Audit Guide](05-tool-audit.md)** — Manage your MCP tool surface area as you add extensions
