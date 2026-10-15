/* Log Source Watch - Optional Sourcetype Policies (Beta)
 *
 * The licensed Monitored Source remains index + host. Sourcetype policies are
 * optional refinements underneath an already registered base source and do not
 * create additional licensed Monitored Sources.
 */
require([
    "jquery",
    "splunkjs/mvc",
    "splunkjs/mvc/searchmanager",
    "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
    "use strict";

    var ROOT = "#lsw-feed-root";
    var APP = "logsource_watch";
    var MAX_DISCOVERY = 5000;
    var seq = 0;
    var kvService = mvc.createService({ owner: "nobody", app: APP });

    var state = {
        baseSources: [],
        baseByKey: {},
        policies: [],
        feedLastseen: {},
        feedState: {},
        rows: [],
        username: "unknown",
        selectedBaseKey: "",
        earliest: "-24h",
        thresholdMinutes: 120,
        discovery: [],
        pending: false,
        lastRefresh: null
    };

    var allowedEarliest = {"-1h":1,"-6h":1,"-24h":1,"-7d":1,"-30d":1};

    function escHtml(v) {
        return String(v === null || v === undefined ? "" : v)
            .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
            .replace(/\"/g,"&quot;").replace(/'/g,"&#39;");
    }
    function spl(v) {
        return String(v === null || v === undefined ? "" : v)
            .replace(/[\x00-\x1f\x7f]/g," ").replace(/\\/g,"\\\\").replace(/\"/g,'\\"');
    }
    function safeKey(v) { return /^[a-f0-9]{64}$/i.test(String(v || "")); }
    function nowEpoch() { return Math.floor(Date.now()/1000); }
    function fmt(epoch) {
        if (epoch === null || epoch === undefined || epoch === "") return "—";
        var d = new Date(Number(epoch)*1000);
        if (isNaN(d.getTime())) return "—";
        var z = function(n){ return String(n).padStart(2,"0"); };
        return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+" "+z(d.getHours())+":"+z(d.getMinutes())+":"+z(d.getSeconds());
    }
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
            } catch (e) { return String(v.responseText).slice(0,500); }
        }
        try { return JSON.stringify(v); } catch (e2) { return String(v); }
    }
    function kvGet(collection, key, params) {
        return new Promise(function(resolve, reject) {
            var path = "storage/collections/data/" + collection + (key ? "/" + encodeURIComponent(key) : "");
            kvService.get(path, params || {}, function(err, response) {
                if (err) { reject(new Error(kvError(err))); return; }
                var data = response && response.data !== undefined ? response.data : response;
                if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
                resolve(data);
            });
        });
    }
    function kvBatchSave(collection, docs) {
        if (!docs || !docs.length) return Promise.resolve([]);
        return new Promise(function(resolve, reject) {
            kvService.request(
                "storage/collections/data/" + collection + "/batch_save",
                "POST", null, null, JSON.stringify(docs),
                {"Content-Type":"application/json"}, null
            ).done(function(data) {
                try { resolve(typeof data === "string" ? JSON.parse(data) : data); }
                catch (e) { resolve(data); }
            }).fail(function(err) { reject(new Error(collection + ": " + kvError(err))); });
        });
    }
    function kvCreate(collection, doc) {
        return new Promise(function(resolve, reject) {
            kvService.request(
                "storage/collections/data/" + collection,
                "POST", null, null, JSON.stringify(doc),
                {"Content-Type":"application/json"}, null
            ).done(function(data) {
                try { resolve(typeof data === "string" ? JSON.parse(data) : data); }
                catch (e) { resolve(data); }
            }).fail(function(err) { reject(new Error(collection + ": " + kvError(err))); });
        });
    }

    function rowsFromPayload(payload) {
        if (!payload) return [];
        if (payload.results && $.isArray(payload.results)) return payload.results;
        var fields = payload.fields || [], rows = payload.rows || [];
        if (!rows.length) return [];
        var names = fields.map(function(f){ return typeof f === "string" ? f : f.name; });
        return rows.map(function(row){ var out={}; names.forEach(function(n,i){out[n]=row[i];}); return out; });
    }
    function cleanupManager(id) {
        window.setTimeout(function(){ try { if (mvc.Components && mvc.Components.revokeInstance) mvc.Components.revokeInstance(id); } catch(e){} },0);
    }
    function runSearch(search, timeoutMs) {
        timeoutMs = timeoutMs || 60000;
        return new Promise(function(resolve, reject) {
            var id = "lsw_feed_" + Date.now() + "_" + (++seq), settled=false, timer, manager, results;
            function finish(fn,value){ if(settled)return;settled=true;window.clearTimeout(timer);cleanupManager(id);fn(value); }
            function fail(prefix,message){ var detail=message&&message.message?message.message:message;finish(reject,new Error(prefix+(detail?": "+detail:""))); }
            function consume(){
                try {
                    var payload=results&&results.data?results.data():null;
                    if(!payload)return false;
                    var rows=rowsFromPayload(payload), shaped=$.isArray(payload.results)||$.isArray(payload.rows);
                    if(rows.length||shaped){finish(resolve,rows);return true;}
                } catch(e){finish(reject,e);return true;}
                return false;
            }
            try {
                manager=new SearchManager({id:id,search:search,preview:false,cache:false,autostart:false,app:APP});
                results=manager.data("results",{count:0,output_mode:"json"});
                results.on("data",consume);results.on("error",function(m){fail("Result retrieval failed",m);});
                manager.on("search:error",function(m){fail("Search error",m);});
                manager.on("search:failed",function(m){fail("Search failed",m);});
                manager.on("search:cancelled",function(){fail("Search was cancelled");});
                manager.on("search:done",function(props){var c=props&&props.content?Number(props.content.resultCount||0):0;if(c===0){finish(resolve,[]);return;}if(!consume()&&results&&typeof results.fetch==="function"){try{results.fetch();}catch(e){}}});
                timer=window.setTimeout(function(){try{manager.cancel();}catch(e){}finish(reject,new Error("Search timed out after "+Math.round(timeoutMs/1000)+" seconds"));},timeoutMs);
                manager.startSearch();
            } catch(e){finish(reject,e);}
        });
    }

    function viewHref(view){ return window.location.pathname.replace(/\/[^/]+\/?$/, "/"+view); }
    function workspaceNav(){
        var items=[["manage_hosts","Sources"],["bulk_management","Bulk Actions"],["add_log_sources","Discover"],["feed_policies","Sourcetype Policies · Beta"],["initial_setup","Initial Setup"]];
        return '<nav class="lsw-workspace-tabs" aria-label="Source management">'+items.map(function(i){return '<a class="lsw-workspace-tab '+(i[0]==="feed_policies"?'active':'')+'" href="'+escHtml(viewHref(i[0]))+'">'+escHtml(i[1])+'</a>';}).join("")+'</nav>';
    }
    function badgeClass(v){v=String(v||"").toUpperCase();if(v==="OK")return"ok";if(v==="SILENT")return"silent";if(v==="MAINTENANCE")return"maintenance";if(v==="RETIRED")return"retired";return"nolog";}

    function renderShell(){
        $(ROOT).html(
          '<div class="lsw-workspace">'+
            '<header class="lsw-workspace-header"><div class="lsw-header-copy"><div class="lsw-eyebrow">LOG SOURCE WATCH · BETA</div><h1>Sourcetype Policies</h1><p>Refine an existing index + host Monitored Source with optional sourcetype-level silence policies.</p></div><div class="lsw-header-actions"><div class="lsw-live-indicator"><span></span>Capacity remains index + host</div><button class="lsw-btn lsw-btn-secondary" data-action="refresh">↻ Refresh</button></div></header>'+
            workspaceNav()+
            '<section id="lsw-feed-kpis" class="lsw-kpis"></section>'+
            '<div class="lsw-feed-layout">'+
              '<section class="lsw-premium-card">'+
                '<div class="lsw-card-head"><div><span class="lsw-step">1</span><h2>Discover sourcetypes</h2><p>Select an already monitored base source. Feed policies inherit its lifecycle and maintenance state.</p></div></div>'+
                '<div class="lsw-feed-config">'+
                  '<label><span>Base source</span><select id="lsw-feed-base" class="lsw-select lsw-select-full"><option value="">Select index + host</option></select></label>'+
                  '<label><span>Lookback</span><select id="lsw-feed-earliest" class="lsw-select lsw-select-full"><option value="-1h">Last 1 hour</option><option value="-6h">Last 6 hours</option><option value="-24h" selected>Last 24 hours</option><option value="-7d">Last 7 days</option><option value="-30d">Last 30 days</option></select></label>'+
                  '<label><span>Feed threshold</span><div class="lsw-inline-control"><input id="lsw-feed-threshold" type="number" min="1" max="10080" step="1" value="120"/><span>minutes</span></div></label>'+
                  '<button class="lsw-btn lsw-btn-primary" data-action="discover">Discover sourcetypes</button>'+
                '</div>'+
                '<div class="lsw-feed-capacity-note"><strong>No extra licensed source count.</strong><span>A sourcetype policy is a refinement of its registered index + host base source.</span></div>'+
                '<div class="lsw-table-scroll"><table class="lsw-table"><thead><tr><th>Sourcetype</th><th>Last seen</th><th>Events</th><th>Policy</th><th></th></tr></thead><tbody id="lsw-feed-discovery"><tr><td colspan="5"><div class="lsw-empty"><strong>Ready to discover</strong><span>Select a base source and run discovery.</span></div></td></tr></tbody></table></div>'+
              '</section>'+
              '<section class="lsw-premium-card">'+
                '<div class="lsw-card-head"><div><span class="lsw-step">2</span><h2>Feed policies</h2><p>Each feed gets its own silence threshold while lifecycle and maintenance remain controlled by the base source.</p></div><strong id="lsw-feed-count" class="lsw-scope-count">0</strong></div>'+
                '<div class="lsw-table-scroll"><table class="lsw-table"><thead><tr><th>State</th><th>Host</th><th>Sourcetype</th><th>Threshold</th><th>Last seen</th><th>Base</th><th></th></tr></thead><tbody id="lsw-feed-policies"></tbody></table></div>'+
              '</section>'+
            '</div>'+
          '</div><div id="lsw-modal-backdrop" class="lsw-modal-backdrop" hidden></div><div id="lsw-modal" class="lsw-modal" role="dialog" aria-modal="true" hidden></div><div id="lsw-toasts" class="lsw-toasts" aria-live="assertive"></div>'
        );
    }

    function renderBaseSources(){
        var $s=$("#lsw-feed-base"), current=state.selectedBaseKey;
        $s.find('option:not(:first)').remove();
        state.baseSources.filter(function(x){return String(x.status||"active").toLowerCase()!=="retired";}).forEach(function(x){
            $s.append('<option value="'+escHtml(x._key)+'">'+escHtml(x.index+' · '+x.host)+'</option>');
        });
        $s.val(current);
    }

    function effectiveState(policy, ls, base){
        var now=nowEpoch(), enabled=Number(policy.enabled===undefined?1:policy.enabled), status=base?String(base.status||"active").toLowerCase():"", maint=base?Number(base.maintenance_until||0):0;
        var last=ls&&ls.last_seen!==undefined?Number(ls.last_seen):null, age=(last!==null&&isFinite(last))?Math.max(0,now-last):null, thr=Number(policy.threshold_seconds||7200), effective;
        if(!enabled) effective="DISABLED";
        else if(!base) effective="BASE SOURCE MISSING";
        else if(status==="retired") effective="RETIRED";
        else if(status==="maintenance"&&(maint===0||maint>now)) effective="MAINTENANCE";
        else if(age===null) effective="NO LOG OBSERVATION";
        else if(age>thr) effective="SILENT";
        else effective="OK";
        return {effective_state:effective,last_seen:last,age_seconds:age,base_status:status||"missing"};
    }

    function stateDoc(policy, ls, base){
        var st=effectiveState(policy,ls,base), thr=Number(policy.threshold_seconds||7200);
        return {_key:policy._key,base_key:policy.base_key,index:policy.index,host:policy.host,sourcetype:policy.sourcetype,base_status:st.base_status,threshold_seconds:thr,threshold_minutes:Math.round(thr/60),last_seen:st.last_seen,lastseen_updated_at:ls?ls.updated_at:null,age_seconds:st.age_seconds,age_minutes:st.age_seconds===null?null:Math.round(st.age_seconds/6)/10,effective_state:st.effective_state,alarm:(st.effective_state==="SILENT"||st.effective_state==="BASE SOURCE MISSING")?1:0,state_updated_at:nowEpoch()};
    }

    function buildRows(){
        state.rows=state.policies.map(function(p){
            var base=state.baseByKey[p.base_key], ls=state.feedLastseen[p._key], persisted=state.feedState[p._key]||{}, live=stateDoc(p,ls,base);
            if(Number(p.enabled===undefined?1:p.enabled)===1 && persisted.state_updated_at && Number(persisted.state_updated_at)>0){
                live.effective_state=persisted.effective_state||live.effective_state;
                live.last_seen=persisted.last_seen!==undefined?persisted.last_seen:live.last_seen;
                live.age_minutes=persisted.age_minutes!==undefined?persisted.age_minutes:live.age_minutes;
            }
            live.enabled=Number(p.enabled===undefined?1:p.enabled);live.change_ref=p.change_ref;live.created_at=p.created_at;live.updated_at=p.updated_at;return live;
        });
    }

    function renderKpis(){
        var active=0,silent=0,nolog=0,maintenance=0;
        state.rows.forEach(function(r){if(r.enabled===1)active++;if(r.effective_state==="SILENT")silent++;else if(r.effective_state==="NO LOG OBSERVATION")nolog++;else if(r.effective_state==="MAINTENANCE")maintenance++;});
        var cards=[["Feed policies",active,"total"],["Silent",silent,"silent"],["No log observation",nolog,"nolog"],["Inherited maintenance",maintenance,"maintenance"]];
        $("#lsw-feed-kpis").html(cards.map(function(c){return '<div class="lsw-kpi '+c[2]+'"><span>'+escHtml(c[0])+'</span><strong>'+Number(c[1]).toLocaleString()+'</strong></div>';}).join(""));
    }

    function renderPolicies(){
        buildRows();renderKpis();
        $("#lsw-feed-count").text(state.rows.length.toLocaleString()+" policies");
        var $b=$("#lsw-feed-policies");
        if(!state.rows.length){$b.html('<tr><td colspan="7"><div class="lsw-empty"><strong>No sourcetype policies yet</strong><span>Discover a sourcetype under a monitored source and enroll it as a feed policy.</span></div></td></tr>');return;}
        $b.html(state.rows.sort(function(a,b){return String(a.index).localeCompare(String(b.index))||String(a.host).localeCompare(String(b.host))||String(a.sourcetype).localeCompare(String(b.sourcetype));}).map(function(r){
            var enabled=r.enabled===1, stateLabel=enabled?r.effective_state:"DISABLED";
            return '<tr><td><span class="lsw-state-pill '+badgeClass(stateLabel)+'"><i></i>'+escHtml(stateLabel)+'</span></td><td><strong>'+escHtml(r.host)+'</strong><small class="lsw-feed-sub">'+escHtml(r.index)+'</small></td><td><span class="lsw-mono">'+escHtml(r.sourcetype)+'</span></td><td>'+escHtml(r.threshold_minutes)+' min</td><td class="lsw-dim">'+escHtml(fmt(r.last_seen))+'</td><td>'+escHtml(String(r.base_status||"-").toUpperCase())+'</td><td><div class="lsw-feed-actions"><button class="lsw-btn lsw-btn-ghost lsw-btn-compact" data-threshold="'+escHtml(r._key)+'">Threshold</button><button class="lsw-btn '+(enabled?'lsw-btn-ghost':'lsw-btn-primary')+' lsw-btn-compact" data-toggle="'+escHtml(r._key)+'" data-enable="'+(enabled?'0':'1')+'">'+(enabled?'Disable':'Enable')+'</button></div></td></tr>';
        }).join(""));
    }

    function renderDiscovery(){
        var $b=$("#lsw-feed-discovery");
        if(!state.discovery.length){$b.html('<tr><td colspan="5"><div class="lsw-empty"><strong>No sourcetypes found</strong><span>Try a longer lookback or verify the selected base source is receiving data.</span></div></td></tr>');return;}
        var policyByKey={};state.policies.forEach(function(p){policyByKey[p._key]=p;});
        $b.html(state.discovery.map(function(r){var existing=policyByKey[r._key],enabled=existing&&Number(existing.enabled===undefined?1:existing.enabled)===1;return '<tr><td><strong>'+escHtml(r.sourcetype)+'</strong></td><td class="lsw-dim">'+escHtml(r.last_seen_display)+'</td><td>'+Number(r.events||0).toLocaleString()+'</td><td>'+(existing?(enabled?'<span class="lsw-state-pill ok"><i></i>MONITORED</span>':'<span class="lsw-state-pill nolog"><i></i>DISABLED</span>'):'<span class="lsw-state-pill nolog"><i></i>NEW</span>')+'</td><td>'+(existing?'<button class="lsw-btn lsw-btn-ghost lsw-btn-compact" data-existing="'+escHtml(r._key)+'">Already added</button>':'<button class="lsw-btn lsw-btn-primary lsw-btn-compact" data-enroll="'+escHtml(r._key)+'">Add policy</button>')+'</td></tr>';}).join(""));
    }

    function setPending(on){state.pending=!!on;$(ROOT).toggleClass("lsw-pending",state.pending);$(ROOT).find("button,select,input").prop("disabled",state.pending);}
    function toast(message,type){type=type||"success";var id="feedtoast_"+Date.now()+"_"+(++seq),$t=$('<div class="lsw-toast '+type+'" id="'+id+'"><span class="lsw-toast-icon">'+(type==="error"?"!":"✓")+'</span><div>'+escHtml(message)+'</div></div>');$("#lsw-toasts").append($t);setTimeout(function(){$t.addClass("show");},10);setTimeout(function(){$t.removeClass("show");setTimeout(function(){$t.remove();},250);},4300);}
    function modal(title,body,label,danger){return new Promise(function(resolve){var $m=$("#lsw-modal");$("#lsw-modal-backdrop").removeAttr("hidden");$m.removeAttr("hidden").html('<div class="lsw-modal-head"><h3>'+escHtml(title)+'</h3></div><div class="lsw-modal-body">'+body+'</div><div class="lsw-modal-actions"><button class="lsw-btn lsw-btn-ghost" data-feed-modal="cancel">Cancel</button><button class="lsw-btn '+(danger?'lsw-btn-danger':'lsw-btn-primary')+'" data-feed-modal="confirm">'+escHtml(label||"Confirm")+'</button></div>');function close(v){$(document).off("click.lswfeedmodal");$("#lsw-modal-backdrop").attr("hidden",true);$m.attr("hidden",true).empty();resolve(v);}$(document).on("click.lswfeedmodal",'[data-feed-modal="cancel"]',function(){close(false);});$(document).on("click.lswfeedmodal",'[data-feed-modal="confirm"]',function(){close(true);});});}

    function loadUsername(){return new Promise(function(resolve){kvService.get("authentication/current-context",{},function(err,res){if(!err&&res&&res.data){var d=res.data;state.username=d.username||(d.entry&&d.entry[0]&&d.entry[0].content&&d.entry[0].content.username)||state.username;}resolve();});});}

    function loadAll(){
        return Promise.all([
            kvGet("lsw_inventory",null,{limit:10000}),
            kvGet("lsw_feed_inventory",null,{limit:10000}).catch(function(){return[];}),
            kvGet("lsw_feed_lastseen",null,{limit:10000}).catch(function(){return[];}),
            kvGet("lsw_feed_state",null,{limit:10000}).catch(function(){return[];})
        ]).then(function(parts){
            state.baseSources=$.isArray(parts[0])?parts[0]:[];state.policies=$.isArray(parts[1])?parts[1]:[];state.feedLastseen={};state.feedState={};state.baseByKey={};
            state.baseSources.forEach(function(x){state.baseByKey[x._key]=x;});($.isArray(parts[2])?parts[2]:[]).forEach(function(x){state.feedLastseen[x._key]=x;});($.isArray(parts[3])?parts[3]:[]).forEach(function(x){state.feedState[x._key]=x;});
            state.lastRefresh=new Date();renderBaseSources();renderPolicies();
        });
    }

    function discoveryQuery(base){
        var earliest=allowedEarliest[state.earliest]?state.earliest:"-24h";
        return '| tstats latest(_time) AS observed_last_seen count AS events WHERE index="'+spl(base.index)+'" host="'+spl(base.host)+'" earliest='+earliest+' latest=now BY index host sourcetype'+
          ' | where isnotnull(sourcetype) AND len(sourcetype)>0 AND len(sourcetype)<=512'+
          ' | eval _key=sha256(index."|".host."|".sourcetype),last_seen_display=strftime(observed_last_seen,"%Y-%m-%d %H:%M:%S")'+
          ' | sort 0 sourcetype | head '+MAX_DISCOVERY+' | table _key index host sourcetype observed_last_seen last_seen_display events';
    }

    function discover(){
        var key=$("#lsw-feed-base").val()||"";state.selectedBaseKey=key;state.earliest=$("#lsw-feed-earliest").val()||"-24h";state.thresholdMinutes=Number($("#lsw-feed-threshold").val());
        if(!safeKey(key)||!state.baseByKey[key]){toast("Select a monitored base source first","error");return;}
        if(!isFinite(state.thresholdMinutes)||state.thresholdMinutes<1||state.thresholdMinutes>10080||Math.floor(state.thresholdMinutes)!==state.thresholdMinutes){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return;}
        setPending(true);runSearch(discoveryQuery(state.baseByKey[key]),90000).then(function(rows){state.discovery=rows||[];renderDiscovery();}).catch(function(e){state.discovery=[];renderDiscovery();toast(e.message,"error");}).then(function(){setPending(false);renderBaseSources();});
    }

    function auditDoc(policy,operation,detail,oldThreshold,newThreshold){return{event_time_epoch:nowEpoch(),actor:state.username||"unknown",scope:"feed_policy",operation:operation,index:policy.index,host:policy.host,sourcetype:policy.sourcetype,old_status:"",new_status:"",old_threshold_seconds:oldThreshold===undefined?null:oldThreshold,new_threshold_seconds:newThreshold===undefined?null:newThreshold,old_maintenance_until:0,new_maintenance_until:0,change_ref:policy.change_ref||"feed-policy-beta",details:detail};}

    function enroll(key){
        var c=state.discovery.filter(function(x){return x._key===key;})[0],base=state.baseByKey[state.selectedBaseKey];
        if(!c||!base||!safeKey(c._key)){toast("Discovery candidate is no longer available","error");return;}
        var minutes=Number($("#lsw-feed-threshold").val());if(!isFinite(minutes)||minutes<1||minutes>10080||Math.floor(minutes)!==minutes){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return;}
        modal("Add sourcetype policy?",'<p><b>'+escHtml(c.host)+'</b><br><span class="lsw-mono">'+escHtml(c.sourcetype)+'</span></p><p>This feed inherits lifecycle and maintenance from the base index + host source. Its silence threshold will be '+minutes+' minutes.</p><p><b>Licensed capacity:</b> unchanged.</p>',"Add policy",false).then(function(ok){if(!ok)return;setPending(true);var now=nowEpoch(),policy={_key:c._key,base_key:base._key,index:c.index,host:c.host,sourcetype:c.sourcetype,threshold_seconds:minutes*60,enabled:1,change_ref:"ui-feed-enroll",created_at:now,updated_at:now},ls={_key:c._key,base_key:base._key,index:c.index,host:c.host,sourcetype:c.sourcetype,last_seen:Number(c.observed_last_seen),updated_at:now},sd=stateDoc(policy,ls,base);return kvBatchSave("lsw_feed_inventory",[policy]).then(function(){return kvBatchSave("lsw_feed_lastseen",[ls]);}).then(function(){return kvBatchSave("lsw_feed_state",[sd]);}).then(function(){return kvCreate("lsw_audit",auditDoc(policy,"feed_enrolled","Sourcetype policy enrolled",0,policy.threshold_seconds));}).then(function(){toast("Sourcetype policy added");return loadAll();}).then(function(){renderDiscovery();}).catch(function(e){toast(e.message,"error");}).then(function(){setPending(false);renderBaseSources();});});
    }

    function changeThreshold(key){
        var p=state.policies.filter(function(x){return x._key===key;})[0];if(!p)return;
        var current=Math.round(Number(p.threshold_seconds||7200)/60);
        modal("Change feed threshold",'<label class="lsw-control-label">New threshold</label><div class="lsw-inline-control"><input id="lsw-feed-modal-threshold" type="number" min="1" max="10080" step="1" value="'+current+'"/><span>minutes</span></div>',"Save threshold",false).then(function(ok){if(!ok)return;var m=Number($("#lsw-feed-modal-threshold").val());if(!isFinite(m)||m<1||m>10080||Math.floor(m)!==m){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return;}setPending(true);var old=Number(p.threshold_seconds||7200),upd=$.extend({},p,{threshold_seconds:m*60,updated_at:nowEpoch(),change_ref:"ui-feed-threshold"}),ls=state.feedLastseen[key]||null,base=state.baseByKey[p.base_key],sd=stateDoc(upd,ls,base);kvBatchSave("lsw_feed_inventory",[upd]).then(function(){return kvBatchSave("lsw_feed_state",[sd]);}).then(function(){return kvCreate("lsw_audit",auditDoc(upd,"feed_threshold_change","Sourcetype threshold changed to "+m+" minutes",old,m*60));}).then(function(){toast("Feed threshold updated");return loadAll();}).catch(function(e){toast(e.message,"error");}).then(function(){setPending(false);renderBaseSources();});});
    }

    function togglePolicy(key,enable){
        var p=state.policies.filter(function(x){return x._key===key;})[0];if(!p)return;enable=Number(enable)===1;
        modal((enable?"Enable":"Disable")+" sourcetype policy?",'<p><b>'+escHtml(p.host)+'</b><br><span class="lsw-mono">'+escHtml(p.sourcetype)+'</span></p><p>'+(enable?'Monitoring will resume using the existing threshold.':'The policy remains in configuration history but no longer produces a SILENT state.')+'</p>',enable?"Enable policy":"Disable policy",!enable).then(function(ok){if(!ok)return;setPending(true);var upd=$.extend({},p,{enabled:enable?1:0,updated_at:nowEpoch(),change_ref:enable?"ui-feed-enable":"ui-feed-disable"}),ls=state.feedLastseen[key]||null,base=state.baseByKey[p.base_key],sd=stateDoc(upd,ls,base);kvBatchSave("lsw_feed_inventory",[upd]).then(function(){return kvBatchSave("lsw_feed_state",[sd]);}).then(function(){return kvCreate("lsw_audit",auditDoc(upd,enable?"feed_enabled":"feed_disabled",enable?"Sourcetype policy enabled":"Sourcetype policy disabled"));}).then(function(){toast("Sourcetype policy "+(enable?"enabled":"disabled"));return loadAll();}).then(function(){renderDiscovery();}).catch(function(e){toast(e.message,"error");}).then(function(){setPending(false);renderBaseSources();});});
    }

    function bind(){
        var $r=$(ROOT);
        $r.on("change","#lsw-feed-base",function(){state.selectedBaseKey=$(this).val()||"";state.discovery=[];$("#lsw-feed-discovery").html('<tr><td colspan="5"><div class="lsw-empty"><strong>Ready to discover</strong><span>Run discovery for the selected base source.</span></div></td></tr>');});
        $r.on("change","#lsw-feed-earliest",function(){state.earliest=$(this).val();});
        $r.on("input","#lsw-feed-threshold",function(){state.thresholdMinutes=Number($(this).val());});
        $r.on("click",'[data-action="discover"]',discover);
        $r.on("click",'[data-action="refresh"]',function(){setPending(true);loadAll().then(function(){toast("Feed policies refreshed");}).catch(function(e){toast(e.message,"error");}).then(function(){setPending(false);renderBaseSources();});});
        $r.on("click","[data-enroll]",function(){enroll($(this).data("enroll"));});
        $r.on("click","[data-threshold]",function(){changeThreshold($(this).data("threshold"));});
        $r.on("click","[data-toggle]",function(){togglePolicy($(this).data("toggle"),$(this).data("enable"));});
    }

    function bootstrap(){renderShell();bind();loadUsername();loadAll().catch(function(e){toast("Could not load sourcetype policies: "+e.message,"error");});}
    try{bootstrap();}catch(e){$(ROOT).html('<div class="lsw-boot-card lsw-boot-error"><div><strong>Sourcetype Policies could not start</strong><span>'+escHtml(e.message||String(e))+'</span></div></div>');if(window.console&&console.error)console.error(e);}
});
