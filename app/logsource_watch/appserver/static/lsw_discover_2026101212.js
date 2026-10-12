/* Log Source Watch - Premium Source Discovery Workspace
 * Discovery is operator-driven. No raw-event scan runs until the user requests it.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/searchmanager",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
    "use strict";

    var ROOT = "#lsw-discover-root";
    var APP = "logsource_watch";
    var MAX_ENROLL = 10000;
    var PAGE_SIZE = 50;
    var seq = 0;

    var state = {
        indexes: [], index: "", earliest: "-24h", thresholdMinutes: 120,
        query: "", page: 1, total: 0, rows: [], selected: {}, username: "unknown",
        searched: false, pending: false, generation: 0, discoveredByKey: {}
    };
    var allowedEarliest = {"-1h":1,"-6h":1,"-24h":1,"-7d":1,"-30d":1};

    function escHtml(v){return String(v===null||v===undefined?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
    function spl(v){return String(v===null||v===undefined?"":v).replace(/[\x00-\x1f\x7f]/g," ").replace(/\\/g,"\\\\").replace(/\"/g,'\\"');}
    function clamp(v,n){return String(v||"").replace(/[\x00-\x1f\x7f]/g," ").trim().slice(0,n||128);}
    function safeKey(k){return /^[a-f0-9]{64}$/i.test(String(k||""));}
    function rowsFromPayload(p){if(!p)return[];if(p.results&&$.isArray(p.results))return p.results;var f=p.fields||[],r=p.rows||[];if(!r.length)return[];var names=f.map(function(x){return typeof x==="string"?x:x.name;});return r.map(function(row){var o={};names.forEach(function(n,i){o[n]=row[i];});return o;});}
    function cleanupManager(id){setTimeout(function(){try{if(mvc.Components&&mvc.Components.revokeInstance)mvc.Components.revokeInstance(id);}catch(e){}},0);}
    function runSearch(search, timeoutMs) {
        timeoutMs = timeoutMs || 45000;
        return new Promise(function(resolve, reject) {
            var id = "lsw_discover_" + Date.now() + "_" + (++seq);
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
                var detail = "";
                if (typeof message === "string") detail = message;
                else if (message && message.message) detail = message.message;
                else if (message && message.content && message.content.messages && message.content.messages[0]) detail = message.content.messages[0].text || JSON.stringify(message.content.messages[0]);
                else if (message && message.statusText) detail = message.statusText;
                else { try { detail = JSON.stringify(message || {}); } catch (e) { detail = String(message); } }
                finish(reject, new Error(prefix + (detail ? ": " + detail : "")));
            }

            function consume() {
                try {
                    if (results && results.hasData && results.hasData() && results.collection) {
                        var collectionRows = results.collection().toJSON();
                        finish(resolve, collectionRows || []);
                        return true;
                    }
                    var payload = results && results.data ? results.data() : null;
                    if (!payload) return false;
                    var rows = rowsFromPayload(payload);
                    var hasShape = ($.isArray(payload.results) || $.isArray(payload.rows));
                    if (rows.length || hasShape) { finish(resolve, rows); return true; }
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

                // Use the same JSON result model as the verified working Manage/Bulk workspaces.
                // This avoids the json_rows model stall seen in Source Discovery.
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


    /* Enrollment data plane.
     * Discovery remains a read-only Splunk search. Enrollment itself writes
     * directly to the app KV Store, matching the proven Manage/Bulk model.
     */
    var kvService = mvc.createService({ owner: "nobody", app: APP });

    function kvError(v) {
        if (!v) return "Unknown KV Store error";
        if (typeof v === "string") return v;
        if (v.message) return String(v.message);
        if (v.statusText) return String(v.statusText);
        if (v.responseText) {
            try {
                var p = JSON.parse(v.responseText);
                if (p && p.messages && p.messages[0]) return p.messages[0].text || JSON.stringify(p.messages[0]);
                return JSON.stringify(p);
            } catch (e) { return String(v.responseText).slice(0, 500); }
        }
        try { return JSON.stringify(v); } catch (e2) { return String(v); }
    }

    function kvBatchSave(collection, documents) {
        if (!documents.length) return Promise.resolve([]);
        return new Promise(function(resolve, reject) {
            kvService.request(
                "storage/collections/data/" + collection + "/batch_save",
                "POST", null, null, JSON.stringify(documents),
                {"Content-Type":"application/json"}, null
            ).done(function(data) {
                try { resolve(typeof data === "string" ? JSON.parse(data) : data); }
                catch (e) { resolve(data); }
            }).fail(function(err) {
                reject(new Error(collection + ": " + kvError(err)));
            });
        });
    }

    function nowEpoch() { return Math.floor(Date.now()/1000); }

    function stateForEnrollment(candidate, inventory, lastseen) {
        var now = nowEpoch();
        var threshold = Number(inventory.threshold_seconds || 7200);
        var last = Number(lastseen.last_seen);
        var age = isFinite(last) ? Math.max(0, now-last) : null;
        var effective = age === null ? "NO LOG OBSERVATION" : (age > threshold ? "SILENT" : "OK");
        return {
            _key: inventory._key,
            index: inventory.index,
            host: inventory.host,
            status: "active",
            threshold_seconds: threshold,
            threshold_minutes: Math.round(threshold/60),
            maintenance_until: 0,
            change_ref: inventory.change_ref,
            last_seen: isFinite(last) ? last : null,
            lastseen_updated_at: lastseen.updated_at,
            age_seconds: age,
            age_minutes: age === null ? null : Math.round(age/6)/10,
            effective_state: effective,
            alarm: effective === "SILENT" ? 1 : 0,
            state_updated_at: now
        };
    }

    function enrollmentDocuments(candidates) {
        var minutes = Number(state.thresholdMinutes);
        if (!isFinite(minutes) || minutes < 1 || minutes > 10080 || Math.floor(minutes)!==minutes) throw new Error("Threshold must be a whole number between 1 and 10080 minutes");
        var threshold = minutes*60;
        var now = nowEpoch();
        var inventory = [], lastseen = [], states = [], audits = [];

        candidates.forEach(function(c) {
            if (!c || !safeKey(c._key) || !c.index || !c.host) return;
            var seen = Number(c.observed_last_seen);
            var inv = {
                _key: c._key,
                index: String(c.index),
                host: String(c.host),
                status: "active",
                threshold_seconds: threshold,
                maintenance_until: 0,
                change_ref: "ui-discovery-enroll",
                created_at: now,
                updated_at: now
            };
            var ls = {
                _key: c._key,
                index: String(c.index),
                host: String(c.host),
                last_seen: isFinite(seen) ? seen : now,
                updated_at: now
            };
            inventory.push(inv);
            lastseen.push(ls);
            states.push(stateForEnrollment(c, inv, ls));
            audits.push({
                event_time_epoch: now,
                actor: state.username || "unknown",
                scope: "enrollment",
                operation: "source_enrolled",
                index: String(c.index),
                host: String(c.host),
                old_status: "",
                new_status: "active",
                old_threshold_seconds: 0,
                new_threshold_seconds: threshold,
                old_maintenance_until: 0,
                new_maintenance_until: 0,
                change_ref: "ui-discovery-enroll",
                details: "Source enrolled from discovery"
            });
        });

        return {inventory:inventory, lastseen:lastseen, states:states, audits:audits};
    }

    function writeEnrollment(candidates) {
        if (!candidates.length) return Promise.reject(new Error("No sources selected for enrollment"));
        if (candidates.length > MAX_ENROLL) return Promise.reject(new Error("Enrollment exceeds the "+MAX_ENROLL.toLocaleString()+" source safety limit"));
        var docs = enrollmentDocuments(candidates);
        if (!docs.inventory.length) return Promise.reject(new Error("No valid sources selected for enrollment"));

        // Inventory is authoritative. The other collections are immediate derived
        // state/audit data and the scheduled jobs will reconcile runtime state again.
        return kvBatchSave("lsw_inventory", docs.inventory)
            .then(function(){ return kvBatchSave("lsw_lastseen", docs.lastseen); })
            .then(function(){ return kvBatchSave("lsw_state", docs.states); })
            .then(function(){ return kvBatchSave("lsw_audit", docs.audits); })
            .then(function(){ return docs.inventory.length; });
    }

    function viewHref(view){return window.location.pathname.replace(/\/[^/]+\/?$/, "/"+view);}
    function workspaceNav(active){var items=[["manage_hosts","Sources","sources"],["bulk_management","Bulk Actions","bulk"],["add_log_sources","Discover","discover"],["initial_setup","Initial Setup","setup"]];return '<nav class="lsw-workspace-tabs" aria-label="Source management">'+items.map(function(i){return '<a class="lsw-workspace-tab '+(active===i[2]?'active':'')+'" href="'+escHtml(viewHref(i[0]))+'">'+escHtml(i[1])+'</a>';}).join("")+'</nav>';}
    function usernameQuery(){return '| rest /services/authentication/current-context | head 1 | fields username';}
    function licenseStatusQuery(){return '| lswlicense | appendcols [ | inputlookup lsw_inventory | where status="active" OR status="maintenance" | stats count AS monitored_sources ] | eval monitored_sources=coalesce(monitored_sources,0) | fields license_status license_valid edition customer license_id max_monitored_sources shc_allowed deployment_compliant monitored_sources message expires_at';}
    function communityLicenseFallback(increment){
        var current=0;
        try{current=Object.keys(state.inventoryByKey||{}).filter(function(k){var s=String((state.inventoryByKey[k]||{}).status||"active").toLowerCase();return s==="active"||s==="maintenance";}).length;}catch(e){current=0;}
        var max=100,projected=current+Math.max(0,Number(increment||0));
        if(projected>max)throw new Error("Community Edition capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but Community permits 100. Retired sources do not count toward capacity.");
        return {edition:"Community",current:current,max:max,projected:projected,message:"Community fallback active",runtime_fallback:true};
    }
    function assertLicenseCapacity(increment){
        increment=Math.max(0,Number(increment||0));
        return runSearch(licenseStatusQuery(),30000).then(function(rows){
            var x=rows&&rows[0]?rows[0]:{};
            var compliant=Number(x.deployment_compliant===undefined?1:x.deployment_compliant);
            if(compliant!==1)throw new Error(x.message||"Current deployment is not permitted by the active Log Source Watch license");
            if(String(x.license_status||"").toUpperCase()==="EXPIRED")throw new Error(x.message||"Paid Log Source Watch license has expired. Existing monitoring continues, but monitored-source capacity cannot be increased until renewal.");var current=Math.max(0,Number(x.monitored_sources||0)),max=Number(x.max_monitored_sources||100),projected=current+increment;
            if(max>0&&projected>max)throw new Error("License capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but "+(x.edition||"Community")+" permits "+max.toLocaleString()+". Retired sources do not count toward capacity.");
            return {edition:x.edition||"Community",current:current,max:max,projected:projected,message:x.message||"",runtime_fallback:false};
        }).catch(function(err){
            var m=String((err&&err.message)||err||"");
            if(/unknown search command/i.test(m)){
                return runSearch('| inputlookup lsw_inventory | where status="active" OR status="maintenance" | stats count AS monitored_sources',15000).then(function(rows){
                    var current=Math.max(0,Number(rows&&rows[0]&&rows[0].monitored_sources||0)),max=100,projected=current+increment;
                    if(projected>max)throw new Error("Community Edition capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but Community permits 100. Retired sources do not count toward capacity.");
                    return {edition:"Community",current:current,max:max,projected:projected,message:"Community fallback active",runtime_fallback:true};
                });
            }
            throw err;
        });
    }
    function indexesQuery(){return '| eventcount summarize=false index=* | stats sum(count) AS events BY index | where index!="_internal" AND index!="_audit" AND index!="_introspection" | sort 0 index | fields index events';}
    function validatedEarliest(){return allowedEarliest[state.earliest]?state.earliest:"-24h";}
    function discoveryBase(){
        if(!state.index)throw new Error("Select an index first");
        var q=clamp(state.query,128).toLowerCase().replace(/[%_]/g,"");
        var filter=q?' | where like(lower(host),"%'+spl(q)+'%")':'';
        return '| tstats latest(_time) AS observed_last_seen count AS events WHERE index="'+spl(state.index)+'" earliest='+validatedEarliest()+' latest=now BY index host'+
          ' | where len(host)>0 AND len(host)<=255 AND NOT match(host,"[\\x00-\\x1F\\x7F*?]") | eval _key=sha256(index."|".host)'+
          ' | lookup local=true lsw_inventory _key OUTPUT status AS existing_status | where isnull(existing_status)'+filter;
    }
    function countQuery(){return discoveryBase()+' | stats count AS total';}
    function allCandidatesQuery(){return discoveryBase()+' | sort 0 index host | head '+(MAX_ENROLL+1)+' | table _key index host observed_last_seen events';}
    function pageQuery(){var off=(state.page-1)*PAGE_SIZE,max=off+PAGE_SIZE;return discoveryBase()+' | eval last_seen_display=strftime(observed_last_seen,"%Y-%m-%d %H:%M:%S") | sort 0 host | head '+max+' | tail '+PAGE_SIZE+' | table _key index host observed_last_seen last_seen_display events';}

    function renderShell(){
        $(ROOT).html('<div class="lsw-workspace">'+
          '<header class="lsw-workspace-header"><div class="lsw-header-copy"><div class="lsw-eyebrow">LOG SOURCE WATCH</div><h1>Discover Sources</h1><p>Find new index + host pairs, review them, and enroll only what belongs in monitoring.</p></div><div class="lsw-header-actions"><div class="lsw-live-indicator lsw-live-idle"><span></span>Operator-driven discovery</div></div></header>'+workspaceNav("discover")+
          '<section class="lsw-discovery-config lsw-premium-card"><div class="lsw-card-head"><div><span class="lsw-step">1</span><h2>Discovery scope</h2><p>No event search is dispatched until you press Discover.</p></div></div><div class="lsw-config-grid">'+
            '<label><span>Index</span><select id="lsw-discover-index" class="lsw-select lsw-select-full"><option value="">Select index</option></select></label>'+
            '<label><span>Lookback</span><select id="lsw-discover-earliest" class="lsw-select lsw-select-full"><option value="-1h">Last 1 hour</option><option value="-6h">Last 6 hours</option><option value="-24h" selected>Last 24 hours</option><option value="-7d">Last 7 days</option><option value="-30d">Last 30 days (heavy)</option></select></label>'+
            '<label><span>Default threshold</span><div class="lsw-inline-control"><input id="lsw-discover-threshold" type="number" min="1" max="10080" step="1" inputmode="numeric" value="120"/><span>minutes</span></div></label>'+
            '<div class="lsw-config-action"><button id="lsw-discover-run" class="lsw-btn lsw-btn-primary" data-action="discover">Discover new sources</button></div>'+
          '</div></section>'+
          '<section id="lsw-discovery-results" class="lsw-premium-card lsw-discovery-results"><div class="lsw-card-head"><div><span class="lsw-step">2</span><h2>Review new sources</h2><p id="lsw-discover-subtitle">Run discovery to compare observed sources with the monitoring inventory.</p></div><strong id="lsw-discover-count" class="lsw-scope-count">—</strong></div>'+ 
            '<div class="lsw-toolbar lsw-toolbar-card"><div class="lsw-search-wrap"><span class="lsw-search-icon">⌕</span><input id="lsw-discover-search" class="lsw-search" type="search" placeholder="Filter discovered hosts…" autocomplete="off" disabled/></div><button class="lsw-btn lsw-btn-ghost" data-action="filter" disabled>Apply filter</button><button class="lsw-btn lsw-btn-ghost" data-action="clear-selection" disabled>Clear selection</button></div>'+ 
            '<div class="lsw-table-scroll"><table class="lsw-table"><thead><tr><th class="lsw-check-col"><input id="lsw-discover-all-visible" type="checkbox" disabled/></th><th>Host</th><th>Index</th><th>Last seen</th><th>Events</th><th>Registration</th></tr></thead><tbody id="lsw-discover-body"><tr><td colspan="6"><div class="lsw-empty"><strong>Ready to discover</strong><span>Select an index and start an operator-driven scan.</span></div></td></tr></tbody></table></div>'+ 
            '<div class="lsw-pagination"><span id="lsw-discover-page"></span><div><button class="lsw-btn lsw-btn-ghost" data-action="prev" disabled>← Previous</button><button class="lsw-btn lsw-btn-ghost" data-action="next" disabled>Next →</button></div></div>'+ 
          '</section>'+ 
          '<div id="lsw-discover-bulkbar" class="lsw-bulkbar" hidden></div>'+ 
        '</div><div id="lsw-modal-backdrop" class="lsw-modal-backdrop" hidden></div><div id="lsw-modal" class="lsw-modal" role="dialog" aria-modal="true" hidden></div><div id="lsw-toasts" class="lsw-toasts" aria-live="assertive"></div>');
    }
    function renderIndexes(){var $s=$("#lsw-discover-index"),cur=state.index;$s.find('option:not(:first)').remove();state.indexes.forEach(function(i){$s.append('<option value="'+escHtml(i.index)+'">'+escHtml(i.index)+' ('+Number(i.events||0).toLocaleString()+' events)</option>');});$s.val(cur);}
    function renderRows(){
        var $b=$("#lsw-discover-body");
        if(!state.searched){return;}
        if(!state.rows.length){$b.html('<tr><td colspan="6"><div class="lsw-empty"><strong>No new sources found</strong><span>Everything observed in this scope is already registered, or the filter matches nothing.</span></div></td></tr>');}
        else{$b.html(state.rows.map(function(r){var c=state.selected[r._key]?" checked":"";return '<tr class="lsw-source-row"><td class="lsw-check-col"><input class="lsw-discover-check" data-key="'+escHtml(r._key)+'" type="checkbox"'+c+' aria-label="Select '+escHtml(r.host)+'"/></td><td><strong>'+escHtml(r.host)+'</strong></td><td><span class="lsw-mono">'+escHtml(r.index)+'</span></td><td class="lsw-dim">'+escHtml(r.last_seen_display)+'</td><td>'+Number(r.events||0).toLocaleString()+'</td><td><span class="lsw-state-pill nolog"><i></i>NEW</span></td></tr>';}).join(""));}
        var max=Math.max(1,Math.ceil(state.total/PAGE_SIZE));$("#lsw-discover-count").text(state.total.toLocaleString()+" new");$("#lsw-discover-page").text("Page "+state.page+" of "+max);$("[data-action=prev]").prop("disabled",state.pending||state.page<=1);$("[data-action=next]").prop("disabled",state.pending||state.page>=max);$("#lsw-discover-all-visible").prop("disabled",state.pending||!state.rows.length).prop("checked",state.rows.length>0&&state.rows.every(function(r){return !!state.selected[r._key];}));renderEnrollBar();
    }
    function renderEnrollBar(){var n=Object.keys(state.selected).filter(function(k){return state.selected[k];}).length,$b=$("#lsw-discover-bulkbar");if(!state.searched||state.total===0){$b.attr("hidden",true).empty();return;}var allDisabled=state.total>MAX_ENROLL?' disabled':'';$b.removeAttr("hidden").html('<div><strong>'+n+' selected</strong><span>'+state.total.toLocaleString()+' new sources in current discovery scope</span></div><div class="lsw-bulk-actions"><button class="lsw-btn lsw-btn-ghost" data-action="enroll-selected"'+(n?'':' disabled')+'>Enroll selected</button><button class="lsw-btn lsw-btn-primary" data-action="enroll-all"'+allDisabled+'>Enroll all '+state.total.toLocaleString()+'</button></div>');}
    function setPending(on){state.pending=!!on;$(ROOT).toggleClass("lsw-pending",state.pending);$("#lsw-discover-run").prop("disabled",state.pending);renderRows();}
    function toast(message,type){type=type||"success";var id="t_"+Date.now()+"_"+(++seq),$t=$('<div class="lsw-toast '+type+'" id="'+id+'"><span class="lsw-toast-icon">'+(type==="error"?"!":"✓")+'</span><div>'+escHtml(message)+'</div></div>');$("#lsw-toasts").append($t);setTimeout(function(){$t.addClass("show");},10);setTimeout(function(){$t.removeClass("show");setTimeout(function(){$t.remove();},250);},4500);}
    function modal(title,body,label){return new Promise(function(resolve){var $m=$("#lsw-modal");$("#lsw-modal-backdrop").removeAttr("hidden");$m.removeAttr("hidden").html('<div class="lsw-modal-head"><h3>'+escHtml(title)+'</h3></div><div class="lsw-modal-body">'+body+'</div><div class="lsw-modal-actions"><button class="lsw-btn lsw-btn-ghost" data-modal="cancel">Cancel</button><button class="lsw-btn lsw-btn-primary" data-modal="confirm">'+escHtml(label||"Enroll")+'</button></div>');function close(v){$(document).off("click.lswdiscovermodal");$("#lsw-modal-backdrop").attr("hidden",true);$m.attr("hidden",true).empty();resolve(v);}$(document).on("click.lswdiscovermodal",'[data-modal="cancel"]',function(){close(false);});$(document).on("click.lswdiscovermodal",'[data-modal="confirm"]',function(){close(true);});});}
    function loadIndexes(){return runSearch(indexesQuery()).then(function(r){state.indexes=r||[];renderIndexes();}).catch(function(e){toast("Could not load indexes: "+e.message,"error");});}
    function loadUsername(){return runSearch(usernameQuery()).then(function(r){if(r[0]&&r[0].username)state.username=r[0].username;}).catch(function(){});}
    function discover(resetPage){
        if(!state.index){toast("Select an index first","error");return Promise.resolve();}
        var tm=Number(state.thresholdMinutes);if(!isFinite(tm)||tm<1||tm>10080||Math.floor(tm)!==tm){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return Promise.resolve();}
        if(resetPage)state.page=1;state.searched=true;var g=++state.generation;setPending(true);$("#lsw-discover-body").html('<tr class="lsw-skeleton-row"><td colspan="6"><div class="lsw-skeleton"></div></td></tr>');$("#lsw-discover-subtitle").text("Scanning "+state.index+" over "+validatedEarliest()+" and comparing with inventory…");
        return Promise.all([runSearch(countQuery(),90000),runSearch(pageQuery(),90000)]).then(function(result){if(g!==state.generation)return;var countRows=result[0]||[],rows=result[1]||[];state.total=countRows[0]?Number(countRows[0].total||0):0;if((!rows.length)&&state.page>1&&state.total>0){state.page=1;setPending(false);return discover(false);}state.rows=rows;rows.forEach(function(x){if(x&&safeKey(x._key))state.discoveredByKey[x._key]=x;});$("#lsw-discover-subtitle").text(state.total?"Only index + host pairs missing from the monitoring inventory are shown.":"No new sources found in this discovery scope.");$("#lsw-discover-search,[data-action=filter],[data-action=clear-selection]").prop("disabled",false);renderRows();}).catch(function(e){if(g!==state.generation)return;state.total=0;state.rows=[];$("#lsw-discover-subtitle").text("Discovery failed: "+e.message);renderRows();toast(e.message,"error");}).then(function(){setPending(false);});
    }
    function selectedCandidates(keys) {
        return keys.filter(safeKey).map(function(k){ return state.discoveredByKey[k]; }).filter(function(x){ return !!x; });
    }

    function enroll(all) {
        if (state.pending || !state.searched) return;
        var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
        var requested = all ? state.total : keys.length;
        if (!requested) return;
        if (requested > MAX_ENROLL) {
            toast("Discovery scope exceeds the "+MAX_ENROLL.toLocaleString()+" source safety limit","error");
            return;
        }

        var candidatesPromise;
        if (all) {
            candidatesPromise = runSearch(allCandidatesQuery(), 90000).then(function(rows) {
                rows = rows || [];
                if (rows.length > MAX_ENROLL) throw new Error("Discovery scope exceeds the "+MAX_ENROLL.toLocaleString()+" source safety limit");
                if (!rows.length) throw new Error("No new sources remain in this discovery scope");
                rows.forEach(function(x){ if(x && safeKey(x._key)) state.discoveredByKey[x._key]=x; });
                return rows;
            });
        } else {
            var selected = selectedCandidates(keys);
            if (selected.length !== keys.length) {
                candidatesPromise = runSearch(allCandidatesQuery(), 90000).then(function(rows) {
                    rows = rows || [];
                    rows.forEach(function(x){ if(x && safeKey(x._key)) state.discoveredByKey[x._key]=x; });
                    var refreshed = selectedCandidates(keys);
                    if (!refreshed.length) throw new Error("Selected sources are no longer available for enrollment");
                    return refreshed;
                });
            } else {
                candidatesPromise = Promise.resolve(selected);
            }
        }

        setPending(true);
        candidatesPromise.then(function(candidates) {
            return assertLicenseCapacity(candidates.length).then(function(license){return {candidates:candidates,license:license};});
        }).then(function(ctx) {
            setPending(false);
            var candidates=ctx.candidates,license=ctx.license;
            var text = all
                ? "Enroll all "+candidates.length.toLocaleString()+" new sources?"
                : "Enroll "+candidates.length.toLocaleString()+" selected sources?";
            var cap=license.max<=0?"Unlimited":license.max.toLocaleString();
            return modal(
                text,
                '<p>Sources are registered as ACTIVE with a '+Number(state.thresholdMinutes).toLocaleString()+
                ' minute silence threshold. Inventory, last_seen, canonical state and audit are written immediately.</p>'+
                '<p><b>License:</b> '+escHtml(license.edition)+' · projected usage '+license.projected.toLocaleString()+' / '+escHtml(cap)+'</p>',
                "Enroll sources"
            ).then(function(ok){ return {ok:ok,candidates:candidates}; });
        }).then(function(ctx) {
            if (!ctx || !ctx.ok) return;
            setPending(true);
            return writeEnrollment(ctx.candidates).then(function(n) {
                toast(n.toLocaleString()+" sources enrolled");
                state.selected = {};
                state.discoveredByKey = {};
                return discover(true);
            });
        }).catch(function(e) {
            toast(e.message || String(e), "error");
        }).then(function() {
            setPending(false);
        });
    }

    function bind(){var $r=$(ROOT);$r.on("change","#lsw-discover-index",function(){state.index=$(this).val();state.searched=false;state.rows=[];state.total=0;state.selected={};});$r.on("change","#lsw-discover-earliest",function(){state.earliest=$(this).val();});$r.on("input","#lsw-discover-threshold",function(){state.thresholdMinutes=Number($(this).val());});$r.on("input","#lsw-discover-search",function(){state.query=$(this).val();});$r.on("click",'[data-action="discover"]',function(){state.index=$("#lsw-discover-index").val()||"";state.earliest=$("#lsw-discover-earliest").val()||"-24h";state.thresholdMinutes=Number($("#lsw-discover-threshold").val());state.query="";$("#lsw-discover-search").val("");state.selected={};discover(true);});$r.on("click",'[data-action="filter"]',function(){state.index=$("#lsw-discover-index").val()||state.index;state.earliest=$("#lsw-discover-earliest").val()||state.earliest;state.selected={};discover(true);});$r.on("click",'[data-action="prev"]',function(){if(state.page>1){state.page--;discover(false);}});$r.on("click",'[data-action="next"]',function(){if(state.page*PAGE_SIZE<state.total){state.page++;discover(false);}});$r.on("change",".lsw-discover-check",function(){state.selected[$(this).data("key")]=$(this).prop("checked");renderEnrollBar();});$r.on("change","#lsw-discover-all-visible",function(){var on=$(this).prop("checked");state.rows.forEach(function(x){state.selected[x._key]=on;});renderRows();});$r.on("click",'[data-action="clear-selection"]',function(){state.selected={};renderRows();});$r.on("click",'[data-action="enroll-selected"]',function(){enroll(false);});$r.on("click",'[data-action="enroll-all"]',function(){enroll(true);});}
    function fatalBoot(err){var msg=err&&err.message?err.message:String(err||"Unknown error");try{$(ROOT).html('<div class="lsw-boot-card lsw-boot-error"><div><strong>Discover Sources could not start</strong><span>'+escHtml(msg)+'</span></div></div>');}catch(e){}if(window.console&&console.error)console.error("Log Source Watch Discover bootstrap failed",err);}
    function bootstrap(){renderShell();bind();loadUsername();loadIndexes();}
    try{bootstrap();}catch(e){fatalBoot(e);}
});
