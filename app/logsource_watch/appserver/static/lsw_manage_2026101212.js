/* Log Source Watch - Premium Management Workspace
 * No page reloads. No long-lived base-search snapshot.
 * Reads and mutations use short-lived Splunk searches and update the UI in place.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/searchmanager",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
    "use strict";

    var ROOT = "#lsw-manage-root";
    var APP = "logsource_watch";
    var PAGE_SIZE_OPTIONS = [25, 50, 100];
    var seq = 0;
    var debounceTimer = null;
    var autoRefreshTimer = null;

    var state = {
        query: "",
        stateFilter: "*",
        lifecycleFilter: "*",
        indexFilter: "*",
        sortField: "host",
        sortDir: "asc",
        page: 1,
        pageSize: 50,
        total: 0,
        rows: [],
        indexes: [],
        stats: { total: 0, silent: 0, maintenance: 0, retired: 0, no_log: 0 },
        loading: true,
        pending: false,
        selected: null,
        selectedKeys: {},
        audit: [],
        username: "unknown",
        lastRefresh: null,
        generation: 0
    };

    function escHtml(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function spl(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .replace(/\\/g, "\\\\")
            .replace(/\"/g, '\\\"');
    }

    function clampText(value, max) {
        value = String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
        return value.slice(0, max || 128);
    }

    function safeKey(key) {
        return /^[a-f0-9]{64}$/i.test(String(key || ""));
    }

    function cleanupManager(id) {
        window.setTimeout(function() {
            try {
                if (mvc.Components && mvc.Components.revokeInstance) {
                    mvc.Components.revokeInstance(id);
                }
            } catch (e) {
                // Search is complete; cleanup failure is non-fatal.
            }
        }, 0);
    }

    function rowsFromPayload(payload) {
        if (!payload) return [];
        if (payload.results && $.isArray(payload.results)) return payload.results;
        var fields = payload.fields || [];
        var rows = payload.rows || [];
        if (!rows.length) return [];
        var names = fields.map(function(f) { return typeof f === "string" ? f : f.name; });
        return rows.map(function(row) {
            var out = {};
            names.forEach(function(name, i) { out[name] = row[i]; });
            return out;
        });
    }

    function runSearch(search, timeoutMs) {
        timeoutMs = timeoutMs || 30000;
        return new Promise(function(resolve, reject) {
            var id = "lsw_manage_" + Date.now() + "_" + (++seq);
            var settled = false;
            var timer;
            var manager;
            var results;

            function finish(fn, value) {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                cleanupManager(id);
                fn(value);
            }

            function fail(prefix, message) {
                var detail = message && message.message ? message.message : message;
                finish(reject, new Error(prefix + (detail ? ": " + detail : "")));
            }

            function consume() {
                try {
                    var payload = results && results.data ? results.data() : null;
                    if (!payload) return false;
                    var rows = rowsFromPayload(payload);
                    var hasShape = ($.isArray(payload.results) || $.isArray(payload.rows));
                    if (rows.length || hasShape) {
                        finish(resolve, rows);
                        return true;
                    }
                } catch (e) {
                    finish(reject, e);
                    return true;
                }
                return false;
            }

            try {
                manager = new SearchManager({
                    id: id,
                    search: search,
                    preview: false,
                    cache: false,
                    autostart: false,
                    app: APP
                });

                // Use the Web Framework's normal JSON result model. json_rows caused
                // intermittent result-model stalls on some Splunk Web versions.
                results = manager.data("results", { count: 0, output_mode: "json" });
                results.on("data", consume);
                results.on("error", function(message) { fail("Result retrieval failed", message); });

                manager.on("search:error", function(message) { fail("Search error", message); });
                manager.on("search:failed", function(message) { fail("Search failed", message); });
                manager.on("search:fail", function(message) { fail("Search failed", message); });
                manager.on("search:cancelled", function() { fail("Search was cancelled"); });
                manager.on("search:done", function(props) {
                    var c = props && props.content ? Number(props.content.resultCount || 0) : 0;
                    if (c === 0) {
                        finish(resolve, []);
                        return;
                    }
                    // Normally the data event follows search:done. Consume an already
                    // populated model immediately and request a fetch as a compatibility
                    // fallback if the model has not emitted yet.
                    if (!consume() && results && typeof results.fetch === "function") {
                        try { results.fetch(); } catch (e) { /* data event/timeout remains authoritative */ }
                    }
                });

                timer = window.setTimeout(function() {
                    try { manager.cancel(); } catch (e) {}
                    finish(reject, new Error("Search timed out after " + Math.round(timeoutMs/1000) + " seconds"));
                }, timeoutMs);

                manager.startSearch();
            } catch (e) {
                finish(reject, e);
            }
        });
    }

    function stateEval() {
        return '| eval display_state=effective_state';
    }

    function managementBase() {
        return '| inputlookup lsw_inventory' +
            ' | lookup local=true lsw_lastseen _key OUTPUT last_seen updated_at AS lastseen_updated_at' +
            ' | `lsw_calculate_state` ' + stateEval();
    }

    function buildFilter() {
        var parts = [];
        var q = clampText(state.query, 128).toLowerCase();
        if (q) {
            q = q.replace(/[%_]/g, "");
            parts.push('(like(lower(host),"%' + spl(q) + '%") OR like(lower(index),"%' + spl(q) + '%"))');
        }
        if (state.stateFilter !== "*") {
            parts.push('display_state="' + spl(state.stateFilter) + '"');
        }
        if (state.lifecycleFilter !== "*") {
            parts.push('status="' + spl(state.lifecycleFilter) + '"');
        }
        if (state.indexFilter !== "*") {
            parts.push('index="' + spl(state.indexFilter) + '"');
        }
        return parts.length ? " | where " + parts.join(" AND ") : "";
    }

    function sortSpec() {
        var allowed = { host: true, index: true, display_state: true, age_minutes: true, last_seen: true, threshold_minutes: true };
        var field = allowed[state.sortField] ? state.sortField : "host";
        var prefix = state.sortDir === "desc" ? "-" : "";
        var tie = field === "host" ? " index" : " host index";
        return prefix + field + tie;
    }

    function pageQuery() {
        var offset = (state.page - 1) * state.pageSize;
        var maxrow = offset + state.pageSize;
        return managementBase() + buildFilter() +
            ' | eventstats count AS __total' +
            ' | eval lifecycle=upper(status), threshold_minutes=round(coalesce(threshold_seconds,7200)/60,0),' +
            ' last_seen_display=if(isnull(last_seen),"—",strftime(last_seen,"%Y-%m-%d %H:%M:%S")),' +
            ' age_display=case(isnull(age_minutes),"—",age_minutes<60,round(age_minutes,1)." min",age_minutes<1440,round(age_minutes/60,1)." h",true(),round(age_minutes/1440,1)." d"),' +
            ' maintenance_display=case(status!="maintenance","—",maintenance_until=0,"Until cleared",true(),strftime(maintenance_until,"%Y-%m-%d %H:%M"))' +
            ' | sort 0 ' + sortSpec() +
            ' | streamstats count AS __row | where __row>' + offset + ' AND __row<=' + maxrow +
            ' | table _key index host display_state lifecycle status threshold_seconds threshold_minutes last_seen last_seen_display age_seconds age_minutes age_display maintenance_until maintenance_display state_updated_at __total';
    }

    function statsQuery() {
        return managementBase() +
            ' | stats count AS total count(eval(display_state="SILENT")) AS silent count(eval(display_state="MAINTENANCE")) AS maintenance count(eval(display_state="RETIRED")) AS retired count(eval(display_state="NO LOG OBSERVATION")) AS no_log';
    }

    function indexesQuery() {
        return '| inputlookup lsw_inventory | stats count AS sources BY index | sort 0 index';
    }

    function licenseStatusQuery(){ return '| lswlicense | fields license_status license_valid edition customer license_id max_monitored_sources shc_allowed deployment_compliant message expires_at'; }
    function monitoredCountLocal(){var n=0;Object.keys(state.inventoryByKey||{}).forEach(function(k){var st=String((state.inventoryByKey[k]||{}).status||"active").toLowerCase();if(st==="active"||st==="maintenance")n++;});return n;}
    function communityLicenseFallback(increment){
        var current=monitoredCountLocal(),max=100,projected=current+Math.max(0,Number(increment||0));
        if(projected>max)throw new Error("Community Edition capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but Community permits 100. Retired sources do not count toward capacity.");
        return {edition:"Community",current:current,max:max,projected:projected,runtime_fallback:true};
    }
    function assertLicenseCapacity(increment){
        increment=Math.max(0,Number(increment||0));
        if(!increment)return Promise.resolve();
        return runSearch(licenseStatusQuery(),30000).then(function(rows){
            var x=rows&&rows[0]?rows[0]:{};
            if(Number(x.deployment_compliant===undefined?1:x.deployment_compliant)!==1)throw new Error(x.message||"Current deployment is not permitted by the active Log Source Watch license");
            if(String(x.license_status||"").toUpperCase()==="EXPIRED")throw new Error(x.message||"Paid Log Source Watch license has expired. Existing monitoring continues, but monitored-source capacity cannot be increased until renewal.");var current=monitoredCountLocal(),max=Number(x.max_monitored_sources||100),projected=current+increment;
            if(max>0&&projected>max)throw new Error("License capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but "+(x.edition||"Community")+" permits "+max.toLocaleString()+". Retired sources do not count toward capacity.");
            return {edition:x.edition||"Community",current:current,max:max,projected:projected,runtime_fallback:false};
        }).catch(function(err){
            var m=String((err&&err.message)||err||"");
            if(/unknown search command/i.test(m))return communityLicenseFallback(increment);
            throw err;
        });
    }

    function auditQuery(row) {
        return '| inputlookup lsw_audit | where index="' + spl(row.index) + '" AND host="' + spl(row.host) + '"' +
            ' | sort 0 - event_time_epoch | head 8 | eval when=strftime(event_time_epoch,"%Y-%m-%d %H:%M:%S")' +
            ' | table when actor operation details';
    }

    function usernameQuery() {
        return '| rest /services/authentication/current-context | head 1 | fields username';
    }

    function viewHref(view) {
        return window.location.pathname.replace(/\/[^/]+\/?$/, "/" + view);
    }

    function workspaceNav(active) {
        var items = [
            ["manage_hosts", "Sources", "sources"],
            ["bulk_management", "Bulk Actions", "bulk"],
            ["add_log_sources", "Discover", "discover"],
            ["initial_setup", "Initial Setup", "setup"]
        ];
        return '<nav class="lsw-workspace-tabs" aria-label="Source management">' + items.map(function(i) {
            return '<a class="lsw-workspace-tab ' + (active === i[2] ? 'active' : '') + '" href="' + escHtml(viewHref(i[0])) + '">' + escHtml(i[1]) + '</a>';
        }).join("") + '</nav>';
    }

    function displayTime(d) {
        if (!d) return "Never";
        try { return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}); }
        catch (e) { return d.toLocaleTimeString(); }
    }

    function badgeClass(value) {
        value = String(value || "").toUpperCase();
        if (value === "OK") return "ok";
        if (value === "SILENT") return "silent";
        if (value === "MAINTENANCE") return "maintenance";
        if (value === "RETIRED") return "retired";
        return "nolog";
    }

    function renderShell() {
        var html = '' +
        '<div class="lsw-workspace">' +
          '<header class="lsw-workspace-header">' +
            '<div class="lsw-header-copy"><div class="lsw-eyebrow">LOG SOURCE WATCH</div><h1>Manage Sources</h1><p>Monitor source health and manage thresholds, lifecycle and maintenance from one workspace.</p></div>' +
            '<div class="lsw-header-actions"><div class="lsw-live-indicator"><span></span>Live inventory</div><button class="lsw-btn lsw-btn-secondary" data-action="refresh">↻ Refresh</button></div>' +
          '</header>' +
          workspaceNav("sources") +
          '<section id="lsw-kpis" class="lsw-kpis"></section>' +
          '<section class="lsw-toolbar">' +
            '<div class="lsw-search-wrap"><span class="lsw-search-icon">⌕</span><input id="lsw-search" class="lsw-search" type="search" placeholder="Search host or index…" autocomplete="off"/><span class="lsw-key-hint">/</span></div>' +
            '<select id="lsw-state-filter" class="lsw-select"><option value="*">All states</option><option>OK</option><option>SILENT</option><option>MAINTENANCE</option><option>NO LOG OBSERVATION</option><option>RETIRED</option></select>' +
            '<select id="lsw-life-filter" class="lsw-select"><option value="*">All lifecycle</option><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="retired">Retired</option></select>' +
            '<select id="lsw-index-filter" class="lsw-select"><option value="*">All indexes</option></select>' +
            '<button class="lsw-btn lsw-btn-ghost" data-action="reset-filters">Reset</button>' +
          '</section>' +
          '<section class="lsw-table-card">' +
            '<div class="lsw-table-meta"><div><strong id="lsw-result-count">0 sources</strong><span id="lsw-refresh-time">Loading…</span></div><div><label>Rows <select id="lsw-page-size" class="lsw-select lsw-select-small"></select></label></div></div>' +
            '<div class="lsw-table-scroll"><table class="lsw-table"><thead><tr>' +
              '<th class="lsw-check-col"><input id="lsw-check-all" type="checkbox" aria-label="Select visible sources"/></th>' +
              '<th data-sort="display_state">State</th><th data-sort="host">Host</th><th data-sort="index">Index</th><th>Lifecycle</th><th data-sort="threshold_minutes">Threshold</th><th data-sort="last_seen">Last seen</th><th data-sort="age_minutes">Age</th><th></th>' +
            '</tr></thead><tbody id="lsw-table-body"></tbody></table></div>' +
            '<div class="lsw-pagination"><span id="lsw-page-status"></span><div><button class="lsw-btn lsw-btn-ghost" data-action="prev-page">← Previous</button><button class="lsw-btn lsw-btn-ghost" data-action="next-page">Next →</button></div></div>' +
          '</section>' +
          '<div id="lsw-bulkbar" class="lsw-bulkbar" hidden></div>' +
        '</div>' +
        '<div id="lsw-drawer-backdrop" class="lsw-drawer-backdrop" hidden></div><aside id="lsw-drawer" class="lsw-drawer" aria-hidden="true"></aside>' +
        '<div id="lsw-modal-backdrop" class="lsw-modal-backdrop" hidden></div><div id="lsw-modal" class="lsw-modal" role="dialog" aria-modal="true" hidden></div>' +
        '<div id="lsw-toasts" class="lsw-toasts" aria-live="assertive"></div>';
        $(ROOT).html(html);
        PAGE_SIZE_OPTIONS.forEach(function(n) { $("#lsw-page-size").append('<option value="'+n+'">'+n+'</option>'); });
        $("#lsw-page-size").val(String(state.pageSize));
    }

    function renderKpis() {
        var s = state.stats;
        var cards = [
            ["Monitored", s.total, "total"],
            ["Silent", s.silent, "silent"],
            ["Maintenance", s.maintenance, "maintenance"],
            ["No log observation", s.no_log, "nolog"],
            ["Retired", s.retired, "retired"]
        ];
        $("#lsw-kpis").html(cards.map(function(c) {
            return '<button class="lsw-kpi '+c[2]+'" data-kpi="'+c[0]+'"><span>'+escHtml(c[0])+'</span><strong>'+Number(c[1]||0).toLocaleString()+'</strong></button>';
        }).join(""));
    }

    function renderIndexes() {
        var $sel = $("#lsw-index-filter");
        var current = state.indexFilter;
        $sel.find('option:not([value="*"])').remove();
        state.indexes.forEach(function(item) {
            $sel.append('<option value="'+escHtml(item.index)+'">'+escHtml(item.index)+' ('+escHtml(item.sources)+')</option>');
        });
        $sel.val(current);
    }

    function renderLoadingRows() {
        var rows = [];
        for (var i=0; i<8; i++) {
            rows.push('<tr class="lsw-skeleton-row"><td colspan="9"><div class="lsw-skeleton"></div></td></tr>');
        }
        $("#lsw-table-body").html(rows.join(""));
    }

    function renderRows() {
        var $body = $("#lsw-table-body");
        if (!state.rows.length) {
            $body.html('<tr><td colspan="9"><div class="lsw-empty"><div class="lsw-empty-icon">⌕</div><strong>No sources match these filters</strong><span>Adjust the search or reset filters.</span></div></td></tr>');
        } else {
            $body.html(state.rows.map(function(r) {
                var checked = state.selectedKeys[r._key] ? " checked" : "";
                return '<tr class="lsw-source-row" data-key="'+escHtml(r._key)+'">' +
                    '<td class="lsw-check-col"><input class="lsw-row-check" data-key="'+escHtml(r._key)+'" type="checkbox"'+checked+' aria-label="Select '+escHtml(r.host)+'"/></td>' +
                    '<td><span class="lsw-state-pill '+badgeClass(r.display_state)+'"><i></i>'+escHtml(r.display_state)+'</span></td>' +
                    '<td><button class="lsw-host-link" data-key="'+escHtml(r._key)+'">'+escHtml(r.host)+'</button></td>' +
                    '<td><span class="lsw-mono">'+escHtml(r.index)+'</span></td>' +
                    '<td><span class="lsw-life '+String(r.status||"").toLowerCase()+'">'+escHtml(r.lifecycle)+'</span></td>' +
                    '<td>'+escHtml(r.threshold_minutes)+' min</td>' +
                    '<td class="lsw-dim">'+escHtml(r.last_seen_display)+'</td>' +
                    '<td>'+escHtml(r.age_display)+'</td>' +
                    '<td class="lsw-row-arrow">›</td>' +
                '</tr>';
            }).join(""));
        }
        $("#lsw-result-count").text(Number(state.total||0).toLocaleString()+" sources");
        $("#lsw-refresh-time").text("Updated "+displayTime(state.lastRefresh));
        var pages = Math.max(1, Math.ceil(state.total / state.pageSize));
        $("#lsw-page-status").text("Page "+state.page+" of "+pages);
        $('[data-action="prev-page"]').prop("disabled", state.page <= 1 || state.loading);
        $('[data-action="next-page"]').prop("disabled", state.page >= pages || state.loading);
        var allVisible = state.rows.length && state.rows.every(function(r){ return !!state.selectedKeys[r._key]; });
        $("#lsw-check-all").prop("checked", !!allVisible);
        renderBulkBar();
    }

    function renderBulkBar() {
        var keys = Object.keys(state.selectedKeys).filter(function(k){ return state.selectedKeys[k]; });
        var $bar = $("#lsw-bulkbar");
        if (!keys.length) { $bar.attr("hidden", true).empty(); return; }
        $bar.removeAttr("hidden").html(
            '<div><strong>'+keys.length+' selected</strong><span>Visible-page selection</span></div>'+
            '<div class="lsw-bulk-actions">'+
              '<button class="lsw-btn lsw-btn-secondary" data-bulk="activate">Activate</button>'+
              '<button class="lsw-btn lsw-btn-secondary" data-bulk="maintenance">Maintenance 1h</button>'+
              '<button class="lsw-btn lsw-btn-secondary" data-bulk="clear_maintenance">Clear maintenance</button>'+
              '<button class="lsw-btn lsw-btn-danger" data-bulk="retire">Retire</button>'+
              '<button class="lsw-btn lsw-btn-ghost" data-action="clear-selection">Clear</button>'+
            '</div>'
        );
    }

    function renderDrawer() {
        var r = state.selected;
        var $drawer = $("#lsw-drawer");
        if (!r) {
            $("#lsw-drawer-backdrop").attr("hidden", true);
            $drawer.attr("aria-hidden", "true").removeClass("open").empty();
            return;
        }
        var maintenanceText = r.status === "maintenance" ? r.maintenance_display : "Not in maintenance";
        var auditHtml = state.audit.length ? state.audit.map(function(a){
            return '<div class="lsw-audit-item"><div><strong>'+escHtml((a.operation||"").replace(/_/g," "))+'</strong><span>'+escHtml(a.when)+'</span></div><p>'+escHtml(a.details||"Configuration change")+'</p><small>'+escHtml(a.actor||"unknown")+'</small></div>';
        }).join("") : '<div class="lsw-audit-empty">No audit events for this source yet.</div>';

        $drawer.html(
          '<div class="lsw-drawer-head"><div><span class="lsw-state-pill '+badgeClass(r.display_state)+'"><i></i>'+escHtml(r.display_state)+'</span><h2>'+escHtml(r.host)+'</h2><p>'+escHtml(r.index)+'</p></div><button class="lsw-icon-btn" data-action="close-drawer" aria-label="Close">×</button></div>'+
          '<div class="lsw-drawer-body">'+
            '<section class="lsw-detail-grid">'+
              '<div><span>Lifecycle</span><strong>'+escHtml(r.lifecycle)+'</strong></div><div><span>Last seen</span><strong>'+escHtml(r.last_seen_display)+'</strong></div>'+
              '<div><span>Event age</span><strong>'+escHtml(r.age_display)+'</strong></div><div><span>Maintenance</span><strong>'+escHtml(maintenanceText)+'</strong></div>'+
            '</section>'+
            '<section class="lsw-editor-section"><div class="lsw-section-heading"><div><h3>Silence threshold</h3><p>Source becomes SILENT when this limit is exceeded.</p></div></div>'+ 
              '<div class="lsw-inline-control"><input id="lsw-threshold-input" type="number" min="1" max="10080" step="1" inputmode="numeric" value="'+escHtml(r.threshold_minutes)+'"/><span>minutes</span><button class="lsw-btn lsw-btn-primary" data-action="save-threshold">Save threshold</button></div>'+ 
            '</section>'+
            '<section class="lsw-editor-section"><div class="lsw-section-heading"><div><h3>Lifecycle</h3><p>Retired sources remain in history but no longer alarm.</p></div></div>'+ 
              '<div class="lsw-segment">'+
                '<button data-action="activate-source" class="'+(r.status==="active"?"active":"")+'">Active</button>'+
                '<button data-action="retire-source" class="'+(r.status==="retired"?"active danger":"danger")+'">Retired</button>'+
              '</div>'+ 
            '</section>'+
            '<section class="lsw-editor-section"><div class="lsw-section-heading"><div><h3>Maintenance</h3><p>Suppress silence state temporarily or until manually cleared.</p></div></div>'+ 
              '<div class="lsw-maintenance-actions">'+
                '<button class="lsw-chip" data-maintenance="3600">1 hour</button><button class="lsw-chip" data-maintenance="28800">8 hours</button><button class="lsw-chip" data-maintenance="86400">24 hours</button><button class="lsw-chip" data-maintenance="0">Until cleared</button>'+ 
                (r.status==="maintenance"?'<button class="lsw-chip clear" data-action="clear-maintenance">End now</button>':'')+
              '</div>'+ 
            '</section>'+
            '<section class="lsw-editor-section"><div class="lsw-section-heading"><div><h3>Recent changes</h3><p>Latest audit activity for this index + host pair.</p></div></div><div class="lsw-audit-list">'+auditHtml+'</div></section>'+ 
          '</div>'+ 
          '<div class="lsw-drawer-foot"><span class="lsw-drawer-key">'+escHtml(r._key)+'</span><button class="lsw-btn lsw-btn-ghost" data-action="close-drawer">Close</button></div>'
        );
        $("#lsw-drawer-backdrop").removeAttr("hidden");
        $drawer.attr("aria-hidden", "false").addClass("open");
    }

    function toast(message, type) {
        type = type || "success";
        var id = "toast_" + Date.now() + "_" + (++seq);
        var $t = $('<div class="lsw-toast '+type+'" id="'+id+'"><span class="lsw-toast-icon">'+(type==="error"?"!":"✓")+'</span><div>'+escHtml(message)+'</div></div>');
        $("#lsw-toasts").append($t);
        window.setTimeout(function(){ $t.addClass("show"); }, 10);
        window.setTimeout(function(){ $t.removeClass("show"); window.setTimeout(function(){ $t.remove(); },250); }, 4200);
    }

    function modal(title, body, confirmLabel, danger) {
        return new Promise(function(resolve) {
            var $m = $("#lsw-modal");
            $("#lsw-modal-backdrop").removeAttr("hidden");
            $m.removeAttr("hidden").html(
              '<div class="lsw-modal-head"><h3>'+escHtml(title)+'</h3></div>'+ 
              '<div class="lsw-modal-body">'+body+'</div>'+ 
              '<div class="lsw-modal-actions"><button class="lsw-btn lsw-btn-ghost" data-modal="cancel">Cancel</button><button class="lsw-btn '+(danger?'lsw-btn-danger':'lsw-btn-primary')+'" data-modal="confirm">'+escHtml(confirmLabel||"Confirm")+'</button></div>'
            );
            function close(value) {
                $(document).off("click.lswmodal");
                $("#lsw-modal-backdrop").attr("hidden", true); $m.attr("hidden", true).empty(); resolve(value);
            }
            $(document).on("click.lswmodal", '[data-modal="cancel"]', function(){ close(false); });
            $(document).on("click.lswmodal", '[data-modal="confirm"]', function(){ close(true); });
        });
    }

    function setPending(on) {
        state.pending = !!on;
        $(ROOT).toggleClass("lsw-pending", state.pending);
        $("#lsw-drawer button, #lsw-bulkbar button").prop("disabled", state.pending);
    }

    function loadPage(resetPage) {
        if (resetPage) state.page = 1;
        var generation = ++state.generation;
        state.loading = true;
        renderLoadingRows();
        return runSearch(pageQuery()).then(function(rows) {
            if (generation !== state.generation) return;
            if ((!rows || !rows.length) && state.page > 1) {
                state.page = 1;
                return loadPage(false);
            }
            state.rows = rows || [];
            state.total = state.rows[0] ? Number(state.rows[0].__total || 0) : 0;
            state.loading = false;
            state.lastRefresh = new Date();
            renderRows();
        }).catch(function(err) {
            if (generation !== state.generation) return;
            state.loading = false;
            state.rows = [];
            state.total = 0;
            $("#lsw-table-body").html('<tr><td colspan="9"><div class="lsw-empty error"><strong>Could not load source inventory</strong><span>'+escHtml(err.message)+'</span><button class="lsw-btn lsw-btn-primary" data-action="refresh">Try again</button></div></td></tr>');
            $("#lsw-result-count").text("Load failed");
            toast(err.message, "error");
        });
    }

    function loadStats() {
        return runSearch(statsQuery()).then(function(rows) {
            if (rows[0]) {
                state.stats = {
                    total: Number(rows[0].total||0), silent: Number(rows[0].silent||0), maintenance: Number(rows[0].maintenance||0),
                    retired: Number(rows[0].retired||0), no_log: Number(rows[0].no_log||0)
                };
                renderKpis();
            }
        }).catch(function(){ /* non-blocking */ });
    }

    function loadIndexes() {
        return runSearch(indexesQuery()).then(function(rows){ state.indexes = rows || []; renderIndexes(); }).catch(function(){});
    }

    function loadUsername() {
        return runSearch(usernameQuery()).then(function(rows){ if(rows[0] && rows[0].username) state.username=rows[0].username; }).catch(function(){});
    }

    function openSource(key) {
        var row = state.rows.filter(function(r){ return r._key === key; })[0];
        if (!row) return;
        state.selected = $.extend({}, row);
        state.audit = [];
        renderDrawer();
        runSearch(auditQuery(row)).then(function(rows){
            if (state.selected && state.selected._key === key) { state.audit = rows || []; renderDrawer(); }
        }).catch(function(){});
    }

    function closeDrawer() { state.selected = null; state.audit = []; renderDrawer(); }

    function mutationSearch(row, action, value) {
        if (!safeKey(row._key)) throw new Error("Invalid source key");
        var key = spl(row._key);
        var actor = spl(state.username || "unknown");
        var operation = "source_update";
        var detail = "Source policy updated";
        var mutate = "";

        if (action === "threshold") {
            var minutes = Math.max(1, Math.min(10080, Number(value || 0)));
            if (!isFinite(minutes)) throw new Error("Invalid threshold");
            operation = "threshold_change";
            detail = "Threshold changed to " + minutes + " minutes";
            mutate = '| eval threshold_seconds=' + minutes*60 + ', updated_at=now(), change_ref="ui-threshold"';
        } else if (action === "retire") {
            operation = "lifecycle_change"; detail = "Lifecycle changed to retired";
            mutate = '| eval status="retired", maintenance_until=0, updated_at=now(), change_ref="ui-retire"';
        } else if (action === "activate") {
            operation = "lifecycle_change"; detail = "Lifecycle changed to active";
            mutate = '| eval status="active", maintenance_until=0, updated_at=now(), change_ref="ui-activate"';
        } else if (action === "maintenance") {
            var secs = Math.max(0, Number(value || 0));
            if (!isFinite(secs) || secs > 2592000) throw new Error("Invalid maintenance duration");
            operation = "maintenance_set"; detail = secs === 0 ? "Maintenance enabled until cleared" : "Maintenance enabled for " + Math.round(secs/3600) + " hours";
            mutate = '| eval status="maintenance", maintenance_until=if(' + Math.round(secs) + '=0,0,now()+' + Math.round(secs) + '), updated_at=now(), change_ref="ui-maintenance"';
        } else if (action === "clear_maintenance") {
            operation = "maintenance_set"; detail = "Maintenance cleared";
            mutate = '| eval status="active", maintenance_until=0, updated_at=now(), change_ref="ui-maintenance-clear"';
        } else {
            throw new Error("Unsupported action");
        }

        return '| inputlookup lsw_inventory | where _key="' + key + '"' +
            ' | eval audit_old_status=coalesce(status,"active"),audit_old_threshold_seconds=coalesce(threshold_seconds,7200),audit_old_maintenance_until=coalesce(maintenance_until,0)' +
            mutate +
            ' | eval audit_new_status=status,audit_new_threshold_seconds=threshold_seconds,audit_new_maintenance_until=maintenance_until' +
            ' | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_inventory' +
            ' | appendpipe [ | eval event_time_epoch=now(),actor="' + actor + '",scope="manage",operation="' + operation + '",old_status=audit_old_status,new_status=audit_new_status,old_threshold_seconds=audit_old_threshold_seconds,new_threshold_seconds=audit_new_threshold_seconds,old_maintenance_until=audit_old_maintenance_until,new_maintenance_until=audit_new_maintenance_until,details="' + spl(detail) + '"' +
            ' | eval audit_key=sha256(tostring(event_time_epoch)."|".actor."|".index."|".host."|".operation."|".tostring(random())),_key=audit_key' +
            ' | fields _key event_time_epoch actor scope operation index host old_status new_status old_threshold_seconds new_threshold_seconds old_maintenance_until new_maintenance_until change_ref details' +
            ' | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_audit | where 1=0 ]' +
            ' | lsw_audit action=source_update source=manage_hosts detail="' + spl(detail) + '"' +
            ' | lookup local=true lsw_lastseen _key OUTPUT last_seen updated_at AS lastseen_updated_at' +
            ' | `lsw_calculate_state` | eval state_updated_at=now()' +
            ' | fields _key index host status threshold_seconds threshold_minutes maintenance_until change_ref last_seen lastseen_updated_at age_seconds age_minutes effective_state alarm state_updated_at' +
            ' | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_state' + stateEval() +
            ' | eval lifecycle=upper(status),threshold_minutes=round(coalesce(threshold_seconds,7200)/60,0),last_seen_display=if(isnull(last_seen),"—",strftime(last_seen,"%Y-%m-%d %H:%M:%S")),age_display=case(isnull(age_minutes),"—",age_minutes<60,round(age_minutes,1)." min",age_minutes<1440,round(age_minutes/60,1)." h",true(),round(age_minutes/1440,1)." d"),maintenance_display=case(status!="maintenance","—",maintenance_until=0,"Until cleared",true(),strftime(maintenance_until,"%Y-%m-%d %H:%M"))' +
            ' | table _key index host display_state lifecycle status threshold_seconds threshold_minutes last_seen last_seen_display age_seconds age_minutes age_display maintenance_until maintenance_display state_updated_at';
    }

    function bulkMutationSearch(keys, action, value) {
        keys = keys.filter(safeKey).slice(0, 100);
        if (!keys.length) throw new Error("Nothing selected");
        var condition = keys.map(function(k){ return '"'+spl(k)+'"'; }).join(",");
        var template = mutationSearch({_key: keys[0]}, action, value);
        template = template.replace('| where _key="'+spl(keys[0])+'"', '| where in(_key,'+condition+')');
        return template.replace(/\| table _key index host display_state[\s\S]*$/, '| stats count AS affected values(display_state) AS states');
    }

    function applyUpdatedRow(updated) {
        if (!updated || !updated._key) return;
        state.rows = state.rows.map(function(r){ return r._key === updated._key ? $.extend({}, r, updated) : r; });
        if (state.selected && state.selected._key === updated._key) state.selected = $.extend({}, state.selected, updated);
        renderRows(); renderDrawer();
    }

    function mutateSelected(action, value, successMessage) {
        if (!state.selected || state.pending) return Promise.resolve();
        var source = $.extend({}, state.selected);
        setPending(true);
        return runSearch(mutationSearch(source, action, value), 45000).then(function(rows) {
            if (!rows.length) throw new Error("Source was not updated");
            applyUpdatedRow(rows[0]);
            toast(successMessage || (source.host + " updated"));
            return Promise.all([loadStats(), runSearch(auditQuery(rows[0])).then(function(a){ state.audit=a||[]; renderDrawer(); })]);
        }).then(function(){ return loadPage(false); }).catch(function(err){ toast(err.message, "error"); }).then(function(){ setPending(false); });
    }

    function doBulk(action, value) {
        if (state.pending) return;
        var keys = Object.keys(state.selectedKeys).filter(function(k){return state.selectedKeys[k];});
        if (!keys.length) return;
        var label = action === "retire" ? "Retire " + keys.length + " selected sources?" : "Apply action to " + keys.length + " selected sources?";
        modal(label, '<p>This updates only the sources selected on the current page. The change is written to inventory, canonical state and audit trail immediately.</p>', action === "retire" ? "Retire sources" : "Apply", action === "retire").then(function(ok){
            if (!ok) return;
            setPending(true);
            runSearch(bulkMutationSearch(keys, action, value), 60000).then(function(rows){
                var affected = rows[0] ? Number(rows[0].affected||0) : 0;
                toast(affected + " sources updated");
                state.selectedKeys = {};
                return Promise.all([loadPage(false), loadStats()]);
            }).catch(function(err){ toast(err.message,"error"); }).then(function(){ setPending(false); });
        });
    }



    /* Production data plane: management CRUD goes directly to App KV Store REST.
     * SearchManager is intentionally not used for inventory reads or mutations.
     */
    var kvService = mvc.createService({ owner: "nobody", app: APP });
    state.allRows = [];
    state.inventoryByKey = {};
    state.lastSeenByKey = {};

    function rc4Error(value) {
        if (!value) return "Unknown error";
        if (typeof value === "string") return value;
        if (value.message) return String(value.message);
        if (value.statusText) return String(value.statusText);
        if (value.responseText) {
            try {
                var parsed = JSON.parse(value.responseText);
                if (parsed && parsed.messages && parsed.messages[0]) return parsed.messages[0].text || JSON.stringify(parsed.messages[0]);
                return JSON.stringify(parsed);
            } catch (e) { return String(value.responseText).slice(0, 500); }
        }
        if (value.content && value.content.messages && value.content.messages[0]) {
            return value.content.messages[0].text || JSON.stringify(value.content.messages[0]);
        }
        try { return JSON.stringify(value); } catch (e2) { return String(value); }
    }

    function kvGet(collection, key, params) {
        return new Promise(function(resolve, reject) {
            var path = "storage/collections/data/" + collection + (key ? "/" + encodeURIComponent(key) : "");
            kvService.get(path, params || {}, function(err, response) {
                if (err) { reject(new Error(rc4Error(err))); return; }
                var data=response && response.data !== undefined ? response.data : response;if(typeof data === "string"){try{data=JSON.parse(data);}catch(e){}}resolve(data);
            });
        });
    }

    function kvPost(collection, key, document) {
        return new Promise(function(resolve, reject) {
            var path = "storage/collections/data/" + collection + (key ? "/" + encodeURIComponent(key) : "");
            kvService.request(path, "POST", null, null, JSON.stringify(document), {"Content-Type":"application/json"}, null)
                .done(function(data) {
                    try { resolve(typeof data === "string" ? JSON.parse(data) : data); }
                    catch (e) { resolve(data); }
                })
                .fail(function(err) { reject(new Error(rc4Error(err))); });
        });
    }

    function kvBatchSave(collection, documents) {
        if (!documents.length) return Promise.resolve([]);
        return new Promise(function(resolve, reject) {
            kvService.request("storage/collections/data/" + collection + "/batch_save", "POST", null, null,
                JSON.stringify(documents), {"Content-Type":"application/json"}, null)
                .done(function(data) {
                    try { resolve(typeof data === "string" ? JSON.parse(data) : data); }
                    catch (e) { resolve(data); }
                })
                .fail(function(err) { reject(new Error(rc4Error(err))); });
        });
    }

    function rc4Epoch() { return Math.floor(Date.now()/1000); }
    function rc4Date(epoch) {
        if (epoch === null || epoch === undefined || epoch === "") return "—";
        var d = new Date(Number(epoch)*1000);
        if (isNaN(d.getTime())) return "—";
        var z=function(n){return String(n).padStart(2,"0");};
        return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+" "+z(d.getHours())+":"+z(d.getMinutes())+":"+z(d.getSeconds());
    }
    function rc4State(inv, ls) {
        var now=rc4Epoch(), threshold=Number(inv.threshold_seconds||7200), last=ls && ls.last_seen!==undefined ? Number(ls.last_seen) : null;
        var maint=Number(inv.maintenance_until||0), status=String(inv.status||"active").toLowerCase();
        var effective, display, age=null;
        if (last!==null && isFinite(last)) age=Math.max(0,now-last);
        if (status==="retired") effective="RETIRED";
        else if (status==="maintenance" && (maint===0 || maint>now)) effective="MAINTENANCE";
        else if (last===null || !isFinite(last)) effective="NO LOG OBSERVATION";
        else if (age>threshold) effective="SILENT";
        else effective="OK";
        display = effective;
        var ageMin=age===null?null:Math.round(age/6)/10;
        return {
            _key:inv._key,index:inv.index,host:inv.host,status:status,lifecycle:status.toUpperCase(),
            threshold_seconds:threshold,threshold_minutes:Math.round(threshold/60),maintenance_until:maint,
            change_ref:inv.change_ref||"",created_at:inv.created_at,updated_at:inv.updated_at,
            last_seen:last,lastseen_updated_at:ls?ls.updated_at:null,age_seconds:age,age_minutes:ageMin,
            effective_state:effective,display_state:display,alarm:effective==="SILENT"?1:0,state_updated_at:now,
            last_seen_display:rc4Date(last),
            age_display:ageMin===null?"—":ageMin<60?ageMin.toFixed(1)+" min":ageMin<1440?(ageMin/60).toFixed(1)+" h":(ageMin/1440).toFixed(1)+" d",
            maintenance_display:status!=="maintenance"?"—":maint===0?"Until cleared":rc4Date(maint).slice(0,16)
        };
    }

    function rc4StateDoc(row) {
        return {_key:row._key,index:row.index,host:row.host,status:row.status,threshold_seconds:Number(row.threshold_seconds||7200),
            threshold_minutes:Number(row.threshold_minutes||Math.round(Number(row.threshold_seconds||7200)/60)),maintenance_until:Number(row.maintenance_until||0),
            change_ref:row.change_ref||"",last_seen:row.last_seen,lastseen_updated_at:row.lastseen_updated_at,age_seconds:row.age_seconds,age_minutes:row.age_minutes,
            effective_state:row.effective_state,alarm:Number(row.alarm||0),state_updated_at:rc4Epoch()};
    }

    function rc4InventoryDoc(inv) {
        return {_key:inv._key,index:inv.index,host:inv.host,status:inv.status,threshold_seconds:Number(inv.threshold_seconds||7200),
            maintenance_until:Number(inv.maintenance_until||0),change_ref:inv.change_ref||"",created_at:Number(inv.created_at||rc4Epoch()),updated_at:Number(inv.updated_at||rc4Epoch())};
    }

    function rc4LoadAll() {
        return Promise.all([
            kvGet("lsw_inventory", null, {limit:10000}),
            kvGet("lsw_lastseen", null, {limit:10000})
        ]).then(function(parts) {
            var inv = $.isArray(parts[0]) ? parts[0] : [];
            var seen = $.isArray(parts[1]) ? parts[1] : [];
            state.inventoryByKey={}; state.lastSeenByKey={};
            seen.forEach(function(x){state.lastSeenByKey[x._key]=x;});
            state.allRows=inv.map(function(x){state.inventoryByKey[x._key]=x;return rc4State(x,state.lastSeenByKey[x._key]);});
            return state.allRows;
        });
    }

    function rc4FilteredRows() {
        var q=clampText(state.query,128).toLowerCase();
        var rows=state.allRows.filter(function(r){
            if(q && String(r.host||"").toLowerCase().indexOf(q)<0 && String(r.index||"").toLowerCase().indexOf(q)<0) return false;
            if(state.stateFilter!=="*" && r.display_state!==state.stateFilter) return false;
            if(state.lifecycleFilter!=="*" && r.status!==state.lifecycleFilter) return false;
            if(state.indexFilter!=="*" && r.index!==state.indexFilter) return false;
            return true;
        });
        var f=state.sortField, dir=state.sortDir==="desc"?-1:1;
        rows.sort(function(a,b){var av=a[f],bv=b[f];if(av===bv)return String(a.host).localeCompare(String(b.host))||String(a.index).localeCompare(String(b.index));if(av===null||av===undefined)return 1;if(bv===null||bv===undefined)return -1;return (av>bv?1:-1)*dir;});
        return rows;
    }

    function rc4RenderFromCache() {
        var filtered=rc4FilteredRows();
        state.total=filtered.length;
        var start=(state.page-1)*state.pageSize;
        state.rows=filtered.slice(start,start+state.pageSize);
        state.stats={total:state.allRows.length,silent:0,maintenance:0,retired:0,no_log:0};
        state.allRows.forEach(function(r){if(r.display_state==="SILENT")state.stats.silent++;else if(r.display_state==="MAINTENANCE")state.stats.maintenance++;else if(r.display_state==="RETIRED")state.stats.retired++;else if(r.display_state==="NO LOG OBSERVATION")state.stats.no_log++;});
        var byIndex={};state.allRows.forEach(function(r){byIndex[r.index]=(byIndex[r.index]||0)+1;});
        state.indexes=Object.keys(byIndex).sort().map(function(k){return{index:k,sources:byIndex[k]};});
        state.loading=false;state.lastRefresh=new Date();renderRows();renderKpis();renderIndexes();
    }

    loadPage = function(resetPage) {
        if(resetPage) state.page=1;
        state.loading=true;renderLoadingRows();
        if(state.allRows.length){rc4RenderFromCache();return Promise.resolve();}
        return rc4LoadAll().then(function(){rc4RenderFromCache();}).catch(function(err){
            state.loading=false;state.rows=[];state.total=0;
            $("#lsw-table-body").html('<tr><td colspan="9"><div class="lsw-empty error"><strong>Could not load source inventory</strong><span>'+escHtml(err.message)+'</span><button class="lsw-btn lsw-btn-primary" data-action="refresh">Try again</button></div></td></tr>');
            $("#lsw-result-count").text("Load failed");toast(err.message,"error");
        });
    };
    loadStats = function(){rc4RenderFromCache();return Promise.resolve();};
    loadIndexes = function(){if(state.allRows.length){rc4RenderFromCache();return Promise.resolve();}return rc4LoadAll().then(rc4RenderFromCache).catch(function(){});};
    loadUsername = function(){return new Promise(function(resolve){kvService.get("authentication/current-context",{},function(err,res){if(!err&&res&&res.data){var d=res.data;state.username=(d.username||(d.entry&&d.entry[0]&&d.entry[0].content&&d.entry[0].content.username)||state.username);}resolve();});});};

    function rc4AuditFor(row){
        return kvGet("lsw_audit",null,{query:JSON.stringify({index:row.index,host:row.host}),sort:"event_time_epoch:-1",limit:8}).then(function(rows){return ($.isArray(rows)?rows:[]).map(function(x){return{when:rc4Date(x.event_time_epoch),actor:x.actor,operation:x.operation,details:x.details};});});
    }
    openSource = function(key){var row=state.allRows.filter(function(r){return r._key===key;})[0];if(!row)return;state.selected=$.extend({},row);state.audit=[];renderDrawer();rc4AuditFor(row).then(function(rows){if(state.selected&&state.selected._key===key){state.audit=rows;renderDrawer();}}).catch(function(){});};

    function rc4MutationSpec(inv,action,value){
        var now=rc4Epoch(), operation="source_update", detail="Source updated";
        var out=$.extend({},inv);
        var old={status:String(inv.status||"active"),threshold:Number(inv.threshold_seconds||7200),maintenance:Number(inv.maintenance_until||0)};
        if(action==="threshold"){var m=Number(value);if(!isFinite(m)||m<1||m>10080||Math.floor(m)!==m)throw new Error("Threshold must be a whole number between 1 and 10080 minutes");out.threshold_seconds=m*60;out.change_ref="ui-threshold";operation="threshold_change";detail="Threshold changed to "+m+" minutes";}
        else if(action==="retire"){out.status="retired";out.maintenance_until=0;out.change_ref="ui-retire";operation="lifecycle_change";detail="Lifecycle changed to retired";}
        else if(action==="activate"){out.status="active";out.maintenance_until=0;out.change_ref="ui-activate";operation="lifecycle_change";detail="Lifecycle changed to active";}
        else if(action==="maintenance"){var secs=Math.max(0,Number(value||0));if(!isFinite(secs)||secs>2592000)throw new Error("Invalid maintenance duration");out.status="maintenance";out.maintenance_until=secs===0?0:now+Math.round(secs);out.change_ref="ui-maintenance";operation="maintenance_set";detail=secs===0?"Maintenance enabled until cleared":"Maintenance enabled for "+Math.round(secs/3600)+" hours";}
        else if(action==="clear_maintenance"){out.status="active";out.maintenance_until=0;out.change_ref="ui-maintenance-clear";operation="maintenance_set";detail="Maintenance cleared";}
        else throw new Error("Unsupported action");
        out.updated_at=now;out.created_at=Number(out.created_at||now);
        return {doc:rc4InventoryDoc(out),old:old,operation:operation,detail:detail};
    }

    function rc4AuditDoc(inv,spec){return{event_time_epoch:rc4Epoch(),actor:state.username||"unknown",scope:"manage",operation:spec.operation,index:inv.index,host:inv.host,old_status:spec.old.status,new_status:spec.doc.status,old_threshold_seconds:spec.old.threshold,new_threshold_seconds:spec.doc.threshold_seconds,old_maintenance_until:spec.old.maintenance,new_maintenance_until:spec.doc.maintenance_until,change_ref:spec.doc.change_ref,details:spec.detail};}

    mutateSelected = function(action,value,successMessage){
        if(!state.selected||state.pending)return Promise.resolve();var key=state.selected._key;setPending(true);
        return Promise.all([kvGet("lsw_inventory",key,{}),kvGet("lsw_lastseen",key,{}).catch(function(){return null;})]).then(function(parts){
            var inv=parts[0], ls=parts[1], spec=rc4MutationSpec(inv,action,value);
            var increment=(String(inv.status||"active").toLowerCase()==="retired"&&(action==="activate"||action==="maintenance"))?1:0;
            return assertLicenseCapacity(increment).then(function(){return kvPost("lsw_inventory",key,spec.doc).then(function(){var row=rc4State(spec.doc,ls);return Promise.all([kvPost("lsw_state",key,rc4StateDoc(row)),kvPost("lsw_audit",null,rc4AuditDoc(inv,spec))]).then(function(){return row;});});});
        }).then(function(row){
            state.inventoryByKey[row._key]=rc4InventoryDoc(row);state.allRows=state.allRows.map(function(r){return r._key===row._key?row:r;});applyUpdatedRow(row);rc4RenderFromCache();toast(successMessage||(row.host+" updated"));return rc4AuditFor(row).then(function(a){state.audit=a;renderDrawer();}).catch(function(){return null;});
        }).catch(function(err){toast(err.message,"error");}).then(function(){setPending(false);});
    };

    doBulk = function(action,value){
        if(state.pending)return;var keys=Object.keys(state.selectedKeys).filter(function(k){return state.selectedKeys[k];});if(!keys.length)return;
        var label=action==="retire"?"Retire "+keys.length+" selected sources?":"Apply action to "+keys.length+" selected sources?";
        modal(label,'<p>This updates only the selected rows. Inventory remains authoritative and canonical state is updated immediately.</p>',action==="retire"?"Retire sources":"Apply",action==="retire").then(function(ok){if(!ok)return;setPending(true);
            var invDocs=[],stateDocs=[],auditDocs=[],updated=[],increment=0;
            try{keys.forEach(function(k){var inv=state.inventoryByKey[k];if(!inv)return;if(String(inv.status||"active").toLowerCase()==="retired"&&(action==="activate"||action==="maintenance"))increment++;var spec=rc4MutationSpec(inv,action,value);var row=rc4State(spec.doc,state.lastSeenByKey[k]);invDocs.push(spec.doc);stateDocs.push(rc4StateDoc(row));auditDocs.push(rc4AuditDoc(inv,spec));updated.push(row);});}catch(e){toast(e.message,"error");setPending(false);return;}
            assertLicenseCapacity(increment).then(function(){return kvBatchSave("lsw_inventory",invDocs);}).then(function(){return kvBatchSave("lsw_audit",auditDocs);}).then(function(){return kvBatchSave("lsw_state",stateDocs);}).then(function(){updated.forEach(function(row){state.inventoryByKey[row._key]=rc4InventoryDoc(row);state.allRows=state.allRows.map(function(r){return r._key===row._key?row:r;});});state.selectedKeys={};rc4RenderFromCache();toast(updated.length+" sources updated");}).catch(function(e){toast(e.message,"error");state.allRows=[];return loadPage(false);}).then(function(){setPending(false);});
        });
    };

    startAutoRefresh = function(){window.clearInterval(autoRefreshTimer);autoRefreshTimer=window.setInterval(function(){if(document.hidden||state.pending||state.selected)return;state.allRows=[];loadPage(false);},60000);};

    function bindEvents() {
        var $root = $(ROOT);
        $root.on("input", "#lsw-search", function(){
            state.query = $(this).val(); window.clearTimeout(debounceTimer); debounceTimer=window.setTimeout(function(){ loadPage(true); }, 300);
        });
        $root.on("change", "#lsw-state-filter", function(){ state.stateFilter=$(this).val(); loadPage(true); });
        $root.on("change", "#lsw-life-filter", function(){ state.lifecycleFilter=$(this).val(); loadPage(true); });
        $root.on("change", "#lsw-index-filter", function(){ state.indexFilter=$(this).val(); loadPage(true); });
        $root.on("change", "#lsw-page-size", function(){ state.pageSize=Number($(this).val())||50; loadPage(true); });
        $root.on("change", "#lsw-check-all", function(){
            var on=$(this).prop("checked"); state.rows.forEach(function(r){ state.selectedKeys[r._key]=on; }); renderRows();
        });
        $root.on("change", ".lsw-row-check", function(e){ e.stopPropagation(); state.selectedKeys[$(this).data("key")]=$(this).prop("checked"); renderBulkBar(); });
        $root.on("click", ".lsw-source-row", function(e){ if($(e.target).is("input") || $(e.target).closest("button").length) return; openSource($(this).data("key")); });
        $root.on("click", ".lsw-host-link", function(e){ e.stopPropagation(); openSource($(this).data("key")); });
        $root.on("click", "th[data-sort]", function(){
            var f=$(this).data("sort"); if(state.sortField===f) state.sortDir=state.sortDir==="asc"?"desc":"asc"; else {state.sortField=f; state.sortDir="asc";} loadPage(false);
        });
        $root.on("click", "[data-action=refresh]", function(){ state.allRows=[]; loadPage(false); });
        $root.on("click", "[data-action=reset-filters]", function(){
            state.query=""; state.stateFilter="*"; state.lifecycleFilter="*"; state.indexFilter="*"; state.page=1;
            $("#lsw-search").val(""); $("#lsw-state-filter,#lsw-life-filter,#lsw-index-filter").val("*"); loadPage(true);
        });
        $root.on("click", "[data-action=prev-page]", function(){ if(state.page>1){state.page--;loadPage(false);} });
        $root.on("click", "[data-action=next-page]", function(){ if(state.page*state.pageSize<state.total){state.page++;loadPage(false);} });
        $root.on("click", "[data-action=clear-selection]", function(){ state.selectedKeys={}; renderRows(); });
        $root.on("click", "[data-kpi]", function(){
            var k=$(this).data("kpi"); var map={"Silent":"SILENT","Maintenance":"MAINTENANCE","No log observation":"NO LOG OBSERVATION","Retired":"RETIRED"};
            state.stateFilter=map[k]||"*"; $("#lsw-state-filter").val(state.stateFilter); loadPage(true);
        });
        $root.on("click", "[data-bulk]", function(){ var a=$(this).data("bulk"); doBulk(a, a==="maintenance"?3600:0); });

        $(document).on("click.lswmanage", "#lsw-drawer [data-action=close-drawer], #lsw-drawer-backdrop", function(){ closeDrawer(); });
        $(document).on("click.lswmanage", "#lsw-drawer [data-action=save-threshold]", function(){
            var v=Number($("#lsw-threshold-input").val()); if(!isFinite(v) || v<1 || v>10080 || Math.floor(v)!==v){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return;} mutateSelected("threshold",v,"Threshold updated");
        });
        $(document).on("click.lswmanage", "#lsw-drawer [data-action=activate-source]", function(){ mutateSelected("activate",0,"Source activated"); });
        $(document).on("click.lswmanage", "#lsw-drawer [data-action=retire-source]", function(){
            if(!state.selected) return; var host=state.selected.host;
            modal("Retire "+host+"?",'<p>The source stays in history but is removed from active silence monitoring. You can activate it again later.</p>',"Retire source",true).then(function(ok){if(ok)mutateSelected("retire",0,host+" retired");});
        });
        $(document).on("click.lswmanage", "#lsw-drawer [data-maintenance]", function(){ var secs=Number($(this).data("maintenance")); mutateSelected("maintenance",secs,"Maintenance enabled"); });
        $(document).on("click.lswmanage", "#lsw-drawer [data-action=clear-maintenance]", function(){ mutateSelected("clear_maintenance",0,"Maintenance cleared"); });

        $(document).on("keydown.lswmanage", function(e){
            if(e.key==="Escape"){ if(!$("#lsw-modal").attr("hidden")) return; closeDrawer(); }
            if(e.key==="/" && !$(e.target).is("input,textarea,select")){ e.preventDefault(); $("#lsw-search").trigger("focus"); }
        });
    }

    function startAutoRefresh() {
        window.clearInterval(autoRefreshTimer);
        autoRefreshTimer=window.setInterval(function(){
            if(document.hidden || state.pending || state.selected) return;
            Promise.all([loadPage(false),loadStats()]);
        },60000);
    }

    function fatalBoot(err) {
        var msg=err&&err.message?err.message:String(err||"Unknown error");
        try { $(ROOT).html('<div class="lsw-boot-card lsw-boot-error"><div><strong>Manage Sources could not start</strong><span>'+escHtml(msg)+'</span></div></div>'); } catch(e) {}
        if(window.console&&console.error) console.error("Log Source Watch Manage bootstrap failed",err);
    }
    function bootstrap() {
        renderShell(); bindEvents(); renderLoadingRows();
        loadUsername();
        loadPage(true).then(function(){ startAutoRefresh(); });
    }

    try { bootstrap(); } catch(e) { fatalBoot(e); }
});
