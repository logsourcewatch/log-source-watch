#!/usr/bin/env python3
"""Maintain one deduplicated Splunk Web bulletin-board message for LSW activity.

The command is intended for a scheduled search that passes the current count of
silent base sources and silent optional sourcetype policies. It creates one
persistent warning while at least one SILENT condition exists and removes that
warning automatically when all SILENT conditions clear.

This deliberately avoids one Splunk message per source, which would create a
message storm during a broad ingestion outage.
"""
from __future__ import annotations

import sys

import splunk.Intersplunk as intersplunk
import splunk.rest as rest

MESSAGE_NAME = "log_source_watch_activity"
MESSAGE_TEXT = (
    "New activity in Log Source Watch - one or more log sources are silent. "
    "Open Log Source Watch to review."
)


def _status(response):
    try:
        return int(getattr(response, "status", 0) or 0)
    except Exception:
        return 0


def _request(path, session_key, method="GET", postargs=None):
    response, content = rest.simpleRequest(
        path,
        sessionKey=session_key,
        method=method,
        postargs=postargs,
        getargs={"output_mode": "json"} if method == "GET" else None,
        raiseAllErrors=False,
    )
    return _status(response), content


def _as_int(value):
    try:
        return max(0, int(float(value or 0)))
    except Exception:
        return 0


results = []
try:
    results, _dummy, settings = intersplunk.getOrganizedResults()
    settings = settings or {}
    session_key = settings.get("sessionKey") or settings.get("session_key")
    if not session_key:
        raise RuntimeError("Splunk session key is unavailable for bulletin-board update")

    row = results[0] if results else {}
    silent_sources = _as_int(row.get("silent_sources"))
    silent_feeds = _as_int(row.get("silent_feeds"))
    total_silent = silent_sources + silent_feeds
    message_path = "/services/messages/" + MESSAGE_NAME

    current_status, _content = _request(message_path, session_key)
    exists = current_status == 200

    action = "none"
    if total_silent > 0 and not exists:
        post_status, _ = _request(
            "/services/messages",
            session_key,
            method="POST",
            postargs={
                "name": MESSAGE_NAME,
                "value": MESSAGE_TEXT,
                "severity": "warn",
            },
        )
        if post_status not in (200, 201):
            raise RuntimeError(
                "Unable to create Splunk message (HTTP %s)" % post_status
            )
        action = "created"
    elif total_silent > 0 and exists:
        action = "present"
    elif total_silent == 0 and exists:
        delete_status, _ = _request(message_path, session_key, method="DELETE")
        if delete_status not in (200, 201):
            raise RuntimeError(
                "Unable to clear Splunk message (HTTP %s)" % delete_status
            )
        action = "cleared"
    else:
        action = "absent"

    if not results:
        results = [{}]
    results[0]["splunk_message_action"] = action
    results[0]["splunk_message_name"] = MESSAGE_NAME
    results[0]["total_silent"] = total_silent
    intersplunk.outputResults(results)

except Exception as exc:
    if not results:
        results = [{}]
    results[0]["splunk_message_action"] = "error"
    results[0]["splunk_message_error"] = str(exc)[:512]
    intersplunk.outputResults(results)
    sys.stderr.write("Log Source Watch Splunk message update failed: %s\n" % exc)
    raise
