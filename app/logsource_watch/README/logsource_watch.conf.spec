# Log Source Watch configuration specification
# Version 4.9.3
#
# Packaged defaults:
#   $SPLUNK_HOME/etc/apps/logsource_watch/default/
#
# Environment-specific overrides:
#   $SPLUNK_HOME/etc/apps/logsource_watch/local/
#
# Do not edit default/ in an installed production deployment.

###############################################################################
# STATE CALCULATION
###############################################################################

[lsw_calculate_state]
# Internal state macro.
#
# State precedence:
#   RETIRED
#   MAINTENANCE
#   NO LOG OBSERVATION
#   SILENT
#   OK
#
# Default threshold fallback:
#   7200 seconds

[lsw_lastseen_scope]
# Compatibility macro retained in the package.
# It is NOT used by the 4.9.3 LSW_Update_LastSeen search.
# Current runtime scope is derived dynamically from distinct active /
# maintenance indexes in lsw_inventory.

[lsw_bulk_max_sources]
# Hard bulk safety limit.
# Packaged value:
#   10000

###############################################################################
# SCHEDULED SEARCHES
###############################################################################

[LSW_Update_LastSeen]
# Purpose:
#   Refresh lsw_lastseen for registered active / maintenance sources.
#
# Scope:
#   Distinct monitored indexes are derived from lsw_inventory.
#   Empty inventory remains fail-closed.
#
# Packaged schedule:
#   */5 * * * *
#
# Reads:
#   indexed TSIDX metadata through tstats
#   lsw_inventory
#   lsw_lastseen
#
# Writes:
#   lsw_lastseen

[LSW_Expire_Maintenance]
# Purpose:
#   Return expired timed maintenance sources to active.
#
# Packaged schedule:
#   1-59/5 * * * *
#
# Reads/Writes:
#   lsw_inventory

[LSW_Build_State]
# Purpose:
#   Reconcile canonical materialized state.
#
# Packaged schedule:
#   2-59/5 * * * *
#
# Reads:
#   lsw_inventory
#   lsw_lastseen
#
# Writes:
#   lsw_state

[LSW_Export_SilentHost_File]
# Purpose:
#   Persist current silent-source CSV output.
#
# Packaged schedule:
#   3-59/5 * * * *

[LSW_Export_Health_File]
# Purpose:
#   Persist application-health CSV output.
#
# Packaged schedule:
#   4-59/5 * * * *

###############################################################################
# KV STORE
###############################################################################

# lsw_inventory
#   _key
#   index
#   host
#   status
#   threshold_seconds
#   maintenance_until
#   change_ref
#   created_at
#   updated_at
#
# lsw_lastseen
#   _key
#   index
#   host
#   last_seen
#   updated_at
#
# lsw_state
#   canonical state materialized from inventory + last_seen
#
# lsw_audit
#   one administrative event per affected source
#
# lsw_health
#   persisted/reserved health integration state

###############################################################################
# PER-SOURCE POLICY
###############################################################################

# Source identity:
#   _key = sha256(index . "|" . host)

# threshold_seconds
#   Stored as integer seconds.
#   UI accepts whole minutes from 1 to 10080.
#   Example: 15 min = 900 seconds.

# status
#   active
#   maintenance
#   retired

# maintenance_until
#   epoch timestamp for timed maintenance
#   0 = maintenance until manually cleared

###############################################################################
# MANAGEMENT WRITE BEHAVIOR
###############################################################################

# Sources / Bulk Actions use authenticated application KV Store operations.
#
# Threshold change:
#   lsw_inventory.threshold_seconds
#   lsw_state immediate refresh
#   lsw_audit threshold_change
#
# Maintenance:
#   lsw_inventory.status = maintenance
#   lsw_inventory.maintenance_until = epoch or 0
#   lsw_state immediate refresh
#   lsw_audit maintenance_set
#
# Activate / Retire:
#   lsw_inventory.status
#   lsw_state immediate refresh
#   lsw_audit lifecycle_change
#
# Discover enrollment writes:
#   lsw_inventory
#   lsw_lastseen
#   lsw_state
#   lsw_audit

###############################################################################
# CAPACITY
###############################################################################

# Main recurring resource consumer:
#   LSW_Update_LastSeen
#
# Cost depends on:
#   monitored indexes in lsw_inventory
#   indexed event volume and bucket layout
#   distributed search topology
#   scheduler capacity
#
# Benchmark scheduler runtime in the actual target environment.

###############################################################################
# FIRST RUN
###############################################################################

# app.conf:
#   is_configured = 0
#   setup_view = initial_setup
#
# Initial Setup creates the first inventory, seeds last_seen, builds state,
# verifies counts and then marks the app configured.
