# Log Source Watch 4.9.3 - Static Security Review

## Scope

This document records a static review of the packaged application. It is not a
substitute for current Splunk AppInspect, penetration testing, load testing or
environment-specific acceptance testing.

## Security design

- Management views are restricted to `admin` / `sc_admin`.
- Read-only monitoring and health views do not mutate indexed data.
- Application configuration is stored in app-owned KV Store collections.
- Management and Bulk writes use authenticated Splunk application-service KV
  Store operations.
- Discovery event searches are operator-driven and constrained to an explicitly
  selected index and lookback window.
- Enrollment and bulk operations have a 10,000-source hard safety limit.
- `LSW_Update_LastSeen` derives its search indexes from registered inventory and
  is fail-closed while inventory is empty.
- Administrative changes write one audit document per affected source.
- The packaged custom audit command is marked risky, local and non-streaming.
- No shell/subprocess execution is used by the packaged Python command.
- No caller-controlled filesystem path is accepted by the audit command.

## Runtime code

`bin/lsw_audit.py`:
- no subprocess or shell execution
- no outbound HTTP client
- no dynamic eval/exec
- fixed application audit log path
- capped input processing

## Remaining operator validation

- scheduler and `tstats` cost in the target Splunk topology
- RBAC and `sc_admin` behavior where applicable
- Search Head Cluster behavior with a paid license that explicitly permits SHC deployment
- target Splunk version compatibility
- KV Store capacity / backup / operational recovery
- public package review with current AppInspect

## Release gate

Before public Splunkbase publication:
1. Run current Splunk AppInspect on the exact final TGZ.
2. Review every warning and manual check.
3. Test clean installation and upgrade.
4. Test Initial Setup end-to-end.
5. Validate declared deployment topologies.
6. Load-test the intended source-count profile.
7. Have the commercial license terms reviewed by qualified legal counsel.


## License signing key

The production Splunk app contains only the public RSA verification key. The private issuer key used by the offline license tool must remain outside the app, outside public source control and outside customer/production Splunk servers. Key compromise requires issuer-key rotation and a new app build containing the replacement public key.
