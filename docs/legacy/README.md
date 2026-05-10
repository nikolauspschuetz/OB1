# Legacy: Supabase Cloud + OpenRouter setup

This folder preserves the original Supabase Cloud + OpenRouter setup path for one release. **The canonical setup for this fork is now local Docker Compose** — see [`../01-getting-started.md`](../01-getting-started.md).

## What's here

| File | What it is |
| --- | --- |
| [`01-getting-started-supabase.md`](01-getting-started-supabase.md) | The original 8-step setup using Supabase Cloud + OpenRouter |
| `open-brain-credential-tracker.xlsx` | The original credential tracker spreadsheet |
| `open-brain-guide-mac.xlsx` / `open-brain-guide-mac-tabbed.xlsx` | macOS setup walkthroughs |
| `open-brain-guide-windows.xlsx` / `open-brain-guide-windows-tabbed.xlsx` | Windows setup walkthroughs |

## Spreadsheet → `.env` mapping

If you started setup with the credential tracker and want to migrate to the Docker Compose path, every spreadsheet field maps to an environment variable in `.env`:

| Spreadsheet field | `.env` variable | Notes |
| --- | --- | --- |
| Supabase **Project ref** | *(not used)* | Local Postgres replaces Supabase |
| Supabase **Database password** | `POSTGRES_PASSWORD` | Sets the password for the local Postgres container |
| Supabase **Project URL** | *(not used)* | Local stack runs on `http://localhost:8000` |
| Supabase **Secret key** | *(not used)* | Local Postgres uses `POSTGRES_USER` / `POSTGRES_PASSWORD` directly |
| **OpenRouter API key** | `LLM_API_KEY` (when `LLM_API_BASE` points at OpenRouter) | Or swap `LLM_API_BASE` to GitHub Models / Ollama / Anthropic |
| **MCP Access Key** | `MCP_ACCESS_KEY` | Same purpose, same value works |
| **MCP Server URL** | *(derived)* | `http://localhost:${MCP_PORT}` (default `:8000`) |
| **MCP Connection URL** | *(derived)* | `http://localhost:${MCP_PORT}?key=${MCP_ACCESS_KEY}` |

## Why we moved away

Open Brain was designed to be self-hostable, but the default setup pinned it to two cloud services (Supabase, OpenRouter) that aren't strictly necessary. This fork rebuilds the setup so:

- **All runtimes are local.** Postgres + pgvector and the MCP server run as Docker containers on your machine.
- **LLM backends are pluggable.** Point the server at GitHub Models (covered by Copilot), Anthropic Claude, OpenRouter, Ollama (full air-gap), or any OpenAI-compatible endpoint.
- **One config file replaces the spreadsheet.** Everything goes in `.env`.
- **One command boots the stack.** `make setup`.

## Going back to the Supabase path

The original guide at [`01-getting-started-supabase.md`](01-getting-started-supabase.md) still works against upstream Open Brain (`NateBJones-Projects/OB1`). If you'd rather use Supabase Cloud + OpenRouter, follow that guide instead — but note the server code in this fork is wired for self-hosted Postgres, so you'd want to use the upstream repo, not this fork.

This folder will be removed in a future release.
