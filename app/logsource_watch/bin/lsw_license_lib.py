#!/usr/bin/env python3
"""Log Source Watch license verification helpers.

Runtime dependency policy: Python standard library only. The app contains only the
public RSA key; the private issuer key is never packaged with Log Source Watch.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
from datetime import datetime, timezone

PRODUCT = "log-source-watch"
SCHEMA = 1
COMMUNITY_LIMIT = 100
KEY_ID = "lsw-2026-01"
PUBLIC_E = 65537
PUBLIC_N = int(
    "b68eb2f7b35e213501431e5a85d7bae2cb50f806b5fae6a1dea729d4871633d24e2c3ea8c6633831b0e4d50ccd85e3954383cbdb756fe0b0ad6a7b23d3bdbfb6a9b5fab25c6e36c47bc2bc5b0bb70fecc5e7d695f8d7ea5b0c866b1f35b0d644efc66810f5141ff7595af61ca32016714b1330d2c7589073abe7a40ececce4fdfef26e441d604b846393e33a77006789da61682ae9a750316bf8c14306eef0f70a5bfb7142cbce47015960c118b5f530858d4c7671d82189a72548ded003b39d171a36720e0da71f816243b50d934180719c3aeb39f0248789bbf91e86c8152d5f744d05d2f6c11626a5b505ddc9d7bb005c472a74731d51575b497bf97075786d52b36ca532b423a3e6ff78ab297e847af3481b886faccfc6675066308a8d60a9b348f9f44a1dbfcdb18093548063467c2edf9dea87a259b5103dcc6ecd007d87b746c88518ab93ee4e96e674f7c4881921c7907e1fde1dac18fd27d3944a705dae8c7a66760542eea0d0f606a8a78cbc38b62368df27d70dd914e2ac5cb305",
    16,
)
SIG_ALG = "RS256-PKCS1-v1_5"
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def _b64url_decode(value: str) -> bytes:
    value = str(value or "")
    value += "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value.encode("ascii"))


def canonical_payload(document: dict) -> bytes:
    payload = copy.deepcopy(document)
    payload.pop("signature", None)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def verify_signature(document: dict) -> tuple[bool, str]:
    if document.get("signature_algorithm") != SIG_ALG:
        return False, "Unsupported license signature algorithm"
    if document.get("key_id") != KEY_ID:
        return False, "License was issued by an unknown signing key"
    try:
        signature = _b64url_decode(document.get("signature", ""))
    except Exception:
        return False, "License signature is not valid base64url data"

    k = (PUBLIC_N.bit_length() + 7) // 8
    if len(signature) != k:
        return False, "License signature length is invalid"
    sig_int = int.from_bytes(signature, "big")
    if sig_int >= PUBLIC_N:
        return False, "License signature value is invalid"

    encoded = pow(sig_int, PUBLIC_E, PUBLIC_N).to_bytes(k, "big")
    digest = hashlib.sha256(canonical_payload(document)).digest()
    expected_tail = SHA256_DIGEST_INFO + digest
    padding_len = k - len(expected_tail) - 3
    if padding_len < 8:
        return False, "License signing key is too small"
    expected = b"\x00\x01" + (b"\xff" * padding_len) + b"\x00" + expected_tail
    if encoded != expected:
        return False, "License signature verification failed"
    return True, "OK"


def _parse_time(value):
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def community_status(message="Community Edition is active. Up to 100 monitored sources are included.") -> dict:
    return {
        "license_mode": "COMMUNITY",
        "license_status": "COMMUNITY",
        "license_valid": 1,
        "edition": "Community",
        "customer": "",
        "license_id": "COMMUNITY",
        "max_monitored_sources": COMMUNITY_LIMIT,
        "shc_allowed": 0,
        "multiple_search_heads_allowed": 0,
        "managed_service_allowed": 0,
        "redistribution_allowed": 0,
        "issued_at": "",
        "not_before": "",
        "expires_at": "",
        "days_remaining": "",
        "message": message,
        "license_file_present": 0,
    }


def load_license(path: str | None = None, now: datetime | None = None) -> dict:
    if path is None:
        splunk_home = os.environ.get("SPLUNK_HOME", "/opt/splunk")
        path = os.path.join(splunk_home, "etc", "apps", "logsource_watch", "local", "lsw_license.json")
    if not os.path.isfile(path):
        result = community_status()
        result["license_path"] = path
        return result

    fallback = community_status("A license file is present but invalid. Community capacity (100 monitored sources) is being enforced.")
    fallback.update({"license_mode": "INVALID", "license_status": "INVALID", "license_valid": 0, "license_file_present": 1, "license_path": path})

    try:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except Exception as exc:
        fallback["message"] = "Unable to read license file: %s" % exc
        return fallback

    ok, reason = verify_signature(document)
    if not ok:
        fallback["message"] = reason + ". Community capacity (100 monitored sources) is being enforced."
        return fallback

    if document.get("schema") != SCHEMA or document.get("product") != PRODUCT:
        fallback["message"] = "License schema/product does not match Log Source Watch. Community capacity is being enforced."
        return fallback

    edition = str(document.get("edition") or "").strip()
    if edition not in {"Professional", "Enterprise", "Enterprise Plus", "Service Provider"}:
        fallback["message"] = "Unknown paid license edition. Community capacity is being enforced."
        return fallback

    try:
        max_sources = int(document.get("max_monitored_sources", 0))
    except Exception:
        max_sources = -1
    if max_sources < 0:
        fallback["message"] = "License capacity is invalid. Community capacity is being enforced."
        return fallback

    now = now or datetime.now(timezone.utc)
    try:
        not_before = _parse_time(document.get("not_before"))
        expires_at = _parse_time(document.get("expires_at"))
    except Exception:
        fallback["message"] = "License validity timestamps are invalid. Community capacity is being enforced."
        return fallback

    if not_before and now < not_before:
        fallback["message"] = "License is not valid yet. Community capacity is being enforced until %s." % document.get("not_before")
        return fallback
    features = document.get("features") or {}
    if expires_at and now > expires_at:
        return {
            "license_mode": "EXPIRED",
            "license_status": "EXPIRED",
            "license_valid": 0,
            "edition": edition,
            "customer": str(document.get("customer") or ""),
            "license_id": str(document.get("license_id") or ""),
            "max_monitored_sources": max_sources,
            "shc_allowed": 1 if features.get("shc") else 0,
            "multiple_search_heads_allowed": 1 if features.get("multiple_production_search_heads") else 0,
            "managed_service_allowed": 1 if features.get("managed_service") else 0,
            "redistribution_allowed": 1 if features.get("redistribution") else 0,
            "issued_at": str(document.get("issued_at") or ""),
            "not_before": str(document.get("not_before") or ""),
            "expires_at": str(document.get("expires_at") or ""),
            "days_remaining": 0,
            "message": (
                "Paid %s license expired on %s. Existing registered sources continue "
                "to be monitored, but actions that increase monitored-source capacity "
                "are blocked until the license is renewed."
                % (edition, document.get("expires_at"))
            ),
            "license_file_present": 1,
            "license_path": path,
        }

    days_remaining = ""
    if expires_at:
        days_remaining = max(0, (expires_at.date() - now.date()).days)

    return {
        "license_mode": "LICENSED",
        "license_status": "VALID",
        "license_valid": 1,
        "edition": edition,
        "customer": str(document.get("customer") or ""),
        "license_id": str(document.get("license_id") or ""),
        # 0 means unlimited licensed capacity.
        "max_monitored_sources": max_sources,
        "shc_allowed": 1 if features.get("shc") else 0,
        "multiple_search_heads_allowed": 1 if features.get("multiple_production_search_heads") else 0,
        "managed_service_allowed": 1 if features.get("managed_service") else 0,
        "redistribution_allowed": 1 if features.get("redistribution") else 0,
        "issued_at": str(document.get("issued_at") or ""),
        "not_before": str(document.get("not_before") or ""),
        "expires_at": str(document.get("expires_at") or ""),
        "days_remaining": days_remaining,
        "message": "Valid %s license%s." % (edition, (" for " + str(document.get("customer"))) if document.get("customer") else ""),
        "license_file_present": 1,
        "license_path": path,
    }


def capacity_allows(status: dict, current_monitored: int, increment: int = 0) -> tuple[bool, str, int]:
    current = max(0, int(current_monitored or 0))
    increment = max(0, int(increment or 0))
    projected = current + increment
    if str(status.get("license_status") or "").upper() == "EXPIRED":
        if increment > 0:
            return False, (
                "Paid %s license has expired. Existing registered sources continue to be "
                "monitored, but new monitored-source capacity is blocked until renewal."
                % status.get("edition", "Log Source Watch")
            ), projected
        return True, "Expired license: existing monitored population preserved", projected
    maximum = int(status.get("max_monitored_sources", COMMUNITY_LIMIT) or 0)
    if maximum <= 0:
        return True, "Unlimited licensed capacity", projected
    if projected <= maximum:
        return True, "%d of %d monitored sources" % (projected, maximum), projected
    return False, (
        "License capacity exceeded: this action would result in %d monitored sources, "
        "but %s permits %d. Retired sources do not count toward capacity."
        % (projected, status.get("edition", "Community"), maximum)
    ), projected
