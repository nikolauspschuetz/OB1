"""Calendar (ICS) connector.

Downloads an ICS feed and captures each event as a thought. Simplest
of the connectors — no auth flow beyond the secret URL, no rate
limiting, just an HTTP GET and a stdlib ICS parser.

Required env:
  CALENDAR_ICS_URL          Public or token-URL ICS feed. For Google
                            Calendar: Settings → "Secret address in
                            iCal format". For Apple iCloud: Calendar
                            sharing → Public Calendar URL.

Optional env:
  CALENDAR_BACKFILL_DAYS    Only emit events with DTSTART within the
                            last/next N days (default 30 back, 60
                            forward). Calendars often have unlimited
                            recurring events — without this we'd
                            capture decades of repeats.
  CALENDAR_FORWARD_DAYS     Default 60.
  CALENDAR_POLL_SECONDS     Default 3600 (1h). Calendars change slowly.

State shape:
  { "events_seen": { "<uid>": "<last-modified>" } }

We dedup via the (uid, last_modified) pair. Note that OB1's content
fingerprint provides a second layer of dedup, so even if state is
lost the brain doesn't grow duplicates.
"""
from __future__ import annotations

import datetime as _dt
import typing as t

from ..base import Capture, Connector, HttpError, http_request


class CalendarICSConnector(Connector):
    name = "calendar"
    version = "0.1.0"
    required_env = ("CALENDAR_ICS_URL",)
    optional_env = (
        "CALENDAR_BACKFILL_DAYS",
        "CALENDAR_FORWARD_DAYS",
        "CALENDAR_POLL_SECONDS",
    )

    def configure(self) -> bool:
        self.ics_url = self.env.get("CALENDAR_ICS_URL", "").strip()
        if not self.ics_url:
            return False
        self.backfill_days = int(self.env.get("CALENDAR_BACKFILL_DAYS", "30"))
        self.forward_days = int(self.env.get("CALENDAR_FORWARD_DAYS", "60"))
        return True

    def poll_seconds(self) -> int:
        return int(self.env.get("CALENDAR_POLL_SECONDS", "3600"))

    def _parse_ics(self, body: str) -> t.Iterator[dict]:
        """Minimal RFC 5545 VEVENT parser — enough for Google /
        iCloud / Outlook exports. Handles RFC 5545 line unfolding
        (continuation lines start with whitespace) and the few
        property params we care about.

        Yields dicts with normalized keys: uid, summary, description,
        location, dtstart, dtend, attendees (list), organizer,
        last_modified.
        """
        # Unfold lines: per RFC 5545 §3.1, lines starting with " " or
        # "\t" continue the previous line.
        unfolded: list[str] = []
        for raw in body.splitlines():
            if (raw.startswith(" ") or raw.startswith("\t")) and unfolded:
                unfolded[-1] += raw[1:]
            else:
                unfolded.append(raw)

        event: dict[str, t.Any] | None = None
        for line in unfolded:
            if line == "BEGIN:VEVENT":
                event = {"attendees": []}
                continue
            if line == "END:VEVENT":
                if event:
                    yield event
                event = None
                continue
            if event is None:
                continue
            # Property line: "NAME;PARAM=val:VALUE"
            if ":" not in line:
                continue
            name_part, _, value = line.partition(":")
            # Strip parameters; keep just the bare property name.
            name = name_part.split(";", 1)[0].upper()
            # Decode escaped chars per RFC 5545 §3.3.11.
            value = (
                value.replace("\\n", "\n").replace("\\N", "\n")
                     .replace("\\,", ",").replace("\\;", ";")
                     .replace("\\\\", "\\")
            )
            if name == "UID":
                event["uid"] = value
            elif name == "SUMMARY":
                event["summary"] = value
            elif name == "DESCRIPTION":
                event["description"] = value
            elif name == "LOCATION":
                event["location"] = value
            elif name == "DTSTART":
                event["dtstart"] = value
            elif name == "DTEND":
                event["dtend"] = value
            elif name == "ORGANIZER":
                # CN parameter holds the human name; the value itself
                # is a mailto: URI.
                cn = None
                for p in name_part.split(";")[1:]:
                    if p.upper().startswith("CN="):
                        cn = p[3:]
                event["organizer"] = cn or value.replace("mailto:", "")
            elif name == "ATTENDEE":
                cn = None
                for p in name_part.split(";")[1:]:
                    if p.upper().startswith("CN="):
                        cn = p[3:]
                event["attendees"].append(cn or value.replace("mailto:", ""))
            elif name == "LAST-MODIFIED":
                event["last_modified"] = value
            elif name == "STATUS":
                event["status"] = value

    @staticmethod
    def _normalize_dt(value: str) -> str | None:
        """ICS DTSTART can be `20260514T120000Z` or `20260514T120000`
        or `20260514` (all-day). Return ISO 8601 if parseable."""
        if not value:
            return None
        v = value
        try:
            if "T" in v:
                # Strip trailing Z for fromisoformat.
                clean = v.rstrip("Z")
                # Re-format YYYYMMDDTHHMMSS → YYYY-MM-DDTHH:MM:SS.
                dt = _dt.datetime.strptime(clean, "%Y%m%dT%H%M%S")
                return dt.replace(tzinfo=_dt.timezone.utc if v.endswith("Z") else None).isoformat()
            return _dt.datetime.strptime(v, "%Y%m%d").date().isoformat()
        except ValueError:
            return v

    def _capture(self, event: dict) -> Capture | None:
        uid = event.get("uid")
        summary = event.get("summary") or "(no title)"
        if not uid:
            return None
        dtstart = self._normalize_dt(event.get("dtstart", ""))
        dtend = self._normalize_dt(event.get("dtend", ""))
        location = event.get("location") or ""
        description = (event.get("description") or "").strip()
        attendees = event.get("attendees") or []
        organizer = event.get("organizer") or ""

        content_lines = [f"Calendar event: {summary}"]
        if dtstart:
            content_lines.append(f"When: {dtstart}{' → ' + dtend if dtend else ''}")
        if location:
            content_lines.append(f"Where: {location}")
        if organizer:
            content_lines.append(f"Organizer: {organizer}")
        if attendees:
            content_lines.append(f"Attendees: {', '.join(attendees[:20])}")
        if description:
            content_lines.extend(["", description])

        return Capture(
            content="\n".join(content_lines),
            metadata={
                "source_id": f"calendar/{uid}",
                "source_kind": "calendar_event",
                "source_event_uid": uid,
                "source_event_summary": summary,
                "source_event_start": dtstart,
                "source_event_end": dtend,
                "source_event_location": location,
                "source_organizer": organizer,
                "source_attendees": attendees,
                "source_event_status": event.get("status"),
                "source_event_last_modified": event.get("last_modified"),
            },
            source_id=uid,
        )

    def fetch_new(self, state: dict[str, t.Any]) -> t.Iterator[Capture]:
        seen = state.setdefault("events_seen", {})

        try:
            _status, _hdrs, body = http_request(self.ics_url, timeout=60)
        except HttpError as e:
            self.log.warning("ICS fetch failed: %s", e)
            return

        text = body.decode("utf-8", errors="replace")
        now = _dt.datetime.now(_dt.timezone.utc)
        oldest = now - _dt.timedelta(days=self.backfill_days)
        latest = now + _dt.timedelta(days=self.forward_days)
        n = 0

        for event in self._parse_ics(text):
            uid = event.get("uid")
            if not uid:
                continue
            last_mod = event.get("last_modified", "")
            if seen.get(uid) == last_mod and last_mod:
                # No change since last seen — skip.
                continue
            # Filter by event start within [oldest, latest] window.
            dtstart_raw = event.get("dtstart", "")
            try:
                ev_dt = _dt.datetime.strptime(dtstart_raw.rstrip("Z"), "%Y%m%dT%H%M%S")
                ev_dt = ev_dt.replace(tzinfo=_dt.timezone.utc)
            except ValueError:
                try:
                    ev_dt = _dt.datetime.strptime(dtstart_raw, "%Y%m%d")
                    ev_dt = ev_dt.replace(tzinfo=_dt.timezone.utc)
                except ValueError:
                    ev_dt = None
            if ev_dt and (ev_dt < oldest or ev_dt > latest):
                continue

            cap = self._capture(event)
            if cap:
                yield cap
                seen[uid] = last_mod
                n += 1

        if n:
            self.log.info("calendar: %d event(s) captured", n)
