# Log Source Watch 4.9.3 - First Run

1. Install the TGZ with Splunk Web.
2. Restart Splunk only if the installer requests it.
3. Splunk opens **Initial Setup** automatically while the app is unconfigured.
4. Verify the packaged KV Store collections are available.
5. Select the first index, baseline lookback and default silence threshold.
6. Click **INITIALIZE LOG SOURCE WATCH**.
7. Confirm Inventory, Last_seen and State are non-zero.
8. The setup helper marks the app configured and redirects to the monitoring
   overview.
9. Open **Reports -> Application Health** and confirm the runtime moves from
   setup states to normal scheduler / KV Store health.
10. Open **Management** and verify source lifecycle, threshold and maintenance
    changes update immediately.

The recurring jobs ship enabled and staggered across the five-minute cycle.
Before inventory contains monitored sources, `LSW_Update_LastSeen` remains
fail-closed.
