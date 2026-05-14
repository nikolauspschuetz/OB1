#!/usr/bin/env python3
"""
Slack app bootstrapper — uses an App Configuration Token (xoxe-...) to
programmatically create the Open Brain Slack app in your workspace via
apps.manifest.create. After it succeeds, the script prints the
workspace-specific install URL — you still have to click through the
browser to grant scopes (Slack doesn't let bot apps self-install).

Usage:
    SLACK_CONFIG_TOKEN=xoxe-... \\
    python3 integrations/connectors/oauth/slack_init.py [--app-name "Open Brain"]

The Configuration Token comes from slack.com/apps → "Your App
Configuration Tokens" → Generate Token. It expires in 12 hours by
default — only needs to live long enough to create the app.

After app creation:
  1. Open the printed install URL in a browser
  2. Click "Allow" to grant the scopes
  3. Land on OAuth & Permissions and copy the "Bot User OAuth Token"
     (starts with xoxb-)
  4. Paste it into the active profile's .env file as SLACK_BOT_TOKEN
  5. Invite the bot to each desired channel with /invite @OpenBrain
  6. IMPORTERS=1 make up PROFILE=<profile>

Why we need this helper at all: Slack's UI lets you do steps 1-4 in
five minutes too. The helper just saves you from clicking "From a
manifest" / pasting JSON / clicking "Create".
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


MANIFEST_PATH = (
    pathlib.Path(__file__).resolve().parent.parent / "connectors" / "slack-manifest.json"
)


def http_post_form(url: str, token: str, data: dict[str, str]) -> dict:
    body = "&".join(
        f"{k}={urllib.request.quote(v)}" for k, v in data.items()
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap the OB1 Slack app")
    parser.add_argument(
        "--app-name",
        default=None,
        help="Override the app name (default: from manifest). Useful if 'Open Brain' is already taken.",
    )
    parser.add_argument(
        "--manifest",
        default=str(MANIFEST_PATH),
        help=f"Path to the manifest JSON (default: {MANIFEST_PATH})",
    )
    args = parser.parse_args()

    token = os.environ.get("SLACK_CONFIG_TOKEN", "").strip()
    if not token:
        print("ERROR: SLACK_CONFIG_TOKEN env var not set.", file=sys.stderr)
        print("Get one from slack.com/apps → 'Your App Configuration Tokens' → Generate.", file=sys.stderr)
        return 2
    if not token.startswith("xoxe-"):
        print(f"WARNING: Configuration tokens normally start with 'xoxe-'. Got '{token[:6]}…'.", file=sys.stderr)

    manifest_path = pathlib.Path(args.manifest)
    if not manifest_path.exists():
        print(f"ERROR: manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text())
    if args.app_name:
        manifest.setdefault("display_information", {})["name"] = args.app_name
        manifest.setdefault("features", {}).setdefault("bot_user", {})["display_name"] = args.app_name

    print(f"→ creating Slack app via apps.manifest.create")
    result = http_post_form(
        "https://slack.com/api/apps.manifest.create",
        token,
        {"manifest": json.dumps(manifest)},
    )
    if not result.get("ok"):
        print(f"FAIL: {result.get('error', 'unknown_error')}", file=sys.stderr)
        if "errors" in result:
            for err in result["errors"]:
                print(f"  - {err}", file=sys.stderr)
        return 1

    app_id = result.get("app_id")
    credentials = result.get("credentials", {})
    oauth_authorize_url = result.get("oauth_authorize_url")

    print()
    print("✓ App created.")
    print(f"  app_id:    {app_id}")
    print(f"  client_id: {credentials.get('client_id')}")
    print()
    print("Next step: open this URL in a browser, grant scopes, copy the Bot User OAuth Token:")
    print()
    print(f"  {oauth_authorize_url}")
    print()
    print("After install, the Bot User OAuth Token (xoxb-...) lives at:")
    print(f"  https://api.slack.com/apps/{app_id}/oauth")
    print()
    print("Paste it into .env.<profile> as:")
    print("  SLACK_BOT_TOKEN=xoxb-...")
    print("  SLACK_ALLOWED_CHANNELS=eng-general,…   # optional, leave blank for all channels the bot is in")
    print("  SLACK_BACKFILL_DAYS=14                  # how far back the first run scans")
    print()
    print("Then invite the bot to each channel with `/invite @OpenBrain` and run:")
    print("  IMPORTERS=1 DASHBOARD=1 WORKER=1 make up PROFILE=<profile>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
