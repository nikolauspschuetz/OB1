"""Entrypoint when invoked as `python -m integrations.slack_bot`."""
from .bot import main

if __name__ == "__main__":
    import sys
    sys.exit(main() or 0)
