#!/usr/bin/env python3
"""Transforming license-capacity guard used by Initial Setup.

The command preserves input rows. It exits with a search error when adding the
new sources would exceed the effective license capacity or when an SHC is
present without a license permitting SHC use.
"""
from __future__ import annotations

import json
import sys

import splunk.Intersplunk as intersplunk

from lsw_license_lib import capacity_allows, load_license


def parse_args(argv):
    out = {}
    for raw in argv[1:]:
        if "=" in raw:
            key, value = raw.split("=", 1)
            out[key.strip()] = value.strip().strip('"')
    return out


def detect_shc(settings):
    session_key = settings.get("sessionKey") or settings.get("session_key")
    if not session_key:
        return 0
    try:
        import splunk.rest as rest
        response, content = rest.simpleRequest(
            "/services/shcluster/status",
            sessionKey=session_key,
            getargs={"output_mode": "json"},
            raiseAllErrors=False,
        )
        if int(getattr(response, "status", 0) or 0) != 200:
            return 0
        text = content.decode("utf-8", "replace") if isinstance(content, bytes) else str(content)
        if "not enabled" in text.lower() or "disabled" in text.lower():
            return 0
        data = json.loads(text)
        entries = data.get("entry") or []
        if entries and any(k in (entries[0].get("content") or {}) for k in ("captain_uri", "captain_label", "service_ready_flag", "shcluster_label")):
            return 1
    except Exception:
        return 0
    return 0


def current_monitored_count(settings):
    session_key = settings.get("sessionKey") or settings.get("session_key")
    if not session_key:
        raise RuntimeError("Splunk session key is unavailable for license capacity check")
    import splunk.rest as rest
    query = json.dumps({"status": {"$in": ["active", "maintenance"]}}, separators=(",", ":"))
    response, content = rest.simpleRequest(
        "/servicesNS/nobody/logsource_watch/storage/collections/data/lsw_inventory",
        sessionKey=session_key,
        getargs={"output_mode": "json", "query": query, "count": 0},
        raiseAllErrors=False,
    )
    if int(getattr(response, "status", 0) or 0) != 200:
        raise RuntimeError("Unable to count currently monitored sources")
    text = content.decode("utf-8", "replace") if isinstance(content, bytes) else str(content)
    rows = json.loads(text)
    return len(rows) if isinstance(rows, list) else 0


args = parse_args(sys.argv)
results, _dummy, settings = intersplunk.getOrganizedResults()
settings = settings or {}
status = load_license()
if detect_shc(settings) and not int(status.get("shc_allowed", 0)):
    sys.stderr.write("Log Source Watch license: Search Head Cluster deployment requires a paid license that permits SHC use.\n")
    raise SystemExit(1)

increment_field = args.get("increment_field", "license_increment")
increment = 0
for row in results:
    try:
        increment += max(0, int(float(row.get(increment_field, 0) or 0)))
    except Exception:
        pass
current = current_monitored_count(settings)
allowed, reason, _projected = capacity_allows(status, current, increment)
if not allowed:
    sys.stderr.write("Log Source Watch license: %s\n" % reason)
    raise SystemExit(1)

intersplunk.outputResults(results)
