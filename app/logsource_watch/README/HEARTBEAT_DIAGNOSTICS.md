# Heartbeat-aware silence diagnosis

Log Source Watch 4.9.3 adds optional correlation with Splunk `_internal` telemetry.

## Purpose

A monitored source can become silent for different reasons. The source application or log file may have stopped producing events while the Splunk forwarder is still healthy, or the forwarder/host path itself may have disappeared.

LSW keeps the existing canonical states (`OK`, `SILENT`, `NO LOG OBSERVATION`, `MAINTENANCE`, `RETIRED`) and adds a separate diagnostic dimension.

## Data source

`LSW_Update_Heartbeat` runs every five minutes and searches:

```spl
index=_internal sourcetype=splunkd
```

Only host names currently present in active or maintenance inventory are requested. The latest matching timestamp is written to the `lsw_heartbeat` KV Store.

Default heartbeat freshness is 900 seconds (15 minutes), controlled by the `lsw_heartbeat_stale_seconds` macro.

## Interpretation

| Source state | Heartbeat | Meaning |
| --- | --- | --- |
| OK | any | Expected source is reporting. |
| SILENT | ALIVE | Source stream is silent while recent Splunk internal activity still exists for the host. Investigate log production/input/parsing/routing first. |
| SILENT | STALE | Source stream and Splunk internal activity are both stale. Investigate forwarder/service/host/connectivity first. |
| SILENT | UNKNOWN | No matching `_internal` evidence is available. Do not infer host failure. |
| NO LOG OBSERVATION | ALIVE | Registered source has no source observation, but Splunk internal activity exists for the host. |
| NO LOG OBSERVATION | STALE | Registered source has no source observation and the last internal activity is stale. |

## Important limitations

- `_internal` correlation is diagnostic evidence, not a new lifecycle state.
- Agentless syslog, HEC, API and similar sources may legitimately have no matching heartbeat.
- Host-name matching is exact and follows the host identity available in Splunk. If unrelated systems reuse the same host value, correlation can be ambiguous.
- A current `_internal` event proves recent Splunk internal activity for the host value. It does not prove that a specific file input, sourcetype or application is healthy.
- A quiet `audit.log` or `/var/log/secure` can be legitimate. Configure source silence thresholds according to expected source behaviour rather than assuming every production log must be continuous.

## Operational workflow

1. Source becomes `SILENT` according to its own threshold.
2. LSW shows `_internal` as ACTIVE, STALE or NO EVIDENCE.
3. If ACTIVE, investigate the specific input/log generation/routing path first.
4. If STALE, investigate the Splunk forwarder/service/host/network path first.
5. If NO EVIDENCE, treat the heartbeat as unavailable and investigate according to the source type.


## Validating heartbeat data

Do not create synthetic events in `_internal`. Splunk and Universal Forwarder
instances generate their own `splunkd` internal telemetry. Validate available
heartbeat candidates with a search such as:

```spl
index=_internal sourcetype=splunkd source=*splunkd.log
| stats latest(_time) AS last_internal BY host
| eval last_internal=strftime(last_internal,"%Y-%m-%d %H:%M:%S")
| sort host
```

Heartbeat correlation requires the `host` value in `_internal` to exactly match
the `host` value registered in Log Source Watch. Demo/synthetic hosts therefore
normally show `No evidence` unless matching Splunk internal telemetry genuinely
exists for those host values.
