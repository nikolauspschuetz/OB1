# OB1 Slack bot (Socket Mode)

Long-lived sidecar that opens a WebSocket to Slack and acts as a
conversational front-end to the active profile's Open Brain. No
public URL needed — Slack's Socket Mode connects outbound from the
bot to Slack, so this runs cleanly behind NAT (laptop, home network).

## What it does

- **DM the bot a question** → RAG answer with citations
  > User: "What did Brian say about WireGuard rotation?"
  > Bot: "Brian noted that VPN credentials are auto-rotated via Hetzner
  > DNS with 30-day expiry. [#abc12345]"

- **DM the bot a memo** with `remember:` prefix → capture as a thought
  > User: "remember: decided to ship the dashboard behind Traefik this week"
  > Bot: "✓ Captured. (id=def456..)"

- **@mention the bot in any channel** → same as DM, but reply in-thread

Everything else (typos, "hi", random messages) gets a single-line help
hint with the available verbs.

## Setup

### 1. Update the Slack app

Already in `connectors/slack-manifest.json`. If your app exists from
the earlier polling setup, apply the manifest delta via the Slack UI:

1. Go to your app's **App Manifest** page
2. Paste the contents of `integrations/connectors/connectors/slack-manifest.json`
3. **Save Changes** — Slack will prompt you to reinstall with the new scopes
   (`app_mentions:read`, `im:history`, `im:read`, `im:write`, `chat:write`)
4. Reinstall, grant scopes

### 2. Generate an App-Level Token

This is different from the Bot OAuth Token. Socket Mode requires a
separate `xapp-...` token that authorizes WebSocket connections.

1. App settings → **Basic Information** → scroll to **App-Level Tokens**
2. Click **Generate Token and Scopes**
3. Name: `socket-mode`
4. Add scope: `connections:write`
5. Copy the `xapp-...` token

### 3. Wire it into the profile

Add to `.env.<profile>`:

```bash
SLACK_BOT_TOKEN=xoxb-...      # already set from polling setup
SLACK_APP_TOKEN=xapp-...      # NEW — for Socket Mode
DASHBOARD_PUBLIC_URL=http://linguado.ob1.localhost:3010   # for citation links
```

### 4. Bring it up

```bash
SLACKBOT=1 IMPORTERS=1 DASHBOARD=1 WORKER=1 make up PROFILE=linguado
```

Or just the bot (assumes the rest of the stack is already up):

```bash
docker compose -p ob1-linguado --env-file .env.linguado \
  -f docker-compose.yml -f docker-compose.gateway.yml \
  --profile slackbot up -d --build slack-bot
```

### 5. Test

DM **@OpenBrain** something. You should get a reply within a few seconds.

## How it works

- **Transport:** `slack_sdk.socket_mode.SocketModeClient` opens a
  WebSocket to Slack. Slack pushes events (DMs, @mentions). The bot
  acks each event then processes it in a thread.
- **Command parsing:** simple prefix match. `remember:` / `note:` /
  `capture:` → capture path. Anything else → query path.
- **Capture path:** POST to MCP `capture_thought` with
  `metadata.source=slack-dm`, `metadata.source_actor`, channel info.
- **Query path:** POST to `/dashboard-api/chat` with single-turn
  history. RAG runs server-side. Bot posts the answer + a sources
  footer with dashboard deep-links.
- **State:** none. The bot itself is stateless; every interaction
  is independent. Chat history lives in the dashboard's `/chat`
  page if you want a multi-turn thread.

## Slash commands?

Out of scope for this bot — see `.planning/external-sources-design.md`
for the slash-command path (would be a separate webhook endpoint). The
Socket Mode bot covers the same UX with more flexibility.
