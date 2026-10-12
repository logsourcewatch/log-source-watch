# Management Workspace

Log Source Watch 4.9.3 uses one interactive Management workspace for source
administration.

Top-level navigation opens **Management** directly. Internal tabs provide:

- Sources
- Bulk Actions
- Discover
- Initial Setup

## Sources

Sources reads `lsw_inventory` and `lsw_lastseen` through the authenticated
Splunk application service. The browser derives current display state for
immediate interaction while `lsw_state` remains the canonical materialized
reporting table.

Supported actions:

- Active / Retired lifecycle
- whole-minute threshold from 1 to 10080 minutes
- timed maintenance
- maintenance until manually cleared
- immediate audit history
- visible-page multi-selection

A successful policy change writes inventory, canonical state and audit without
requiring a full page reload.

## Bulk Actions

Bulk Actions uses the same KV Store data plane. The exact filtered scope is
reviewed before execution. A hard 10,000-source limit is enforced.

Supported bulk actions:

- threshold
- maintenance
- end maintenance
- activate
- retire

## Discover

Discover is operator-driven. Opening the page does not dispatch a broad indexed
event search.

The read path uses `tstats` against the explicitly selected index and lookback
window. Existing `_key` values are removed by comparing against
`lsw_inventory`.

Enrollment writes directly to:

1. `lsw_inventory`
2. `lsw_lastseen`
3. `lsw_state`
4. `lsw_audit`

Enrollment is capped at 10,000 sources.

## Scale

The normal Management and Bulk pages use application KV Store rather than
broad indexed searches. Raw indexed data is used only for explicit discovery,
initial setup and scheduled last-seen collection.
