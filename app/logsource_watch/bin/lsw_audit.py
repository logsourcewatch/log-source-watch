#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone

import splunk.Intersplunk as intersplunk

ALLOWED_ACTIONS = {
    "source_update",
    "source_enrolled",
    "threshold_change",
    "maintenance_start",
    "activate",
    "retire",
    "bulk_threshold_change",
    "bulk_maintenance_start",
    "bulk_activate",
    "bulk_retire",
}
ALLOWED_SOURCES = {
    "add_log_sources",
    "manage_hosts",
    "bulk_management",
}
SAFE_VALUE = re.compile(r"[\x00-\x1f\x7f]")
MAX_RECORDS = 10000

def sanitize(value, limit=512):
    value = "" if value is None else str(value)
    value = SAFE_VALUE.sub(" ", value)
    return value[:limit]

def parse_args(argv):
    result = {}
    for arg in argv[1:]:
        if "=" not in arg:
            continue
        key, value = arg.split("=", 1)
        result[sanitize(key, 64)] = sanitize(value.strip('"'), 512)
    return result

def audit_path():
    # Fixed path below SPLUNK_HOME. No caller-controlled file path is accepted.
    splunk_home = os.environ.get("SPLUNK_HOME", "/opt/splunk")
    return os.path.join(splunk_home, "var", "log", "splunk", "log_source_watch.log")

def append_event(event):
    path = audit_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"

    # O_APPEND prevents accidental truncation. Mode is restrictive on first create.
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
    try:
        with os.fdopen(fd, "a", encoding="utf-8", buffering=1) as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise

results = []
try:
    results, _, settings = intersplunk.getOrganizedResults()
    if len(results) > MAX_RECORDS:
        raise ValueError(f"Audit command row limit exceeded: {len(results)} > {MAX_RECORDS}")
    args = parse_args(sys.argv)

    action = args.get("action", "")
    source_view = args.get("source", "")
    detail = args.get("detail", "")

    if action not in ALLOWED_ACTIONS:
        raise ValueError("Unsupported audit action")
    if source_view not in ALLOWED_SOURCES:
        raise ValueError("Unsupported audit source")

    user = sanitize(
        settings.get("owner")
        or settings.get("username")
        or settings.get("user")
        or "unknown",
        128,
    )
    sid = sanitize(settings.get("sid") or "unknown", 256)

    for record in results:
        append_event({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "event": "configuration_change",
            "user": user,
            "action": action,
            "source_view": source_view,
            "index": sanitize(record.get("index", ""), 256),
            "host": sanitize(record.get("host", ""), 512),
            "detail": detail,
            "change_ref": sanitize(record.get("change_ref", ""), 256),
            "search_sid": sid,
        })

    intersplunk.outputResults(results)

except Exception as exc:
    try:
        append_event({
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "event": "audit_error",
            "error": sanitize(exc, 512),
        })
    except Exception:
        pass
    intersplunk.outputResults(results)
