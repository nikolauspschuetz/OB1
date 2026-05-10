#!/usr/bin/env bash
# Pull a GitHub PAT for the active OB1 profile via the user-side gh.sh
# wrapper (which auto-switches gh auth based on the org's .gh-user file)
# and write it to EMBEDDING_API_KEY in the profile's env file.
#
# Workflow:
#   1. Resolve the profile name from $ENV_FILE
#   2. Find which ~/github.com/<org>/.ob1-profile matches that profile
#   3. cd into that org dir so ~/github.com/gh.sh auto-switches gh auth
#      to the matching .gh-user account
#   4. gh auth token (via the wrapper) -> that account's PAT
#   5. Write the PAT to .env.<profile>'s EMBEDDING_API_KEY
#
# Each profile gets its OWN PAT issued by its OWN GitHub account -- exactly
# the per-org isolation the gh.sh wrapper provides.

set -euo pipefail

ENV_FILE="${1:?env file required (e.g. .env.tech-screen)}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_PATH="$REPO_ROOT/$ENV_FILE"

if [ ! -f "$ENV_PATH" ]; then
  echo "ERROR: $ENV_PATH not found" >&2
  exit 1
fi

case "$ENV_FILE" in
  .env)
    echo "ERROR: import-gh-token needs a named profile (PROFILE=<name>)." >&2
    echo "       The default .env doesn't have an associated org dir." >&2
    exit 1
    ;;
  .env.*)
    PROFILE_NAME="${ENV_FILE#.env.}"
    ;;
  *)
    echo "ERROR: unrecognized env file: $ENV_FILE" >&2
    exit 1
    ;;
esac

# Find the org dir whose .ob1-profile matches this profile name.
ORG_DIR=""
for f in "$HOME/github.com"/*/.ob1-profile; do
  [ -f "$f" ] || continue
  if [ "$(cat "$f" | tr -d '[:space:]')" = "$PROFILE_NAME" ]; then
    ORG_DIR="$(dirname "$f")"
    break
  fi
done

if [ -z "$ORG_DIR" ]; then
  echo "ERROR: no org dir has .ob1-profile = '$PROFILE_NAME'" >&2
  echo "       Place a marker: echo $PROFILE_NAME > ~/github.com/<org>/.ob1-profile" >&2
  exit 1
fi

if [ ! -f "$HOME/github.com/gh.sh" ]; then
  echo "ERROR: ~/github.com/gh.sh not found -- this target requires the gh-auth wrapper" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not installed" >&2
  exit 1
fi

GH_USER_FILE="$ORG_DIR/.gh-user"
GH_USER=""
[ -f "$GH_USER_FILE" ] && GH_USER="$(cat "$GH_USER_FILE" | tr -d '[:space:]')"

echo "-------------------------------------------------------------"
echo " profile:   $PROFILE_NAME"
echo " org dir:   $ORG_DIR"
echo " gh user:   ${GH_USER:-(no .gh-user -- gh.sh will not auto-switch)}"
echo " env file:  $ENV_PATH"
echo "-------------------------------------------------------------"
echo

echo "-> cd into org dir + invoke gh.sh (auto-switches gh auth)"
cd "$ORG_DIR"
# Capture STDOUT only so gh.sh's "Switching gh auth..." stderr diagnostic
# doesn't end up inside the token value.
if ! TOKEN=$("$HOME/github.com/gh.sh" auth token 2>/tmp/gh-token-err.$$); then
  echo "ERROR: gh.sh auth token failed:" >&2
  cat /tmp/gh-token-err.$$ >&2 || true
  rm -f /tmp/gh-token-err.$$
  echo >&2
  echo "If gh.sh said no auth for $GH_USER, run:" >&2
  echo "  gh auth login --hostname github.com --web --scopes 'models:read'" >&2
  echo "(after switching to the $GH_USER account)" >&2
  exit 1
fi
rm -f /tmp/gh-token-err.$$
# Strip any whitespace/newlines from the captured token.
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')

if [ -z "$TOKEN" ]; then
  echo "ERROR: empty token from gh.sh" >&2
  exit 1
fi

ACTIVE_USER=$(command gh auth status 2>&1 | grep -B1 "Active account: true" | grep "Logged in to" | head -1 | awk '{print $7}' || true)
echo "-> active gh user after switch: ${ACTIVE_USER:-?}"
if [ -n "$GH_USER" ] && [ "$ACTIVE_USER" != "$GH_USER" ]; then
  echo "  WARNING: expected $GH_USER but got $ACTIVE_USER -- did the switch fail?" >&2
fi

echo "-> token retrieved (${#TOKEN} chars)"

# Write to EMBEDDING_API_KEY in the env file. Use awk to handle the existing
# value cleanly (whether empty or already populated).
awk -v t="$TOKEN" '
  /^EMBEDDING_API_KEY=/ { print "EMBEDDING_API_KEY=" t; next }
  { print }
' "$ENV_PATH" > "$ENV_PATH.tmp" && mv "$ENV_PATH.tmp" "$ENV_PATH"

echo "-> wrote EMBEDDING_API_KEY to $ENV_PATH"
echo
echo "Quick sanity check:"
echo "  curl -fsS -H \"Authorization: Bearer \$(grep ^EMBEDDING_API_KEY= $ENV_FILE | cut -d= -f2-)\" \\"
echo "    https://models.github.ai/inference/embeddings \\"
echo "    -d '{\"model\":\"openai/text-embedding-3-small\",\"input\":\"hi\"}' | head -c 200"
echo
echo "If you get 'must accept the GitHub Marketplace EULA' or 'models:read scope required',"
echo "either accept the EULA at https://github.com/settings/copilot or re-issue the token with:"
echo "  cd $ORG_DIR && $HOME/github.com/gh.sh auth refresh -h github.com -s 'models:read'"
echo "then re-run: make import-gh-token PROFILE=$PROFILE_NAME"
