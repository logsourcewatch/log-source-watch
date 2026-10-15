# Changelog

This file summarizes noteworthy product changes. Release tags remain the authoritative build references.

## 4.9.4-beta.1 — production test candidate

### Added

- optional sourcetype-level silence policies beneath an existing `index + host` Monitored Source.
- separate `lsw_feed_inventory`, `lsw_feed_lastseen` and `lsw_feed_state` KV Store collections so existing source identities require no migration.
- **Sourcetype Policies · Beta** workspace for feed discovery, enrollment, threshold changes and enable/disable controls.
- `LSW_Update_Feed_LastSeen`, `LSW_Build_Feed_State` and on-demand `LSW_SilentFeed` searches.
- sourcetype field and feed-policy actions in the administrative Audit Trail.

### Licensing behavior

- licensed capacity remains based on unique `index + host` Monitored Sources exactly as defined by `LICENSE.txt`.
- adding multiple sourcetype policies underneath the same registered base source does not consume additional licensed source capacity.

### Beta behavior

- feed policies inherit lifecycle and maintenance from their base source.
- feed policies have an independent silence threshold and last-seen value.
- the feature is intentionally beta-gated until runtime testing is complete; existing host-level monitoring remains the production baseline.

### Upgrade note

No migration of `lsw_inventory`, `lsw_lastseen` or `lsw_state` is required. New feed collections are additive.

---

## 4.9.3-rc15 — 2026-10-14

### Added

- `_internal` heartbeat-aware diagnostics for monitored hosts that produce Splunk `splunkd.log` telemetry.
- `lsw_heartbeat` KV Store collection and scheduled heartbeat refresh.
- diagnostic states for source silence with heartbeat `ALIVE`, `STALE` or no matching evidence.
- dedicated Licensing page with Community status, commercial entitlement details, capacity usage and signed license upload/renewal on standalone deployments.
- machine-readable heartbeat/diagnosis fields in Silent Sources output.
- expanded About documentation for freshness semantics, heartbeat diagnostics, risk bands, licensing and operational integration.

### Changed

- source age is explicitly based on event `_time` (`latest(_time)`), not `_indextime`.
- Overview, Management, Silent Sources and Application Health now use a consistent current-state policy derived from inventory, last-seen and heartbeat evidence.
- `LSW_SilentHost` now calculates the current SILENT list directly instead of waiting for the periodic `lsw_state` snapshot.
- `LSW_Export_SilentHost_File` recalculates current state when writing the scheduled CSV snapshot.
- heartbeat terminology is aligned to `ALIVE`, `STALE` and no evidence in user-facing views.
- Silence Risk Profile retains `Watch` and `Near threshold` as display-only early-warning bands.

### Fixed

- Silent Sources could temporarily disagree with Overview/Management after a threshold crossing because the report read the materialized `lsw_state` snapshot.
- zero-count Silence Risk Profile rows no longer render misleading minimum-width colored bars.
- Management now preserves and refreshes heartbeat evidence instead of showing a stale dash after policy changes.
- heartbeat stale-threshold macro definition corrected for Splunk macro evaluation semantics.
- Licensing REST handler registration/import path and Splunk Web exposure hardened for the current RC.

### Validation performed during RC testing

- controlled source silence with `_internal` heartbeat still `ALIVE`.
- Windows Universal Forwarder source silence while UF `_internal` telemetry remains active.
- Community entitlement with no license file.
- signed Professional entitlement upload and activation through the Licensing UI.
- current-state consistency across Overview, Management and Silent Sources.

### Upgrade note

Restart Splunk after upgrading to this RC because the app includes custom REST/Web endpoint configuration.

---

For current user documentation, see https://docs.logsourcewatch.com/.
