#!/usr/bin/env bash
# Emit "name=url,name=url" for every sibling profile (excluding the
# active one). Used by `make up` to populate OB1_PEER_PROFILES so the
# dashboard nav can render a Slack-style profile switcher.
#
# Usage:
#   ci/peer-profiles.sh <active-profile> [<base-domain>] [<gateway-mode>]
#
# Examples:
#   peer-profiles.sh personal
#     → "linguado=http://localhost:3012,tech-screen=http://localhost:3011"
#
#   peer-profiles.sh personal ob1.localhost 1
#     → "linguado=http://linguado.ob1.localhost:3000,tech-screen=http://tech-screen.ob1.localhost:3000"
#
# When the third arg ("gateway-mode") is non-empty, URLs use the
# subdomain shape <profile>.<base-domain> and read GATEWAY_PORT from
# the environment (defaulting to 3000). Otherwise URLs use the
# per-profile DASHBOARD_PORT from each profile's env file.
#
# Profiles without a DASHBOARD_PORT are skipped in port mode.
# Profiles are NOT skipped in gateway mode (they may not be running
# yet, but Traefik will route once they come up).
set -euo pipefail

active="${1:-default}"
base_domain="${2:-ob1.localhost}"
gateway_mode="${3:-}"
gateway_port="${GATEWAY_PORT:-3000}"

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
  if [ -n "$gateway_mode" ]; then
    # In gateway mode, the URL is the subdomain — no per-profile port.
    out+="${name}=http://${name}.${base_domain}:${gateway_port},"
  else
    port=$(grep -E '^DASHBOARD_PORT=' "$f" | tail -n1 | cut -d= -f2-)
    [ -n "$port" ] || continue
    out+="${name}=http://localhost:${port},"
  fi
done
printf '%s' "${out%,}"
