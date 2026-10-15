# Optional Sourcetype Policies (Beta)

Log Source Watch 4.9.4 introduces an optional beta policy layer for monitoring a specific Splunk `sourcetype` underneath an already registered `index + host` Monitored Source.

## Why this exists

Host-level monitoring answers whether a registered `index + host` source is producing any telemetry. A host can still appear healthy while one security-relevant feed on that host stops. Optional sourcetype policies add a narrower check without changing the base-source lifecycle model.

Example:

```text
index=windows host=dc01
  base source                 OK
  WinEventLog:Security        OK
  WinEventLog:System          OK
  XmlWinEventLog:Sysmon       SILENT
```

## Capacity and licensing

Licensed capacity is unchanged. A **Monitored Source** remains one unique `index + host` pair as defined by `LICENSE.txt`.

A sourcetype policy can only be created underneath an already registered base source and does **not** consume an additional Monitored Source slot.

## Data model

Base-source collections remain unchanged and authoritative:

- `lsw_inventory`
- `lsw_lastseen`
- `lsw_state`

The beta feed-policy layer uses separate collections:

- `lsw_feed_inventory`
- `lsw_feed_lastseen`
- `lsw_feed_state`

This separation avoids changing existing `_key = sha256(index + "|" + host)` identities or migrating existing installations.

Feed-policy keys use:

```text
sha256(index + "|" + host + "|" + sourcetype)
```

## Lifecycle behavior

A sourcetype policy has its own silence threshold but inherits lifecycle and maintenance from its base source:

- base `RETIRED` -> feed `RETIRED`
- base active maintenance -> feed `MAINTENANCE`
- no feed observation -> `NO LOG OBSERVATION`
- feed age above threshold -> `SILENT`
- otherwise -> `OK`

If the base source is missing, the feed state becomes `BASE SOURCE MISSING` and is treated as requiring attention.

## Discovery

Open **Sourcetype Policies · Beta** from the application navigation.

1. Select an already registered base `index + host` source.
2. Select a discovery lookback.
3. Set the feed-specific silence threshold.
4. Discover observed sourcetypes.
5. Add only the feeds that should be independently monitored.

## Scheduled searches

The beta layer adds:

- `LSW_Update_Feed_LastSeen`
- `LSW_Build_Feed_State`
- `LSW_SilentFeed` (on-demand report)

The existing host-level jobs are not replaced.

## Production-test scope

This is intentionally beta-gated. During validation, verify at minimum:

1. existing host-level monitoring is unchanged
2. adding a feed policy does not increase licensed base-source capacity
3. feed `last_seen` follows only the selected sourcetype
4. base maintenance suppresses the feed state
5. retiring the base source makes the feed `RETIRED`
6. disabling and re-enabling a feed policy is audited
7. feed threshold changes are audited
8. existing upgrades preserve all original KV Store records

Do not represent this feature as generally available until these runtime checks pass in the target Splunk versions.
