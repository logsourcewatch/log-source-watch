# Log Source Watch

**Log source availability and silence monitoring for Splunk Enterprise.**

Log Source Watch maintains an explicit inventory of expected `index + host` sources, tracks the latest observation for each source, applies per-source silence policy, and exposes a canonical operational state.

> **Status:** 4.9.3 Release Candidate. The public GA release will be tagged only after runtime validation and Splunk AppInspect acceptance.

![Log Source Watch Overview](screenshots/overview.png)

## Why Log Source Watch

A healthy Splunk platform does not automatically mean every expected source is still delivering telemetry.

Log Source Watch provides:

- explicit monitored-source inventory
- per-source silence thresholds
- `ACTIVE`, `MAINTENANCE`, and `RETIRED` lifecycle management
- timed maintenance
- discovery and controlled enrollment
- bulk policy management
- canonical states: `OK`, `SILENT`, `NO LOG OBSERVATION`, `MAINTENANCE`, `RETIRED`
- operational Overview
- audit trail for administrative changes
- application-health visibility
- signed commercial licensing with a free Community tier

## Community Edition

Community Edition requires no paid license file and supports up to **100 Monitored Sources** in a qualifying standalone Splunk environment.

A **Monitored Source** is one unique Splunk `index + host` pair with lifecycle `ACTIVE` or `MAINTENANCE`. `RETIRED` sources do not consume licensed capacity.

Commercial editions and current public pricing:

- Professional — up to 1,000 Monitored Sources
- Enterprise — up to 5,000 Monitored Sources
- Enterprise Plus — custom / above 5,000
- Service Provider — custom scope

See **https://logsourcewatch.com/#pricing**.

## Documentation

Product documentation:

**https://docs.logsourcewatch.com/**

## Installation

Build or download the release `.tgz`, then install it through **Splunk Web → Apps → Manage Apps → Install app from file**.

Because Log Source Watch includes custom search commands, restart Splunk after initial installation or after an upgrade that changes `commands.conf`.

Open:

**Log Source Watch → Initial Setup**

and follow the guided initialization workflow.

## Repository layout

```text
app/logsource_watch/       Splunk application source
scripts/                   Validation and release tooling
screenshots/               Product screenshots
.github/workflows/         CI and release workflows
```

The release builder packages only `app/logsource_watch/` and produces a Splunk-compatible archive with one top-level directory named `logsource_watch/`.

## Validate

Windows:

```powershell
py -3 scripts\validate.py
```

Linux/macOS:

```bash
python3 scripts/validate.py
```

## Build a release

```powershell
py -3 scripts\build_release.py --version 4.9.3-rc2
```

Output:

```text
dist/logsource_watch-4.9.3-rc2.tgz
dist/logsource_watch-4.9.3-rc2.tgz.sha256
```

## Security

Do not report suspected vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Licensing

This repository is **source-available, not an OSI open-source project**. Use, deployment, redistribution, and commercial rights are governed by [LICENSE.txt](LICENSE.txt).

## Links

- Product: https://logsourcewatch.com/
- Documentation: https://docs.logsourcewatch.com/
- Issues: https://github.com/logsourcewatch/log-source-watch/issues

Splunk is a trademark of Splunk Inc. Log Source Watch is independent software and is not an official Splunk product.
