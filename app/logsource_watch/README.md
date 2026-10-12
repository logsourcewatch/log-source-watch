# Log Source Watch 4.9.3

Log Source Watch (LSW) is a Splunk Enterprise application for monitoring expected log continuity and managing the lifecycle of registered log sources.

A source is identified as a unique `index + host` pair. LSW tracks the latest observed event timestamp, applies a per-source silence threshold, and maintains a canonical operational state in KV Store.


## Requirements and support

- **Platform:** Splunk Enterprise with KV Store available.
- **Setup permissions:** `admin` or `sc_admin` for Initial Setup and management workflows.
- **Dependencies:** no third-party Python packages or external services are required by the Splunk app.
- **Developer:** Jonni Nieminen.
- **Community support / issues:** `https://github.com/nieminej/log-source-watch/issues`.
- **Commercial licensing:** `https://logsourcewatch.com/` once the commercial site is published.

Custom search commands are packaged under `bin/` and may require a Splunk restart after installation or upgrade before their new `commands.conf` definitions are available.

## User experience

The top navigation is intentionally compact:

- **Log Source Watch** — modern operational overview and attention queue
- **Management** — one workspace with Sources, Bulk Actions, Discover and Initial Setup
- **Reports** — Silent Sources, Application Health and Audit Trail
- **About** — complete technical reference and licensing summary

## Management

The interactive Management workspace supports:

- per-source lifecycle: active / retired
- whole-minute silence thresholds from 1 to 10080 minutes
- timed maintenance or maintenance until manually cleared
- bulk policy changes with a hard 10,000-source safety limit
- operator-driven source discovery
- direct KV Store enrollment and immediate state materialization
- audit records for enrollment, threshold, maintenance and lifecycle changes

Management and Bulk Actions use the authenticated Splunk application service to read and write the app KV Store. Successful changes update the UI without a full page reload.

## KV Store model

- `lsw_inventory` — registered `index + host` identities and policy
- `lsw_lastseen` — latest observed event timestamp
- `lsw_state` — materialized canonical operational state
- `lsw_audit` — administrative audit events
- `lsw_health` — reserved/persisted health integration state

The immutable source key is `sha256(index."|".host)`.

State precedence:

1. RETIRED
2. MAINTENANCE
3. NO LOG OBSERVATION
4. SILENT
5. OK

## First run

The package ships with:

- `is_configured = 0`
- `setup_view = initial_setup`

Initial Setup verifies KV Store availability, discovers the first source scope, seeds `lsw_lastseen`, builds `lsw_state`, verifies row counts and marks the app configured.

Recurring jobs are enabled and staggered over the five-minute cycle. Before inventory exists, last-seen collection remains fail-closed.

## Reports

Human-facing reports are dark, read-only views:

- **Silent Sources**
- **Application Health**
- **Audit Trail**

Backend compatibility searches and CSV exports remain available for integrations.

## Configuration

Source-controlled application defaults belong under:

`app/logsource_watch/default/`

Environment-specific overrides belong under:

`$SPLUNK_HOME/etc/apps/logsource_watch/local/`

or the corresponding Search Head Cluster deployer app `local/` directory.

## Licensing

**Community:** free of charge for personal, internal and commercial use for the licensee's own operations with up to **100 Monitored Sources** (unique `index + host` pairs whose lifecycle status is `active` or `maintenance`). `retired` sources do not count toward capacity.

**Paid license:** required for more than 100 Monitored Sources, Search Head Cluster deployments, multiple production search heads, MSP/MSSP or other managed/hosted service use, redistribution, resale or bundling. Paid editions may include Professional, Enterprise, Enterprise Plus and Service Provider entitlements.

`LICENSE.txt` is authoritative.

## Documentation

The in-app **About** page is the primary technical reference. It documents the KV Store fields, state algorithm, discovery SPL, management write paths, lifecycle semantics, scheduled searches, setup behavior, reporting and licensing.

Additional deployment and security notes are bundled under `README/`.


See `README/LICENSING.md` for license-file installation and capacity behavior.
