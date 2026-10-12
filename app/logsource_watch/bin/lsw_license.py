#!/usr/bin/env python3
"""Generating search command: | lswlicense"""
from __future__ import annotations

import json

import splunk.Intersplunk as intersplunk

from lsw_license_lib import load_license


def detect_shc(settings):
    """Best-effort SHC detection. Failure to detect is reported as unknown (0)."""
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
        lower = text.lower()
        if "not enabled" in lower or "disabled" in lower:
            return 0
        data = json.loads(text)
        entries = data.get("entry") or []
        if not entries:
            return 0
        c = entries[0].get("content") or {}
        if any(k in c for k in ("captain_uri", "captain_label", "service_ready_flag", "shcluster_label")):
            return 1
    except Exception:
        return 0
    return 0


try:
    _results, _dummy, settings = intersplunk.getOrganizedResults()
    status = load_license()
    shc = detect_shc(settings or {})
    status["environment_shc"] = shc
    if shc and not int(status.get("shc_allowed", 0)):
        status["deployment_compliant"] = 0
        status["message"] = "Search Head Cluster detected. A license permitting SHC deployment is required."
    else:
        status["deployment_compliant"] = 1
    intersplunk.outputResults([status])
except Exception as exc:
    fallback = load_license()
    fallback.update({
        "license_status": "ERROR",
        "license_valid": 0,
        "deployment_compliant": 0,
        "environment_shc": 0,
        "message": "License status check failed: %s" % exc,
    })
    intersplunk.outputResults([fallback])
