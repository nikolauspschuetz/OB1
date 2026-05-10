#!/usr/bin/env bash
# Drift detector between server/**/*.ts (what the server reads) and
# .env.example (what we document). Run by `make check-env-drift`.
#
# - FAIL if server reads a var that's not in .env.example (undocumented).
# - WARN if .env.example has a var the server never reads (stale doc).
#
# A small allow-list at the top of this script handles env vars that are
# legitimately present in only one place (e.g. POSTGRES_* set by the db
# container, not read by the server).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# Vars that appear in .env.example but the server never reads (consumed by
# Postgres container, docker-compose, the Makefile, or the LiteLLM gateway).
ALLOW_UNREAD=(
  DB_NAME DB_USER DB_PASSWORD DB_PORT
  MCP_PORT
  LITELLM_PORT LITELLM_LOG
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_PROFILE
)

if [[ ! -d "$SERVER_DIR" ]]; then
  echo "ERROR: $SERVER_DIR not found"; exit 2
fi
if [[ ! -f "$ENV_EXAMPLE" ]]; then
  echo "ERROR: $ENV_EXAMPLE not found"; exit 2
fi

# Names the server reads via Deno.env.get("X") across every .ts file in
# server/ (index.ts plus llm/, future modules, etc).
SERVER_VARS=()
while IFS= read -r v; do SERVER_VARS+=("$v"); done < <(
  find "$SERVER_DIR" -type f -name '*.ts' -print0 \
  | xargs -0 grep -hoE 'Deno\.env\.get\("[A-Z][A-Z0-9_]*"\)' \
  | sed -E 's/.*"([A-Z][A-Z0-9_]*)".*/\1/' \
  | sort -u
)

# Names declared in .env.example (KEY=value lines, ignore comments/blanks).
ENV_VARS=()
while IFS= read -r v; do ENV_VARS+=("$v"); done < <(
  grep -E '^[A-Z][A-Z0-9_]*=' "$ENV_EXAMPLE" \
  | sed -E 's/^([A-Z][A-Z0-9_]*)=.*/\1/' \
  | sort -u
)

contains() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

missing_from_example=()
for v in "${SERVER_VARS[@]}"; do
  if ! contains "$v" "${ENV_VARS[@]}"; then
    missing_from_example+=("$v")
  fi
done

unread_by_server=()
for v in "${ENV_VARS[@]}"; do
  if ! contains "$v" "${SERVER_VARS[@]}" && ! contains "$v" "${ALLOW_UNREAD[@]}"; then
    unread_by_server+=("$v")
  fi
done

status=0

if (( ${#missing_from_example[@]} > 0 )); then
  echo "FAIL: server reads these vars but they're missing from .env.example:"
  for v in "${missing_from_example[@]}"; do echo "  - $v"; done
  status=1
fi

if (( ${#unread_by_server[@]} > 0 )); then
  echo "WARN: .env.example documents these vars but the server doesn't read them:"
  for v in "${unread_by_server[@]}"; do echo "  - $v"; done
  echo "  (Add to ALLOW_UNREAD in $0 if intentional, e.g. consumed by docker-compose.)"
fi

if (( status == 0 )) && (( ${#unread_by_server[@]} == 0 )); then
  echo "OK — env vars in $SERVER_DIR and $ENV_EXAMPLE are in sync."
  echo "  server reads: ${#SERVER_VARS[@]}"
  echo "  example documents: ${#ENV_VARS[@]}"
fi

exit "$status"
