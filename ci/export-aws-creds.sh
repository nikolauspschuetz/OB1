#!/usr/bin/env bash
# Emit `KEY=VALUE` lines for AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
# AWS_SESSION_TOKEN / AWS_REGION resolved from the given env file. Used
# by `make up BACKEND=bedrock` to pass per-profile AWS credentials into
# the litellm container without bind-mounting ~/.aws.
#
# Strategy:
#   1. If AWS_PROFILE=<name> is set in the env file, shell out to
#      `aws configure export-credentials --profile <name>` to mint live
#      keys (works with static keys, SSO, and assume-role profiles).
#      Falls through to (2) if `aws` CLI is missing or the export fails.
#   2. If AWS_ACCESS_KEY_ID is already populated in the env file, just
#      echo a no-op (compose's env-file mechanism passes them through
#      directly, no re-emission needed).
#
# Usage:  ci/export-aws-creds.sh <env-file>
# Output: blank if nothing to do; otherwise lines like
#         AWS_ACCESS_KEY_ID=AKIA...
#         AWS_SECRET_ACCESS_KEY=...
#         AWS_SESSION_TOKEN=...
#         AWS_REGION=us-east-1
#
# Recipes consume the output with `export $(ci/export-aws-creds.sh ...)`
# or by sourcing the file inline. Quoting is preserved so values with
# spaces or special chars survive.
set -euo pipefail

ENV_FILE="${1:?usage: export-aws-creds.sh <env-file>}"

if [ ! -f "$ENV_FILE" ]; then
  exit 0  # nothing to export
fi

profile=$(grep -E '^AWS_PROFILE=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)
profile=${profile//[$'\n\r']/}

if [ -n "$profile" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "WARN: AWS_PROFILE=$profile but aws CLI missing — falling back to direct keys (if set)" >&2
    exit 0
  fi
  # Export the live credentials. aws CLI handles SSO refresh, assume-role,
  # static keys all the same way through this command.
  if ! aws configure export-credentials --profile "$profile" --format env-no-export 2>/dev/null; then
    echo "WARN: aws configure export-credentials failed for profile '$profile' — falling back to direct keys" >&2
    exit 0
  fi
  # Also emit region if the profile has one set and the env file leaves it blank.
  region=$(grep -E '^AWS_REGION=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)
  if [ -z "$region" ]; then
    if region=$(aws configure get region --profile "$profile" 2>/dev/null); then
      [ -n "$region" ] && echo "AWS_REGION=$region"
    fi
  fi
fi
