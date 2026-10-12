# Deployment Guide

Log Source Watch 4.9.3 is a search-tier application using Splunk search,
scheduler and KV Store capabilities.

## Standalone Search Head

Install the application under:

`$SPLUNK_HOME/etc/apps/logsource_watch`

On first launch Splunk opens **Initial Setup** because the package ships with
`is_configured = 0` and `setup_view = initial_setup`.

Environment-specific overrides belong under the app `local/` directory.
Do not edit installed `default/` files.

## Search Head Cluster

Search Head Cluster deployment requires a paid Log Source Watch Enterprise
License under the bundled license terms.

Stage the app on the SHC deployer and use standard Splunk SHC deployment
procedures. Environment-specific files belong under the deployer app
`local/` directory.

Validate KV Store replication, scheduler ownership, RBAC, search affinity and
capacity in the target cluster before production use.

## Runtime search scope

There is no environment-specific `lsw_lastseen_scope` macro requirement in
4.9.3. `LSW_Update_LastSeen` derives its distinct monitored index scope from
`lsw_inventory` and is fail-closed while inventory is empty.

## Scheduled jobs

The five recurring production jobs ship enabled and staggered across the
five-minute cycle. Use **Reports -> Application Health** to verify that they
advance normally in the target environment.

## Raw-event access

Normal dashboards and management views use KV Store-backed application data.
Indexed event data is queried when:

- Initial Setup builds the first baseline
- an operator runs Discover
- `LSW_Update_LastSeen` refreshes latest observations for registered sources
