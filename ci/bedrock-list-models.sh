#!/usr/bin/env bash
# Print the AWS account's currently-active Claude (TEXT) and embedding model
# IDs, plus the cross-region inference profile aliases. Use this when
# `make verify-bedrock` returns a "Legacy" 404 — bump ci/litellm-config.yaml
# to a model from this list.

set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not installed" >&2
  exit 1
fi

PROFILE_NAME=$(grep -E '^AWS_PROFILE=' "$ENV_FILE" | cut -d= -f2- || true)
REGION=$(grep -E '^AWS_REGION=' "$ENV_FILE" | cut -d= -f2- || true)
[ -n "$REGION" ] || REGION="us-east-1"

PROFILE_ARGS=()
if [ -n "$PROFILE_NAME" ]; then
  PROFILE_ARGS=(--profile "$PROFILE_NAME")
fi

echo "─────────────────────────────────────────────────────────────"
if [ -n "$PROFILE_NAME" ]; then
  echo " AWS profile: $PROFILE_NAME"
fi
echo " AWS region:  $REGION"
echo "─────────────────────────────────────────────────────────────"

echo
echo "=== Active Anthropic chat models (use a us.* inference profile alias) ==="
aws "${PROFILE_ARGS[@]}" --region "$REGION" bedrock list-foundation-models \
  --by-provider anthropic --by-output-modality TEXT \
  --query 'modelSummaries[?modelLifecycle.status==`ACTIVE`].[modelId, modelName]' \
  --output table

echo
echo "=== Active Anthropic + embedding inference profiles (us.*) ==="
aws "${PROFILE_ARGS[@]}" --region "$REGION" bedrock list-inference-profiles \
  --query 'inferenceProfileSummaries[?starts_with(inferenceProfileId, `us.`) && (contains(inferenceProfileId, `claude`) || contains(inferenceProfileId, `cohere`) || contains(inferenceProfileId, `titan`) || contains(inferenceProfileId, `embed`))].[inferenceProfileId, inferenceProfileName]' \
  --output table

echo
echo "=== Active embedding models (use raw model ID, no inference profile required) ==="
aws "${PROFILE_ARGS[@]}" --region "$REGION" bedrock list-foundation-models \
  --by-output-modality EMBEDDING \
  --query 'modelSummaries[?modelLifecycle.status==`ACTIVE`].[modelId, modelName]' \
  --output table

echo
echo "Update ci/litellm-config.yaml model: lines with values from above, then:"
echo "  make verify-bedrock"
