# Log Source Watch licensing

## Community Edition

Community Edition may be used free of charge for up to **100 Monitored Sources**
for the licensee's own operations in a non-SHC, single-production-search-head
deployment.

A **Monitored Source** is one unique `index + host` combination whose lifecycle
status is `active` or `maintenance`. `retired` sources do not count toward
capacity.

## Paid editions

A paid license is required when any of the following apply:

- more than 100 Monitored Sources;
- Splunk Search Head Cluster deployment;
- multiple production search heads;
- MSP/MSSP, hosted, managed-service, or other third-party service use;
- redistribution, resale, white-labeling, or bundling.

Paid license files may represent Professional, Enterprise, Enterprise Plus, or Service Provider
entitlements. The signed license determines capacity and feature flags; the
app's `LICENSE.txt` and any separately executed commercial agreement determine
legal rights.

## Installing a paid license

Copy the signed license file to:

```text
$SPLUNK_HOME/etc/apps/logsource_watch/local/lsw_license.json
```

The file is read at runtime; a Splunk restart is normally not required for the
license status command to see the new file.

For a Search Head Cluster, deploy the same signed license through the SHC
deployer app so that every member receives the same `local/lsw_license.json`.

Check status in **About -> Licensing**, or run:

```spl
| lswlicense
```

## Capacity behavior

When Community or a paid capacity limit is reached, Log Source Watch keeps
monitoring existing registered sources. Operations that would add new monitored
capacity (for example Discover enrollment, activation of a retired source, or
placing a retired source into maintenance) are blocked until capacity is
available or a suitable paid license is installed.

## Issuer-key security

The private issuer key used to create paid licenses must never be shipped in the
Splunk app, committed to a public repository, or stored on a production search
head. The public verification key is intentionally embedded in the app.

## Standard edition model

| Edition | Standard annual list price | Standard capacity | Standard deployment model |
| --- | ---: | ---: | --- |
| **Community** | **€0 / year** | Up to 100 Monitored Sources | Single standalone environment; own operations |
| **Professional** | **€2,999 / year + VAT** | 101–1,000 | One production environment by default |
| **Enterprise** | **€6,999 / year + VAT** | 1,001–5,000 | SHC and multiple production environments can be entitled |
| **Enterprise Plus** | **From €9,999 / year + VAT** | Above 5,000 / custom / unlimited | Custom capacity and deployment scope |
| **Service Provider** | **Custom quote** | Custom | MSP/MSSP/hosted-service scope when explicitly granted |

These are standard annual public list prices for direct licensing. Final
capacity, deployment rights, support scope, procurement terms, discounts and
renewal terms are defined by the applicable order or commercial agreement.
Current public pricing is published at:

```text
https://logsourcewatch.com/#pricing
```

No paid license file is required for Community Edition. When no signed file is
installed, the application defaults to a 100 Monitored Source capacity.


## Runtime status and expiry behavior

Current license validity, capacity usage, expiry and deployment entitlements are shown under **Reports -> Application Health**. Overview raises a notification when a paid license has 30 days or less remaining and when licensed source capacity is at least 90% utilized.

When a valid paid license expires, existing registered sources continue to be monitored. Actions that would increase the monitored-source population are blocked until a renewed license is installed.
