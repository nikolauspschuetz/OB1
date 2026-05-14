"""OB1 external-source connector framework.

Run from the repo root:

  # one-shot, all configured connectors
  python3 -m integrations.connectors --once

  # one source only
  python3 -m integrations.connectors --once --source slack

  # config readiness check (lists configured/unconfigured sources)
  python3 -m integrations.connectors doctor

  # long-running poll loop (recommended deployment shape)
  python3 -m integrations.connectors --watch

See base.py for the framework contract and connectors/slack.py for
the canonical full implementation. Stubs in connectors/{gmail,linear,
calendar,figma,notion,github_backfill}.py show the pattern.
"""
