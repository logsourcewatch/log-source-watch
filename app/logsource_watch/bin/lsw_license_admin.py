#!/usr/bin/env python3
"""Administrative REST handler for Log Source Watch license installation.

The endpoint is intentionally narrow:
- GET returns effective license/deployment status for the authenticated admin.
- POST accepts a license JSON document, verifies it with the packaged public key,
  then atomically stores it under app/local/lsw_license.json.
- GUI installation is refused on Search Head Cluster members. SHC licenses must
  be deployed consistently through the cluster deployer.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from urllib.parse import parse_qs

# restmap handlers are loaded by splunkd, not executed as normal app scripts.
# Put this app bin directory explicitly on sys.path so sibling imports are stable
# across Splunk Python handler contexts.
APP_BIN = os.path.dirname(os.path.abspath(__file__))
if APP_BIN not in sys.path:
    sys.path.insert(0, APP_BIN)

import splunk
import splunk.rest

from lsw_license_lib import load_license

APP = "logsource_watch"
MAX_UPLOAD_BYTES = 64 * 1024


def _license_path():
    app_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(app_root, "local", "lsw_license.json")


def _decode_content(content):
    if isinstance(content, bytes):
        return content.decode("utf-8", "replace")
    return str(content or "")


def _detect_shc(session_key):
    if not session_key:
        return 0
    try:
        response, content = splunk.rest.simpleRequest(
            "/services/shcluster/status",
            sessionKey=session_key,
            getargs={"output_mode": "json"},
            raiseAllErrors=False,
        )
        if int(getattr(response, "status", 0) or 0) != 200:
            return 0
        text = _decode_content(content)
        lower = text.lower()
        if "not enabled" in lower or "disabled" in lower:
            return 0
        data = json.loads(text)
        entries = data.get("entry") or []
        if not entries:
            return 0
        c = entries[0].get("content") or {}
        return 1 if any(k in c for k in ("captain_uri", "captain_label", "service_ready_flag", "shcluster_label")) else 0
    except Exception:
        return 0


def _current_monitored_count(session_key):
    if not session_key:
        return 0
    try:
        query = json.dumps({"status": {"$in": ["active", "maintenance"]}}, separators=(",", ":"))
        response, content = splunk.rest.simpleRequest(
            "/servicesNS/nobody/%s/storage/collections/data/lsw_inventory" % APP,
            sessionKey=session_key,
            getargs={"output_mode": "json", "query": query, "count": 0},
            raiseAllErrors=False,
        )
        if int(getattr(response, "status", 0) or 0) != 200:
            return 0
        rows = json.loads(_decode_content(content))
        return len(rows) if isinstance(rows, list) else 0
    except Exception:
        return 0


def _public_status(session_key):
    status = dict(load_license())
    status.pop("license_path", None)
    shc = _detect_shc(session_key)
    monitored = _current_monitored_count(session_key)
    status["environment_shc"] = shc
    status["monitored_sources"] = monitored
    status["deployment_compliant"] = 0 if (shc and not int(status.get("shc_allowed", 0))) else 1
    if str(status.get("license_status") or "").upper() == "COMMUNITY" and not status.get("customer"):
        status["customer"] = "Community"
    maximum = int(status.get("max_monitored_sources", 0) or 0)
    status["capacity_text"] = ("%d / Unlimited" % monitored) if maximum <= 0 else ("%d / %d" % (monitored, maximum))
    return status


def _extract_license_arg(request, args):
    raw = ""
    if args:
        raw = args.get("license") or args.get("license_json") or ""
    if raw:
        return raw
    payload = ""
    try:
        payload = request.get("payload", "") if request else ""
    except Exception:
        payload = ""
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8", "replace")
    if payload:
        parsed = parse_qs(str(payload), keep_blank_values=True)
        values = parsed.get("license") or parsed.get("license_json") or []
        if values:
            return values[0]
    return ""


def _install_license(raw, session_key):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "strict")
    raw = str(raw or "").strip()
    if not raw:
        return False, "No license file content was supplied.", None
    if len(raw.encode("utf-8")) > MAX_UPLOAD_BYTES:
        return False, "License file is larger than the 64 KiB safety limit.", None
    try:
        document = json.loads(raw)
    except Exception:
        return False, "The selected file is not valid JSON.", None
    if not isinstance(document, dict):
        return False, "The license document must be a JSON object.", None

    if _detect_shc(session_key):
        return False, (
            "GUI license installation is disabled on Search Head Cluster members. "
            "Deploy lsw_license.json consistently through the SHC deployer instead."
        ), None

    target = _license_path()
    local_dir = os.path.dirname(target)
    os.makedirs(local_dir, mode=0o750, exist_ok=True)

    # Validate from a temporary file using exactly the same runtime path as normal
    # license verification. The existing active license is untouched on failure.
    fd, temp_path = tempfile.mkstemp(prefix=".lsw_license_upload_", suffix=".json", dir=local_dir, text=True)
    try:
        try:
            os.fchmod(fd, 0o600)
        except Exception:
            pass
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, sort_keys=True, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        status = load_license(temp_path)
        if str(status.get("license_status") or "").upper() != "VALID":
            return False, "License validation failed: %s" % status.get("message", "invalid license"), None

        monitored = _current_monitored_count(session_key)
        maximum = int(status.get("max_monitored_sources", 0) or 0)
        if maximum > 0 and monitored > maximum:
            return False, (
                "This license permits %d monitored sources, but the current monitored population is %d. "
                "Install an entitlement with sufficient capacity."
            ) % (maximum, monitored), None

        # Keep one rollback copy of the previous installed license. Signed license
        # documents do not contain the issuer private key.
        if os.path.isfile(target):
            previous = target + ".previous"
            shutil.copy2(target, previous)
            try:
                os.chmod(previous, 0o600)
            except Exception:
                pass

        os.replace(temp_path, target)
        temp_path = None
        try:
            os.chmod(target, 0o600)
        except Exception:
            pass
        final_status = _public_status(session_key)
        return True, "License installed successfully.", final_status
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except Exception:
                pass


class LicenseAdminHandler(splunk.rest.BaseRestHandler):
    def _write(self, payload, status=200):
        self.response.setStatus(int(status))
        self.response.setHeader("content-type", "application/json; charset=utf-8")
        self.response.write(json.dumps(payload, sort_keys=True))

    def handle_GET(self):
        try:
            self._write({"ok": True, "status": _public_status(self.sessionKey)})
        except Exception as exc:
            self._write({"ok": False, "error": "Unable to read license status: %s" % exc}, 500)

    def handle_POST(self):
        try:
            raw = _extract_license_arg(getattr(self, "request", None), getattr(self, "args", None))
            ok, message, status = _install_license(raw, self.sessionKey)
            result = {"ok": bool(ok), "message": message}
            if status is not None:
                result["status"] = status
            self._write(result)
        except Exception as exc:
            self._write({"ok": False, "error": "License installation failed: %s" % exc}, 500)
