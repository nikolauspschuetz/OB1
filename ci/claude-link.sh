#!/usr/bin/env bash
# Drop a .claude/settings.local.json into a target directory pointing
# at the named profile's OB1 MCP server. After this, running `claude`
# inside the target dir auto-connects to that profile's brain — every
# Claude Code session gets `capture_thought`, `search_thoughts`,
# `update_thought`, `merge_entities`, and the rest of the MCP toolset.
#
# Usage:
#   ci/claude-link.sh <profile> <target-dir>
#
# Examples:
#   ci/claude-link.sh tech-screen ~/github.com/tech-screen/SaaS-Tech-Screen
#   ci/claude-link.sh personal   ~/github.com/NateBJones-Projects/OB1
#
# Existing .claude/settings.local.json files are merged (not
# overwritten) — only the mcpServers.ob1 entry is updated.
set -euo pipefail

profile="${1:?Usage: claude-link.sh <profile> <target-dir>}"
target="${2:?Usage: claude-link.sh <profile> <target-dir>}"

if [ ! -d "$target" ]; then
  echo "ERROR: target directory not found: $target" >&2
  exit 1
fi

env_file=".env"
if [ "$profile" != "default" ]; then
  env_file=".env.$profile"
fi
if [ ! -f "$env_file" ]; then
  echo "ERROR: $env_file not found in repo root" >&2
  exit 1
fi

mcp_port=$(grep -E '^MCP_PORT=' "$env_file" | tail -n1 | cut -d= -f2-)
mcp_key=$(grep -E '^MCP_ACCESS_KEY=' "$env_file" | tail -n1 | cut -d= -f2-)
mcp_port="${mcp_port:-8000}"

if [ -z "$mcp_key" ]; then
  echo "ERROR: MCP_ACCESS_KEY empty in $env_file" >&2
  exit 1
fi

claude_dir="$target/.claude"
settings="$claude_dir/settings.local.json"
mkdir -p "$claude_dir"

# Merge into an existing settings file if present; otherwise emit a
# fresh one. The merge is shallow — only the ob1 connector entry is
# touched, other mcpServers and unrelated keys are preserved.
python3 - "$settings" "$profile" "$mcp_port" "$mcp_key" <<'PYTHON'
import json
import os
import sys

settings_path, profile, port, key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

if os.path.exists(settings_path):
    with open(settings_path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except Exception:
            data = {}
else:
    data = {}

mcp = data.setdefault("mcpServers", {})
mcp["ob1"] = {
    "type": "http",
    "url": f"http://localhost:{port}/mcp?key={key}",
    "comment": f"OB1 {profile} profile — managed by ci/claude-link.sh"
}

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYTHON

echo "Linked $target → OB1 profile '$profile' (MCP on localhost:$mcp_port)"
echo "  $settings"
echo
echo "Next: cd into $target and run \`claude\`. The 'ob1' MCP server"
echo "should appear in /mcp inside Claude Code, exposing capture_thought,"
echo "search_thoughts, update_thought, merge_entities, etc."
