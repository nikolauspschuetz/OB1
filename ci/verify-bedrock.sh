#!/usr/bin/env bash
# Real-AWS dry-run probe: boots a one-shot LiteLLM with the active profile's
# AWS credentials and makes one chat request and one embeddings request to
# verify model access end-to-end. Costs a few cents; runs in ~30s.
#
# Usage:
#   ci/verify-bedrock.sh <env-file> [chat-model] [embed-model]
#
# CHAT_MODEL / EMBED_MODEL are LiteLLM route names from ci/litellm-config.yaml.

set -euo pipefail

ENV_FILE="${1:?env file required}"
CHAT_MODEL="${2:-bedrock/claude-haiku}"
EMBED_MODEL="${3:-bedrock/cohere-embed-english}"

# Use a dedicated project + port so verify can run alongside any live stack.
PROJECT="ob1-bedrock-verify"
PORT=14000
HOST="http://localhost:$PORT"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# Two ways to source AWS credentials:
#   1. AWS_PROFILE=<name> in the env file → use the matching profile from
#      ~/.aws/credentials (works with static keys, SSO, or assume-role)
#   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY directly in the env file
# AWS_PROFILE wins if both are set.
PROFILE_NAME=$(grep -E '^AWS_PROFILE=' "$ENV_FILE" | cut -d= -f2- || true)

REGION=$(grep -E '^AWS_REGION=' "$ENV_FILE" | cut -d= -f2- || true)

if [ -n "$PROFILE_NAME" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: $ENV_FILE has AWS_PROFILE=$PROFILE_NAME but the aws CLI is not installed" >&2
    exit 1
  fi
  echo "→ exporting credentials from AWS profile: $PROFILE_NAME"
  EXPORT=$(aws configure export-credentials --profile "$PROFILE_NAME" --format env-no-export 2>&1) || {
    echo "ERROR: aws configure export-credentials failed for profile '$PROFILE_NAME':" >&2
    echo "$EXPORT" >&2
    exit 1
  }
  eval "$EXPORT"
  # Profile region overrides env-file region only if env-file region is empty.
  if [ -z "$REGION" ]; then
    REGION=$(aws configure get region --profile "$PROFILE_NAME" || true)
  fi
else
  if ! grep -qE '^AWS_ACCESS_KEY_ID=.+' "$ENV_FILE"; then
    echo "ERROR: $ENV_FILE has no AWS_PROFILE and AWS_ACCESS_KEY_ID is empty" >&2
    exit 1
  fi
  if ! grep -qE '^AWS_SECRET_ACCESS_KEY=.+' "$ENV_FILE"; then
    echo "ERROR: AWS_SECRET_ACCESS_KEY is empty in $ENV_FILE" >&2
    exit 1
  fi
  AWS_ACCESS_KEY_ID=$(grep -E '^AWS_ACCESS_KEY_ID=' "$ENV_FILE" | cut -d= -f2-)
  AWS_SECRET_ACCESS_KEY=$(grep -E '^AWS_SECRET_ACCESS_KEY=' "$ENV_FILE" | cut -d= -f2-)
  AWS_SESSION_TOKEN=$(grep -E '^AWS_SESSION_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
fi

# Default region if neither the env file nor the profile set one.
if [ -z "${REGION:-}" ]; then
  REGION="us-east-1"
fi
export AWS_REGION="$REGION"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

echo "─────────────────────────────────────────────────────────────"
echo " Open Brain — Bedrock dry-run probe"
echo "─────────────────────────────────────────────────────────────"
echo " env file:    $ENV_FILE"
if [ -n "$PROFILE_NAME" ]; then
  echo " AWS profile: $PROFILE_NAME"
fi
echo " AWS region:  $REGION"
echo " chat model:  $CHAT_MODEL"
echo " embed model: $EMBED_MODEL"
echo " litellm:     $HOST  (project: $PROJECT)"
echo "─────────────────────────────────────────────────────────────"
echo

teardown() {
  echo
  echo "→ teardown"
  LITELLM_PORT=$PORT docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    --profile bedrock down -v >/dev/null 2>&1 || true
}
trap teardown EXIT

echo "→ booting one-shot litellm (real AWS creds; will incur cents of spend)"
LITELLM_PORT=$PORT docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
  --profile bedrock up -d --build litellm

echo
echo "→ waiting for litellm /health/liveliness (cold boot ~25-30s)"
ready=0
for i in $(seq 1 90); do
  if curl -fsS "$HOST/health/liveliness" >/dev/null 2>&1; then
    echo "  ready after ${i}s"
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "  litellm never came up. Last 30 lines of logs:"
  docker compose -p "$PROJECT" logs litellm | tail -30
  exit 1
fi

run_request() {
  local label="$1"
  local path="$2"
  local body="$3"
  local start_ms now_ms duration_ms
  start_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  local response
  if ! response=$(curl -fsS -X POST "$HOST$path" \
    -H "Authorization: Bearer anything" \
    -H "Content-Type: application/json" \
    -d "$body" 2>&1); then
    echo "  FAIL ($label): $response" >&2
    echo "  Last 30 lines of litellm logs:" >&2
    docker compose -p "$PROJECT" logs litellm | tail -30 >&2
    return 1
  fi
  now_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  duration_ms=$((now_ms - start_ms))
  echo "  ok in ${duration_ms}ms" >&2
  printf '%s' "$response"
  return 0
}

echo
echo "→ chat probe ($CHAT_MODEL)"
CHAT_BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'model': '$CHAT_MODEL',
  'max_tokens': 16,
  'messages': [{'role':'user','content':'Reply with one word: ok'}],
}))")
CHAT_RESPONSE=$(run_request "chat" "/chat/completions" "$CHAT_BODY") || exit 1
CHAT_TEXT=$(printf '%s' "$CHAT_RESPONSE" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  print(d["choices"][0]["message"]["content"])
except Exception as e:
  print(f"<could not parse: {e}>")
')
echo "  reply: $CHAT_TEXT"

echo
echo "→ embeddings probe ($EMBED_MODEL)"
EMBED_BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'model': '$EMBED_MODEL',
  'input': 'open brain bedrock verify probe',
}))")
EMBED_RESPONSE=$(run_request "embed" "/embeddings" "$EMBED_BODY") || exit 1
EMBED_DIM=$(printf '%s' "$EMBED_RESPONSE" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  print(len(d["data"][0]["embedding"]))
except Exception as e:
  print(f"<could not parse: {e}>")
')
echo "  embedding dim: $EMBED_DIM"

echo
echo "─────────────────────────────────────────────────────────────"
echo " OK — Bedrock access verified."
echo "   chat model:  $CHAT_MODEL"
echo "   embed model: $EMBED_MODEL  (dim=$EMBED_DIM)"
echo "─────────────────────────────────────────────────────────────"

if [ "$EMBED_DIM" != "1536" ] && [ "$EMBED_DIM" != "?" ]; then
  echo
  echo "NOTE: $EMBED_MODEL produces $EMBED_DIM-dim vectors. The default schema"
  echo "      uses vector(1536). To route embeddings through this model, run:"
  echo "          make switch-embedding-dim N=$EMBED_DIM"
fi
