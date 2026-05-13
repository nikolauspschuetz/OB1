#!/usr/bin/env bash
# Emit "name=url,name=url" for every sibling profile (excluding the
# active one) whose env file declares a DASHBOARD_PORT. Used by
# `make up` to populate OB1_PEER_PROFILES so the dashboard nav can
# render a profile switcher.
#
# Usage:  ci/peer-profiles.sh <active-profile-label>
# Example: ci/peer-profiles.sh personal
#         → "linguado=http://localhost:3012,tech-screen=http://localhost:3011"
#
# Outputs the empty string when no peers are configured.
set -euo pipefail

active="${1:-default}"
out=""
for f in $(ls .env .env.* 2>/dev/null | sort -u); do
  [ -f "$f" ] || continue
  case "$f" in
    .env)
      name="default"
      ;;
    .env.example|.env.smoke|.env.smoke-*)
      continue
      ;;
    *)
      name="${f#.env.}"
      ;;
  esac
  [ "$name" = "$active" ] && continue
  port=$(grep -E '^DASHBOARD_PORT=' "$f" | tail -n1 | cut -d= -f2-)
  [ -n "$port" ] || continue
  out+="${name}=http://localhost:${port},"
done
printf '%s' "${out%,}"
