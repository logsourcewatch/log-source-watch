# Splunkbase Release Checklist

- [ ] Exact final TGZ passes current Splunk AppInspect with zero failures.
- [ ] Every AppInspect warning / manual check is reviewed.
- [ ] Fresh install tested.
- [ ] Initial Setup tested end-to-end.
- [ ] Upgrade from previous public build tested.
- [ ] Management / Bulk / Discover tested with admin permissions.
- [ ] Whole-minute threshold changes verified.
- [ ] Active / Retired / Maintenance transitions verified.
- [ ] Reports are readable in dark theme.
- [ ] Scheduled jobs confirmed advancing in Application Health.
- [ ] Default empty-inventory behavior confirmed fail-closed.
- [ ] App icon and screenshots prepared.
- [ ] Product description, support model and compatibility matrix prepared.
- [ ] LICENSE.txt reviewed by qualified legal counsel before monetization.
- [ ] Release notes and SHA-256 checksum produced.

## Licensing

- [ ] Community capacity tested at 99 / 100 / 101 projected monitored sources.
- [ ] RETIRED sources confirmed not to consume capacity.
- [ ] Professional signed license tested above 100 sources.
- [ ] Invalid/expired license falls back to Community capacity and reports the reason.
- [ ] Search Head Cluster deployment requires a license permitting SHC use.
- [ ] Private issuer key confirmed absent from the Splunk app/repository.
