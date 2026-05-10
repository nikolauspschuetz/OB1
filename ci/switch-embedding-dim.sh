#!/usr/bin/env bash
# Rewrite the embedding-dimension in the SQL migrations and (destructively)
# wipe the active profile's data volume so the new schema takes effect on
# next `make up`. Used by `make switch-embedding-dim N=<dim>`.

set -euo pipefail

N="${1:-}"
PROJECT="${2:-ob1}"
ENV_FILE="${3:-.env}"

if [ -z "$N" ]; then
  echo "Usage: $0 <dim> [project] [env-file]" >&2
  exit 2
fi
case "$N" in
  [1-9][0-9]*) ;;
  *) echo "ERROR: N must be a positive integer (got: $N)" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INIT_SQL="$REPO_ROOT/db/migrations/001_init.sql"
SEARCH_SQL="$REPO_ROOT/db/migrations/002_search_function.sql"

CURRENT=$(grep -oE 'vector\([0-9]+\)' "$INIT_SQL" | head -1 | grep -oE '[0-9]+')

if [ "$CURRENT" = "$N" ]; then
  echo "Schema is already vector($N). Nothing to do."
  exit 0
fi

echo "Current schema dim: $CURRENT"
echo "Target schema dim:  $N"
echo "Project:            $PROJECT"
echo "Env file:           $ENV_FILE"
echo
printf "This will rewrite the SQL migrations AND DELETE the data volume for project '%s'. Continue? [y/N] " "$PROJECT"
read -r ans
if [ "$ans" != "y" ]; then
  echo "Aborted."
  exit 1
fi

for f in "$INIT_SQL" "$SEARCH_SQL"; do
  awk -v n="$N" '{ gsub(/vector\([0-9]+\)/, "vector(" n ")"); print }' "$f" \
    > "$f.tmp" && mv "$f.tmp" "$f"
done

echo
echo "Updated migrations to vector($N):"
grep -nE 'vector\([0-9]+\)' "$INIT_SQL" "$SEARCH_SQL"
echo

echo "Wiping data volume for project '$PROJECT'..."
docker compose -p "$PROJECT" --env-file "$ENV_FILE" down -v
echo
echo "Schema dim switched to $N."
echo "Now: edit $ENV_FILE to point at a model that produces $N-dim vectors, then run \`make up\` to recreate the volume."
echo
echo "Common matches:"
echo "  1536 → openai/text-embedding-3-small (default, GitHub Models)"
echo "  1024 → bedrock/cohere-embed-english-v3 or bedrock/titan-embed-text-v2"
echo "  768  → ollama nomic-embed-text"
