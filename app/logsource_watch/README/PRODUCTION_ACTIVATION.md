# Production Activation

## 1. Complete Initial Setup

Install the package and complete **Initial Setup**. The setup view creates the
first inventory, seeds last-seen data and builds canonical state.

## 2. Verify scheduled jobs

The production jobs ship enabled and staggered:

- `LSW_Update_LastSeen`
- `LSW_Expire_Maintenance`
- `LSW_Build_State`
- `LSW_Export_SilentHost_File`
- `LSW_Export_Health_File`

`LSW_Update_LastSeen` derives its monitored indexes from `lsw_inventory`.
No broad `index=*` runtime scope is required.

## 3. Validate Health

Use **Reports -> Application Health** and confirm:

- scheduler timestamps advance
- no persistent ERROR / STALE state
- KV Store row counts are plausible
- last-seen refresh completes inside its cadence
- state refresh follows inventory and last-seen changes

## 4. Environment-specific overrides

Only create `local/` overrides when the target environment actually requires
them. Do not modify installed `default/` files.
