/* Log Source Watch - Premium Bulk Actions Workspace
 * Short-lived searches only. No page reloads and no long-lived state snapshot.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/searchmanager",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
    "use strict";

    var ROOT = "#lsw-bulk-root";
    var APP = "logsource_watch";
    var MAX_BULK = 10000;
    var seq = 0;
    var debounceTimer = null;

    var state = {
        query: "",
        stateFilter: "*",
        lifecycleFilter: "*",
        indexFilter: "*",
        indexes: [],
        total: 0,
        preview: [],
        username: "unknown",
        action: "threshold",
        thresholdMinutes: 120,
        maintenanceSeconds: 3600,
        pending: false,
        generation: 0,
        lastRefresh: null
    };

    function escHtml(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function spl(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
    }
    function clampText(value, max) {
        return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max || 128);
    }
    function rowsFromPayload(payload) {
        if (!payload) return [];
        if (payload.results && $.isArray(payload.results)) return payload.results;
        var fields = payload.fields || [], rows = payload.rows || [];
        if (!rows.length) return [];
        var names = fields.map(function(f) { return typeof f === "string" ? f : f.name; });
        return rows.map(function(row) {
            var out = {}; names.forEach(function(name, i) { out[name] = row[i]; }); return out;
        });
    }
    function cleanupManager(id) {
        window.setTimeout(function() {
            try { if (mvc.Components && mvc.Components.revokeInstance) mvc.Components.revokeInstance(id); } catch (e) {}
        }, 0);
    }
    function runSearch(search, timeoutMs) {
        timeoutMs = timeoutMs || 35000;
        return new Promise(function(resolve, reject) {
            var id = "lsw_bulk_" + Date.now() + "_" + (++seq);
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
        return '<nav class="lsw-workspace-tabs" aria-label="Source management">' + items.map(function(i){
            return '<a class="lsw-workspace-tab '+(active===i[2]?'active':'')+'" href="'+escHtml(viewHref(i[0]))+'">'+escHtml(i[1])+'</a>';
        }).join("") + '</nav>';
    }
    function stateEval() {
        return '| eval display_state=effective_state';
    }
    function managementBase() {
        return '| inputlookup lsw_inventory' +
            ' | lookup local=true lsw_lastseen _key OUTPUT last_seen updated_at AS lastseen_updated_at' +
            ' | `lsw_calculate_state` ' + stateEval();
    }
    function filterPipe() {
        var parts = [], q = clampText(state.query,128).toLowerCase().replace(/[%_]/g,"");
        if (q) parts.push('(like(lower(host),"%'+spl(q)+'%") OR like(lower(index),"%'+spl(q)+'%"))');
        if (state.stateFilter !== "*") parts.push('display_state="'+spl(state.stateFilter)+'"');
        if (state.lifecycleFilter !== "*") parts.push('status="'+spl(state.lifecycleFilter)+'"');
        if (state.indexFilter !== "*") parts.push('index="'+spl(state.indexFilter)+'"');
        return parts.length ? ' | where ' + parts.join(' AND ') : '';
    }
    function previewQuery() {
        return managementBase() + filterPipe() +
            ' | eventstats count AS __total' +
            ' | eval lifecycle=upper(status),threshold_minutes=round(coalesce(threshold_seconds,7200)/60,0),last_seen_display=if(isnull(last_seen),"—",strftime(last_seen,"%Y-%m-%d %H:%M:%S"))' +
            ' | sort 0 index host | head 25 | table index host display_state lifecycle threshold_minutes last_seen_display __total';
    }
    function indexesQuery() { return '| inputlookup lsw_inventory | stats count AS sources BY index | sort 0 index'; }

    function renderShell() {
        $(ROOT).html(
          '<div class="lsw-workspace">'+
            '<header class="lsw-workspace-header"><div class="lsw-header-copy"><div class="lsw-eyebrow">LOG SOURCE WATCH</div><h1>Bulk Actions</h1><p>Apply one policy change to a precisely filtered source scope with a hard safety limit.</p></div><div class="lsw-header-actions"><div class="lsw-live-indicator"><span></span>Live scope</div><button class="lsw-btn lsw-btn-secondary" data-action="refresh">↻ Refresh</button></div></header>'+
            workspaceNav("bulk")+
            '<section class="lsw-bulk-layout">'+
              '<div class="lsw-bulk-main">'+
                '<section class="lsw-premium-card"><div class="lsw-card-head"><div><span class="lsw-step">1</span><h2>Define scope</h2><p>Only matching sources are changed. Preview the scope before applying an action.</p></div><strong id="lsw-bulk-count" class="lsw-scope-count">0</strong></div>'+
                  '<div class="lsw-toolbar lsw-toolbar-card"><div class="lsw-search-wrap"><span class="lsw-search-icon">⌕</span><input id="lsw-bulk-search" class="lsw-search" type="search" placeholder="Filter host or index…" autocomplete="off"/></div><select id="lsw-bulk-state" class="lsw-select"><option value="*">All states</option><option>OK</option><option>SILENT</option><option>MAINTENANCE</option><option>NO LOG OBSERVATION</option><option>RETIRED</option></select><select id="lsw-bulk-life" class="lsw-select"><option value="*">All lifecycle</option><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="retired">Retired</option></select><select id="lsw-bulk-index" class="lsw-select"><option value="*">All indexes</option></select><button class="lsw-btn lsw-btn-ghost" data-action="reset">Reset</button></div>'+
                  '<div class="lsw-table-scroll lsw-preview-scroll"><table class="lsw-table"><thead><tr><th>State</th><th>Host</th><th>Index</th><th>Lifecycle</th><th>Threshold</th><th>Last seen</th></tr></thead><tbody id="lsw-bulk-preview"></tbody></table></div>'+
                '</section>'+
              '</div>'+
              '<aside class="lsw-bulk-side">'+
                '<section class="lsw-premium-card lsw-action-card"><div class="lsw-card-head"><div><span class="lsw-step">2</span><h2>Choose action</h2><p>One atomic policy operation is applied to the entire scope.</p></div></div>'+
                  '<div class="lsw-action-selector">'+
                    '<label class="lsw-action-option active"><input type="radio" name="lsw-bulk-action" value="threshold" checked/><span><strong>Silence threshold</strong><small>Change allowed silence duration.</small></span></label>'+
                    '<label class="lsw-action-option"><input type="radio" name="lsw-bulk-action" value="maintenance"/><span><strong>Start maintenance</strong><small>Suppress silence state temporarily.</small></span></label>'+
                    '<label class="lsw-action-option"><input type="radio" name="lsw-bulk-action" value="clear_maintenance"/><span><strong>End maintenance</strong><small>Return sources to ACTIVE.</small></span></label>'+
                    '<label class="lsw-action-option"><input type="radio" name="lsw-bulk-action" value="activate"/><span><strong>Activate</strong><small>Restore normal monitoring.</small></span></label>'+
                    '<label class="lsw-action-option danger"><input type="radio" name="lsw-bulk-action" value="retire"/><span><strong>Retire</strong><small>Remove sources from active monitoring.</small></span></label>'+
                  '</div>'+
                  '<div id="lsw-bulk-action-controls" class="lsw-action-controls"></div>'+
                  '<div id="lsw-bulk-safety" class="lsw-safety-note"></div>'+
                  '<button id="lsw-bulk-apply" class="lsw-btn lsw-btn-primary lsw-btn-wide" data-action="apply">Review &amp; apply</button>'+
                '</section>'+
              '</aside>'+
            '</section>'+
          '</div><div id="lsw-modal-backdrop" class="lsw-modal-backdrop" hidden></div><div id="lsw-modal" class="lsw-modal" role="dialog" aria-modal="true" hidden></div><div id="lsw-toasts" class="lsw-toasts" aria-live="assertive"></div>'
        );
    }

    function badgeClass(v) { v=String(v||"").toUpperCase(); if(v==="OK")return"ok"; if(v==="SILENT")return"silent"; if(v==="MAINTENANCE")return"maintenance"; if(v==="RETIRED")return"retired"; return"nolog"; }
    function renderIndexes() {
        var current=state.indexFilter,$s=$("#lsw-bulk-index"); $s.find('option:not([value="*"])').remove();
        state.indexes.forEach(function(i){$s.append('<option value="'+escHtml(i.index)+'">'+escHtml(i.index)+' ('+escHtml(i.sources)+')</option>');}); $s.val(current);
    }
    function renderPreview() {
        var $b=$("#lsw-bulk-preview");
        if(!state.preview.length){$b.html('<tr><td colspan="6"><div class="lsw-empty"><strong>No sources match this scope</strong><span>Adjust filters before applying an action.</span></div></td></tr>');}
        else {$b.html(state.preview.map(function(r){return '<tr><td><span class="lsw-state-pill '+badgeClass(r.display_state)+'"><i></i>'+escHtml(r.display_state)+'</span></td><td><strong>'+escHtml(r.host)+'</strong></td><td><span class="lsw-mono">'+escHtml(r.index)+'</span></td><td>'+escHtml(r.lifecycle)+'</td><td>'+escHtml(r.threshold_minutes)+' min</td><td class="lsw-dim">'+escHtml(r.last_seen_display)+'</td></tr>';}).join(""));}
        $("#lsw-bulk-count").text(Number(state.total||0).toLocaleString()+" sources");
        renderSafety();
    }
    function renderActionControls() {
        var h="";
        if(state.action==="threshold") h='<label class="lsw-control-label">New threshold</label><div class="lsw-inline-control"><input id="lsw-bulk-threshold" type="number" min="1" max="10080" step="1" inputmode="numeric" value="'+escHtml(state.thresholdMinutes)+'"/><span>minutes</span></div>';
        else if(state.action==="maintenance") h='<label class="lsw-control-label">Maintenance duration</label><select id="lsw-bulk-maintenance" class="lsw-select lsw-select-full"><option value="3600">1 hour</option><option value="28800">8 hours</option><option value="86400">24 hours</option><option value="0">Until cleared</option></select>';
        else h='<div class="lsw-action-summary">No additional value is required for this action.</div>';
        $("#lsw-bulk-action-controls").html(h); if(state.action==="maintenance") $("#lsw-bulk-maintenance").val(String(state.maintenanceSeconds));
    }
    function renderSafety() {
        var n=Number(state.total||0), text, cls="";
        if(n===0){text="No matching sources. Nothing will be changed.";cls="warn";}
        else if(n>MAX_BULK){text="Scope exceeds the hard safety limit of "+MAX_BULK.toLocaleString()+" sources. Narrow the filters.";cls="danger";}
        else{text=n.toLocaleString()+" sources will be affected. Inventory, canonical state and audit trail are updated in the same operation.";cls="ok";}
        $("#lsw-bulk-safety").attr("class","lsw-safety-note "+cls).text(text);
        $("#lsw-bulk-apply").prop("disabled",state.pending||n===0||n>MAX_BULK).text(state.pending?"Applying…":"Review & apply");
    }
    function setPending(on){state.pending=!!on;$(ROOT).toggleClass("lsw-pending",state.pending);$(ROOT).find("input,select,button").prop("disabled",state.pending);renderSafety();}
    function toast(message,type){type=type||"success";var id="t_"+Date.now()+"_"+(++seq),$t=$('<div class="lsw-toast '+type+'" id="'+id+'"><span class="lsw-toast-icon">'+(type==="error"?"!":"✓")+'</span><div>'+escHtml(message)+'</div></div>');$("#lsw-toasts").append($t);setTimeout(function(){$t.addClass("show");},10);setTimeout(function(){$t.removeClass("show");setTimeout(function(){$t.remove();},250);},4500);}
    function modal(title,body,label,danger){return new Promise(function(resolve){var $m=$("#lsw-modal");$("#lsw-modal-backdrop").removeAttr("hidden");$m.removeAttr("hidden").html('<div class="lsw-modal-head"><h3>'+escHtml(title)+'</h3></div><div class="lsw-modal-body">'+body+'</div><div class="lsw-modal-actions"><button class="lsw-btn lsw-btn-ghost" data-modal="cancel">Cancel</button><button class="lsw-btn '+(danger?'lsw-btn-danger':'lsw-btn-primary')+'" data-modal="confirm">'+escHtml(label||"Apply")+'</button></div>');function close(v){$(document).off("click.lswbulkmodal");$("#lsw-modal-backdrop").attr("hidden",true);$m.attr("hidden",true).empty();resolve(v);}$(document).on("click.lswbulkmodal",'[data-modal="cancel"]',function(){close(false);});$(document).on("click.lswbulkmodal",'[data-modal="confirm"]',function(){close(true);});});}

    function loadScope() {
        var g=++state.generation;
        $("#lsw-bulk-preview").html('<tr class="lsw-skeleton-row"><td colspan="6"><div class="lsw-skeleton"></div></td></tr>');
        return runSearch(previewQuery()).then(function(rows){
            if(g!==state.generation)return;
            state.preview=rows||[];
            state.total=state.preview[0]?Number(state.preview[0].__total||0):0;
            state.lastRefresh=new Date();
            renderPreview();
        }).catch(function(e){
            if(g!==state.generation)return;
            state.total=0;state.preview=[];renderPreview();toast(e.message,"error");
        });
    }
    function loadIndexes(){return runSearch(indexesQuery()).then(function(r){state.indexes=r||[];renderIndexes();}).catch(function(){});}
    function loadUsername(){return runSearch(usernameQuery()).then(function(r){if(r[0]&&r[0].username)state.username=r[0].username;}).catch(function(){});}

    function mutationSpec() {
        var mutate="", operation="source_update", detail="Bulk source policy updated";
        if(state.action==="threshold"){
            var m=Number(state.thresholdMinutes); if(!isFinite(m)||m<1||m>10080||Math.floor(m)!==m)throw new Error("Threshold must be a whole number between 1 and 10080 minutes");
            operation="threshold_change";detail="Bulk threshold changed to "+m+" minutes";mutate=' | eval threshold_seconds='+m*60+',updated_at=now(),change_ref="ui-bulk-threshold"';
        }else if(state.action==="maintenance"){
            var s=Number(state.maintenanceSeconds);if(!isFinite(s)||s<0||s>2592000)throw new Error("Invalid maintenance duration");
            operation="maintenance_set";detail=s===0?"Bulk maintenance enabled until cleared":"Bulk maintenance enabled for "+Math.round(s/3600)+" hours";mutate=' | eval status="maintenance",maintenance_until=if('+Math.round(s)+'=0,0,now()+'+Math.round(s)+'),updated_at=now(),change_ref="ui-bulk-maintenance"';
        }else if(state.action==="clear_maintenance"){
            operation="maintenance_set";detail="Bulk maintenance cleared";mutate=' | eval status="active",maintenance_until=0,updated_at=now(),change_ref="ui-bulk-maintenance-clear"';
        }else if(state.action==="activate"){
            operation="lifecycle_change";detail="Bulk lifecycle changed to active";mutate=' | eval status="active",maintenance_until=0,updated_at=now(),change_ref="ui-bulk-activate"';
        }else if(state.action==="retire"){
            operation="lifecycle_change";detail="Bulk lifecycle changed to retired";mutate=' | eval status="retired",maintenance_until=0,updated_at=now(),change_ref="ui-bulk-retire"';
        }else throw new Error("Unsupported bulk action");
        return {mutate:mutate,operation:operation,detail:detail};
    }
    function bulkMutationQuery() {
        var spec=mutationSpec(), actor=spl(state.username||"unknown");
        return '| inputlookup lsw_state '+stateEval()+filterPipe()+
          ' | head '+(MAX_BULK+1)+' | eventstats count AS lsw_candidate_count | where lsw_candidate_count<='+MAX_BULK+
          ' | fields _key index host | lookup local=true lsw_inventory _key OUTPUT status threshold_seconds maintenance_until change_ref created_at updated_at'+
          ' | where isnotnull(status) | eval audit_old_status=coalesce(status,"active"),audit_old_threshold_seconds=coalesce(threshold_seconds,7200),audit_old_maintenance_until=coalesce(maintenance_until,0)'+spec.mutate+
          ' | eval audit_new_status=status,audit_new_threshold_seconds=threshold_seconds,audit_new_maintenance_until=maintenance_until'+
          ' | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_inventory'+
          ' | appendpipe [ | eval event_time_epoch=now(),actor="'+actor+'",scope="bulk",operation="'+spl(spec.operation)+'",old_status=audit_old_status,new_status=audit_new_status,old_threshold_seconds=audit_old_threshold_seconds,new_threshold_seconds=audit_new_threshold_seconds,old_maintenance_until=audit_old_maintenance_until,new_maintenance_until=audit_new_maintenance_until,details="'+spl(spec.detail)+'" | eval _key=sha256(tostring(event_time_epoch)."|".actor."|".index."|".host."|".operation."|".tostring(random())) | fields _key event_time_epoch actor scope operation index host old_status new_status old_threshold_seconds new_threshold_seconds old_maintenance_until new_maintenance_until change_ref details | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_audit | where 1=0 ]'+
          ' | lsw_audit action=source_update source=bulk_management detail="'+spl(spec.detail)+'"'+
          ' | lookup local=true lsw_lastseen _key OUTPUT last_seen updated_at AS lastseen_updated_at | `lsw_calculate_state` | eval state_updated_at=now()'+
          ' | fields _key index host status threshold_seconds threshold_minutes maintenance_until change_ref last_seen lastseen_updated_at age_seconds age_minutes effective_state alarm state_updated_at'+
          ' | outputlookup append=true key_field=_key allow_updates=true override_if_empty=false lsw_state | stats count AS affected';
    }
    function reviewAndApply(){
        if(state.pending||state.total<=0||state.total>MAX_BULK)return;
        try{mutationSpec();}catch(e){toast(e.message,"error");return;}
        var actionLabel={threshold:"Change threshold",maintenance:"Start maintenance",clear_maintenance:"End maintenance",activate:"Activate sources",retire:"Retire sources"}[state.action]||"Apply action";
        var danger=state.action==="retire";
        modal(actionLabel+' for '+state.total.toLocaleString()+' sources?','<div class="lsw-confirm-summary"><strong>This is a bulk configuration change.</strong><p>The exact filtered scope will be re-evaluated when you confirm. A hard '+MAX_BULK.toLocaleString()+' source limit is enforced server-side.</p><p>Every changed source receives an audit record.</p></div>',danger?'Retire sources':'Apply change',danger).then(function(ok){
            if(!ok)return;setPending(true);
            runSearch(bulkMutationQuery(),90000).then(function(rows){var n=rows[0]?Number(rows[0].affected||0):0;if(!n)throw new Error("No sources were updated. The scope may have changed or exceeded the safety limit.");toast(n.toLocaleString()+" sources updated");return loadScope();}).catch(function(e){toast(e.message,"error");}).then(function(){setPending(false);});
        });
    }


    /* Production data plane: bulk scope and writes use App KV Store REST directly. */
    var kvService = mvc.createService({ owner: "nobody", app: APP });
    state.allRows=[]; state.inventoryByKey={}; state.lastSeenByKey={};
    function rc4Error(v){if(!v)return"Unknown error";if(typeof v==="string")return v;if(v.message)return String(v.message);if(v.statusText)return String(v.statusText);if(v.responseText){try{var p=JSON.parse(v.responseText);if(p.messages&&p.messages[0])return p.messages[0].text||JSON.stringify(p.messages[0]);return JSON.stringify(p);}catch(e){return String(v.responseText).slice(0,500);}}try{return JSON.stringify(v);}catch(e2){return String(v);}}
    function kvGet(c,k,p){return new Promise(function(resolve,reject){kvService.get("storage/collections/data/"+c+(k?"/"+encodeURIComponent(k):""),p||{},function(err,res){if(err){reject(new Error(rc4Error(err)));return;}var d=res&&res.data!==undefined?res.data:res;if(typeof d==="string"){try{d=JSON.parse(d);}catch(e){}}resolve(d);});});}
    function kvBatch(c,docs){if(!docs.length)return Promise.resolve([]);return new Promise(function(resolve,reject){kvService.request("storage/collections/data/"+c+"/batch_save","POST",null,null,JSON.stringify(docs),{"Content-Type":"application/json"},null).done(function(d){resolve(d);}).fail(function(e){reject(new Error(rc4Error(e)));});});}
    function nowE(){return Math.floor(Date.now()/1000);} function fmt(e){if(e===null||e===undefined||e==="")return"—";var d=new Date(Number(e)*1000);if(isNaN(d.getTime()))return"—";var z=function(n){return String(n).padStart(2,"0")};return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+" "+z(d.getHours())+":"+z(d.getMinutes())+":"+z(d.getSeconds());}
    function rowFrom(inv,ls){var n=nowE(),thr=Number(inv.threshold_seconds||7200),last=ls&&ls.last_seen!==undefined?Number(ls.last_seen):null,maint=Number(inv.maintenance_until||0),status=String(inv.status||"active").toLowerCase(),age=last===null||!isFinite(last)?null:Math.max(0,n-last),eff;if(status==="retired")eff="RETIRED";else if(status==="maintenance"&&(maint===0||maint>n))eff="MAINTENANCE";else if(age===null)eff="NO LOG OBSERVATION";else if(age>thr)eff="SILENT";else eff="OK";var ds=eff;return{_key:inv._key,index:inv.index,host:inv.host,status:status,lifecycle:status.toUpperCase(),threshold_seconds:thr,threshold_minutes:Math.round(thr/60),maintenance_until:maint,change_ref:inv.change_ref||"",created_at:inv.created_at,updated_at:inv.updated_at,last_seen:last,lastseen_updated_at:ls?ls.updated_at:null,age_seconds:age,age_minutes:age===null?null:Math.round(age/6)/10,effective_state:eff,display_state:ds,alarm:eff==="SILENT"?1:0,state_updated_at:n,last_seen_display:fmt(last)};}
    function invDoc(x){return{_key:x._key,index:x.index,host:x.host,status:x.status,threshold_seconds:Number(x.threshold_seconds||7200),maintenance_until:Number(x.maintenance_until||0),change_ref:x.change_ref||"",created_at:Number(x.created_at||nowE()),updated_at:Number(x.updated_at||nowE())};}
    function stateDoc(r){return{_key:r._key,index:r.index,host:r.host,status:r.status,threshold_seconds:Number(r.threshold_seconds||7200),threshold_minutes:Number(r.threshold_minutes||0),maintenance_until:Number(r.maintenance_until||0),change_ref:r.change_ref||"",last_seen:r.last_seen,lastseen_updated_at:r.lastseen_updated_at,age_seconds:r.age_seconds,age_minutes:r.age_minutes,effective_state:r.effective_state,alarm:Number(r.alarm||0),state_updated_at:nowE()};}
    function loadAll(){return Promise.all([kvGet("lsw_inventory",null,{limit:10000}),kvGet("lsw_lastseen",null,{limit:10000})]).then(function(p){var inv=$.isArray(p[0])?p[0]:[],ls=$.isArray(p[1])?p[1]:[];state.inventoryByKey={};state.lastSeenByKey={};ls.forEach(function(x){state.lastSeenByKey[x._key]=x;});state.allRows=inv.map(function(x){state.inventoryByKey[x._key]=x;return rowFrom(x,state.lastSeenByKey[x._key]);});});}
    function filtered(){var q=clampText(state.query,128).toLowerCase();return state.allRows.filter(function(r){if(q&&String(r.host).toLowerCase().indexOf(q)<0&&String(r.index).toLowerCase().indexOf(q)<0)return false;if(state.stateFilter!=="*"&&r.display_state!==state.stateFilter)return false;if(state.lifecycleFilter!=="*"&&r.status!==state.lifecycleFilter)return false;if(state.indexFilter!=="*"&&r.index!==state.indexFilter)return false;return true;});}
    function refreshLocal(){var rows=filtered();state.total=rows.length;state.preview=rows.sort(function(a,b){return String(a.index).localeCompare(String(b.index))||String(a.host).localeCompare(String(b.host));}).slice(0,25);var counts={};state.allRows.forEach(function(r){counts[r.index]=(counts[r.index]||0)+1;});state.indexes=Object.keys(counts).sort().map(function(k){return{index:k,sources:counts[k]};});state.lastRefresh=new Date();renderPreview();renderIndexes();}
    loadScope=function(){var g=++state.generation;$("#lsw-bulk-preview").html('<tr class="lsw-skeleton-row"><td colspan="6"><div class="lsw-skeleton"></div></td></tr>');if(state.allRows.length){refreshLocal();return Promise.resolve();}return loadAll().then(function(){if(g!==state.generation)return;refreshLocal();}).catch(function(e){if(g!==state.generation)return;state.total=0;state.preview=[];renderPreview();toast(e.message,"error");});};
    loadIndexes=function(){if(state.allRows.length){refreshLocal();return Promise.resolve();}return loadAll().then(refreshLocal).catch(function(){});};
    loadUsername=function(){return new Promise(function(resolve){kvService.get("authentication/current-context",{},function(err,res){if(!err&&res&&res.data){var d=res.data;state.username=(d.username||(d.entry&&d.entry[0]&&d.entry[0].content&&d.entry[0].content.username)||state.username);}resolve();});});};
    function licenseStatusQuery(){return '| lswlicense | fields license_status license_valid edition customer license_id max_monitored_sources shc_allowed deployment_compliant message expires_at';}
    function monitoredCountLocal(){var n=0;Object.keys(state.inventoryByKey||{}).forEach(function(k){var st=String((state.inventoryByKey[k]||{}).status||"active").toLowerCase();if(st==="active"||st==="maintenance")n++;});return n;}
    function communityLicenseFallback(increment){var current=monitoredCountLocal(),max=100,projected=current+Math.max(0,Number(increment||0));if(projected>max)throw new Error("Community Edition capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but Community permits 100. Retired sources do not count toward capacity.");return {edition:"Community",current:current,max:max,projected:projected,runtime_fallback:true};}
    function assertLicenseCapacity(increment){increment=Math.max(0,Number(increment||0));if(!increment)return Promise.resolve();return runSearch(licenseStatusQuery(),30000).then(function(rows){var x=rows&&rows[0]?rows[0]:{};if(Number(x.deployment_compliant===undefined?1:x.deployment_compliant)!==1)throw new Error(x.message||"Current deployment is not permitted by the active Log Source Watch license");if(String(x.license_status||"").toUpperCase()==="EXPIRED")throw new Error(x.message||"Paid Log Source Watch license has expired. Existing monitoring continues, but monitored-source capacity cannot be increased until renewal.");var current=monitoredCountLocal(),max=Number(x.max_monitored_sources||100),projected=current+increment;if(max>0&&projected>max)throw new Error("License capacity exceeded: this action would result in "+projected.toLocaleString()+" monitored sources, but "+(x.edition||"Community")+" permits "+max.toLocaleString()+". Retired sources do not count toward capacity.");return {edition:x.edition||"Community",current:current,max:max,projected:projected,runtime_fallback:false};}).catch(function(err){var m=String((err&&err.message)||err||"");if(/unknown search command/i.test(m))return communityLicenseFallback(increment);throw err;});}
    function specFor(inv){var out=$.extend({},inv),op="source_update",detail="Bulk source policy updated",n=nowE();if(state.action==="threshold"){var m=Number(state.thresholdMinutes);if(!isFinite(m)||m<1||m>10080||Math.floor(m)!==m)throw new Error("Threshold must be a whole number between 1 and 10080 minutes");out.threshold_seconds=m*60;out.change_ref="ui-bulk-threshold";op="threshold_change";detail="Bulk threshold changed to "+m+" minutes";}else if(state.action==="maintenance"){var sec=Number(state.maintenanceSeconds);if(!isFinite(sec)||sec<0||sec>2592000)throw new Error("Invalid maintenance duration");out.status="maintenance";out.maintenance_until=sec===0?0:n+Math.round(sec);out.change_ref="ui-bulk-maintenance";op="maintenance_set";detail=sec===0?"Bulk maintenance enabled until cleared":"Bulk maintenance enabled for "+Math.round(sec/3600)+" hours";}else if(state.action==="clear_maintenance"){out.status="active";out.maintenance_until=0;out.change_ref="ui-bulk-maintenance-clear";op="maintenance_set";detail="Bulk maintenance cleared";}else if(state.action==="activate"){out.status="active";out.maintenance_until=0;out.change_ref="ui-bulk-activate";op="lifecycle_change";detail="Bulk lifecycle changed to active";}else if(state.action==="retire"){out.status="retired";out.maintenance_until=0;out.change_ref="ui-bulk-retire";op="lifecycle_change";detail="Bulk lifecycle changed to retired";}else throw new Error("Unsupported bulk action");out.updated_at=n;out.created_at=Number(out.created_at||n);return{doc:invDoc(out),operation:op,detail:detail,oldStatus:inv.status||"active",oldThreshold:Number(inv.threshold_seconds||7200),oldMaintenance:Number(inv.maintenance_until||0)};}
    reviewAndApply=function(){
        if(state.pending||state.total<=0||state.total>MAX_BULK)return;
        var targets=filtered();
        if(targets.length>MAX_BULK){toast("Scope exceeds hard limit","error");return;}
        var actionLabel={threshold:"Change threshold",maintenance:"Start maintenance",clear_maintenance:"End maintenance",activate:"Activate sources",retire:"Retire sources"}[state.action]||"Apply action";
        var danger=state.action==="retire";
        modal(actionLabel+' for '+targets.length.toLocaleString()+' sources?','<div class="lsw-confirm-summary"><strong>This is a bulk configuration change.</strong><p>The exact current filtered scope is used. Inventory is authoritative; state is updated immediately and the scheduler will reconcile it again.</p></div>',danger?'Retire sources':'Apply change',danger).then(function(ok){
            if(!ok)return;
            setPending(true);
            var invs=[],states=[],audits=[],increment=0;
            try{
                targets.forEach(function(r){
                    var inv=state.inventoryByKey[r._key],sp=specFor(inv),nr=rowFrom(sp.doc,state.lastSeenByKey[r._key]);
                    if(String(inv.status||"active").toLowerCase()==="retired"&&(state.action==="activate"||state.action==="maintenance"))increment++;
                    invs.push(sp.doc);states.push(stateDoc(nr));audits.push({event_time_epoch:nowE(),actor:state.username||"unknown",scope:"bulk",operation:sp.operation,index:sp.doc.index,host:sp.doc.host,old_status:sp.oldStatus,new_status:sp.doc.status,old_threshold_seconds:sp.oldThreshold,new_threshold_seconds:sp.doc.threshold_seconds,old_maintenance_until:sp.oldMaintenance,new_maintenance_until:sp.doc.maintenance_until,change_ref:sp.doc.change_ref,details:sp.detail});
                });
            }catch(e){toast(e.message,"error");setPending(false);return;}
            assertLicenseCapacity(increment)
                .then(function(){return kvBatch("lsw_inventory",invs);})
                .then(function(){return kvBatch("lsw_audit",audits);})
                .then(function(){return kvBatch("lsw_state",states);})
                .then(function(){toast(targets.length.toLocaleString()+" sources updated");state.allRows=[];return loadScope();})
                .catch(function(e){toast(e.message,"error");state.allRows=[];return loadScope();})
                .then(function(){setPending(false);});
        });
    };

    function bind(){
        var $r=$(ROOT);
        $r.on("input","#lsw-bulk-search",function(){state.query=$(this).val();clearTimeout(debounceTimer);debounceTimer=setTimeout(loadScope,300);});
        $r.on("change","#lsw-bulk-state",function(){state.stateFilter=$(this).val();loadScope();});
        $r.on("change","#lsw-bulk-life",function(){state.lifecycleFilter=$(this).val();loadScope();});
        $r.on("change","#lsw-bulk-index",function(){state.indexFilter=$(this).val();loadScope();});
        $r.on("change",'input[name="lsw-bulk-action"]',function(){state.action=$(this).val();$(".lsw-action-option").removeClass("active");$(this).closest(".lsw-action-option").addClass("active");renderActionControls();renderSafety();});
        $r.on("input","#lsw-bulk-threshold",function(){state.thresholdMinutes=Number($(this).val());});
        $r.on("change","#lsw-bulk-maintenance",function(){state.maintenanceSeconds=Number($(this).val());});
        $r.on("click",'[data-action="refresh"]',function(){state.allRows=[];loadScope();});
        $r.on("click",'[data-action="reset"]',function(){state.query="";state.stateFilter="*";state.lifecycleFilter="*";state.indexFilter="*";$("#lsw-bulk-search").val("");$("#lsw-bulk-state,#lsw-bulk-life,#lsw-bulk-index").val("*");loadScope();});
        $r.on("click",'[data-action="apply"]',reviewAndApply);
    }
    function fatalBoot(err){var msg=err&&err.message?err.message:String(err||"Unknown error");try{$(ROOT).html('<div class="lsw-boot-card lsw-boot-error"><div><strong>Bulk Actions could not start</strong><span>'+escHtml(msg)+'</span></div></div>');}catch(e){}if(window.console&&console.error)console.error("Log Source Watch Bulk bootstrap failed",err);}
    function bootstrap(){renderShell();bind();renderActionControls();loadUsername();loadScope();}
    try{bootstrap();}catch(e){fatalBoot(e);}
});
