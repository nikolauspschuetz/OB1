"""CLI entrypoint for the connector framework. Invoke as

    python3 -m integrations.connectors [args]

from the OB1 repo root, or as

    python3 -m connectors [args]

from inside the importer Docker image where PYTHONPATH=/app.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import pathlib
import sys
import time

from .base import Connector, OB1Client
from .connectors.slack import SlackConnector
from .connectors.gmail import GmailConnector
from .connectors.github_backfill import GitHubBackfillConnector
from .connectors.linear import LinearConnector
from .connectors.calendar_ics import CalendarICSConnector
from .connectors.figma import FigmaConnector
from .connectors.notion import NotionConnector


# Order matters only for `doctor` output legibility. Each connector
# is independent at runtime; the framework dispatches them serially
# in `run_once` but they share no state.
REGISTRY: list[type[Connector]] = [
    SlackConnector,
    GmailConnector,
    GitHubBackfillConnector,
    LinearConnector,
    CalendarICSConnector,
    FigmaConnector,
    NotionConnector,
]


def default_state_dir() -> pathlib.Path:
    # Inside Docker, prefer the bind-mounted /var/state. Otherwise use
    # XDG_CACHE_HOME or ~/.cache/ob1.
    if pathlib.Path("/var/state").is_dir() and os.access("/var/state", os.W_OK):
        return pathlib.Path("/var/state")
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = pathlib.Path(xdg) if xdg else pathlib.Path.home() / ".cache"
    profile = os.environ.get("OB1_PROFILE", "default")
    return base / "ob1" / "connectors" / profile


def build_runners(env: dict[str, str], state_dir: pathlib.Path) -> list[Connector]:
    ob1 = OB1Client(
        base_url=env.get("OB1_URL", "http://localhost:8000"),
        access_key=env.get("OB1_KEY", ""),
        logger=logging.getLogger("ob1"),
    )
    out: list[Connector] = []
    for cls in REGISTRY:
        c = cls(ob1=ob1, state_dir=state_dir, env=env)
        out.append(c)
    return out


def cmd_doctor(connectors: list[Connector]) -> int:
    """Print per-connector config readiness."""
    print(f"{'Connector':<20} {'Version':<14} {'Required env':<60} {'Status'}")
    print("-" * 110)
    any_ready = False
    for c in connectors:
        info = c.doctor()
        req_summary = ", ".join(
            f"{k}={'set' if v else 'EMPTY'}" for k, v in info["required_env"].items()
        ) or "(none)"
        status = "ready" if info["configured"] else "not configured"
        print(f"{c.name:<20} {c.version:<14} {req_summary:<60} {status}")
        any_ready = any_ready or info["configured"]
    if not any_ready:
        print()
        print("No connectors configured. Set credentials in .env.<profile> then re-run.")
    return 0


def cmd_run(connectors: list[Connector], only: str | None, log: logging.Logger) -> int:
    total_cap = 0
    total_err = 0
    for c in connectors:
        if only and c.name != only:
            continue
        result = c.run_once()
        if result.fetched or result.captured or result.errors:
            log.info(
                "[%s] fetched=%d captured=%d skipped=%d errors=%d dur=%dms",
                result.connector,
                result.fetched,
                result.captured,
                result.skipped,
                result.errors,
                result.duration_ms,
            )
        total_cap += result.captured
        total_err += result.errors
    log.info("done. captured=%d errors=%d", total_cap, total_err)
    return 1 if total_err and total_cap == 0 else 0


def cmd_watch(connectors: list[Connector], only: str | None, log: logging.Logger) -> int:
    log.info("watch mode — polling configured connectors")
    while True:
        try:
            cmd_run(connectors, only, log)
        except KeyboardInterrupt:
            log.info("interrupted")
            return 0
        except Exception as e:
            log.exception("iteration error: %s", e)
        # Sleep for the shortest configured poll interval among active
        # connectors. Each connector internally tracks its own state
        # so we can run them all on the same schedule.
        configured = [c for c in connectors if (not only or c.name == only) and c.doctor()["configured"]]
        if not configured:
            sleep_s = 300
        else:
            sleep_s = min(c.poll_seconds() for c in configured)
        log.info("sleeping %ds", sleep_s)
        time.sleep(sleep_s)


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="connectors",
        description="OB1 external-source connector framework",
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("doctor", help="print config readiness for every registered connector")
    parser.add_argument("--once", action="store_true", help="run once and exit (default)")
    parser.add_argument("--watch", action="store_true", help="run forever, polling each connector's interval")
    parser.add_argument(
        "--source", default=None,
        help="run only the named connector (slack, gmail, github_backfill, …)",
    )
    parser.add_argument(
        "--state-dir", default=None,
        help="override state dir. Default: /var/state in Docker or ~/.cache/ob1/connectors/<profile> on host",
    )
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    log = logging.getLogger("runner")

    env = dict(os.environ)
    state_dir = pathlib.Path(args.state_dir) if args.state_dir else default_state_dir()
    log.info("state dir: %s", state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    connectors = build_runners(env, state_dir)

    if args.cmd == "doctor":
        return cmd_doctor(connectors)
    if args.watch:
        return cmd_watch(connectors, args.source, log)
    return cmd_run(connectors, args.source, log)


if __name__ == "__main__":
    sys.exit(main())
