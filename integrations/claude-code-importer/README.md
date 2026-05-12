# Claude Code session-history importer

Imports your local Claude Code conversation history (the `*.jsonl` files
under `~/.claude/projects/`) into Open Brain as captured thoughts. Useful
for surfacing past sessions in semantic search.

## What it captures

- Only `role=user` turns (your prompts), not Claude's responses.
- Skips turns shorter than `IMPORT_MIN_LEN` (default 40 chars) to keep
  one-word "yes" / "go" turns out of the brain.
- Truncates turns longer than `IMPORT_MAX_LEN` (default 8000 chars).
- Per-file byte-offset tracking in `~/.cache/ob1/claude-code-state.json`
  means re-runs only read new content.
- OB1's `content_fingerprint` UNIQUE index dedups across re-imports.

## One-shot run

```bash
OB1_URL=http://localhost:8000 \
OB1_KEY=$(grep ^MCP_ACCESS_KEY= .env | cut -d= -f2-) \
python3 integrations/claude-code-importer/import.py --once
```

## Watch loop (default 15-minute poll)

```bash
OB1_URL=http://localhost:8000 \
OB1_KEY=... \
IMPORT_POLL_SECONDS=900 \
python3 integrations/claude-code-importer/import.py --watch
```

Or run it as a long-lived background service (launchd / systemd / a
container) — whatever your OS provides.

## Env reference

| Env | Default | Purpose |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan |
| `OB1_URL` | `http://localhost:8000` | MCP server base URL |
| `OB1_KEY` | (required) | MCP access key |
| `IMPORT_STATE_FILE` | `~/.cache/ob1/claude-code-state.json` | Per-file byte-offset state |
| `IMPORT_POLL_SECONDS` | `900` | `--watch` poll interval |
| `IMPORT_MIN_LEN` | `40` | Skip turns shorter than this |
| `IMPORT_MAX_LEN` | `8000` | Truncate longer turns |

## Why Python and not Deno?

The importer runs on the host (it needs read access to your
`~/.claude/projects/`, which is outside Docker). Python is on every
macOS / Linux dev machine already; Deno would force an install step.
Single-file script, no dependencies beyond the stdlib.

## Cron / systemd example

```bash
# Add to crontab — runs every 15 min
*/15 * * * * cd $HOME/github.com/.../OB1 && OB1_KEY=... python3 integrations/claude-code-importer/import.py --once >> ~/.cache/ob1/import.log 2>&1
```
