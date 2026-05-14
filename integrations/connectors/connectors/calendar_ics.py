"""Calendar (ICS) connector — STUB.

Polls a public or token-URL ICS feed and captures each event as a
thought. Simplest of the connectors — no auth flow, no rate limiting,
just an HTTP GET and a stdlib ICS parser.

To implement:
  1. GET $CALENDAR_ICS_URL.
  2. Parse VEVENT blocks (DTSTART, DTEND, SUMMARY, DESCRIPTION,
     LOCATION, ATTENDEE).
  3. Capture: `<summary>\n<location>\n<description>\n\nAttendees: ...`
     with metadata.event_start, metadata.attendees.
  4. State: cursor on event UID + LAST-MODIFIED.

Required env (when implemented):
  CALENDAR_ICS_URL

Optional env:
  CALENDAR_BACKFILL_DAYS   (default: 30)
"""
from __future__ import annotations

import typing as t

from ..base import Capture, Connector


class CalendarICSConnector(Connector):
    name = "calendar"
    version = "0.0.0-stub"
    required_env = ("CALENDAR_ICS_URL",)
    optional_env = ("CALENDAR_BACKFILL_DAYS",)

    def configure(self) -> bool:
        return False

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        return iter(())  # pragma: no cover
