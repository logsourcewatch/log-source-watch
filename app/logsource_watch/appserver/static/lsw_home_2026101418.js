/* Log Source Watch 4.9.3 - Premium Operational Overview */
require([
  "jquery",
  "splunkjs/mvc",
  "splunkjs/mvc/searchmanager",
  "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
  "use strict";

  var APP = "logsource_watch";
  var ROOT = "#lsw-home-root";
  var REFRESH_MS = 30000;
  var HEARTBEAT_STALE_SECONDS = 900;
  var service = mvc.createService({owner:"nobody", app:APP});
  var timer = null;

  function esc(v){return String(v===null||v===undefined?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
  function num(v){var n=Number(v);return isFinite(n)?n:0;}
  function epoch(){return Math.floor(Date.now()/1000);}
  function fmtEpoch(v){var n=Number(v);if(!isFinite(n)||n<=0)return "—";var d=new Date(n*1000),z=function(x){return String(x).padStart(2,"0");};return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+" "+z(d.getHours())+":"+z(d.getMinutes())+":"+z(d.getSeconds());}
  function ageText(sec){if(sec===null||sec===undefined||!isFinite(sec))return "—";if(sec<3600)return (sec/60).toFixed(1)+" min";if(sec<86400)return (sec/3600).toFixed(1)+" h";return (sec/86400).toFixed(1)+" d";}
  function pct(n,d){return d?Math.round((n/d)*1000)/10:0;}
  function apiError(v){if(!v)return "Unknown error";if(typeof v==="string")return v;if(v.message)return String(v.message);if(v.statusText)return String(v.statusText);if(v.responseText){try{var p=JSON.parse(v.responseText);if(p.messages&&p.messages[0])return p.messages[0].text||JSON.stringify(p.messages[0]);}catch(e){}return String(v.responseText).slice(0,500);}try{return JSON.stringify(v);}catch(e2){return String(v);}}
  function kvGet(collection,params){return new Promise(function(resolve,reject){service.get("storage/collections/data/"+collection,params||{},function(err,res){if(err){reject(new Error(apiError(err)));return;}var d=res&&res.data!==undefined?res.data:res;if(typeof d==="string"){try{d=JSON.parse(d);}catch(e){}}resolve($.isArray(d)?d:[]);});});}
  var searchSeq=0;
  function resultRows(payload){if(!payload)return[];if(payload.results&&$.isArray(payload.results))return payload.results;var f=payload.fields||[],r=payload.rows||[],names=f.map(function(x){return typeof x==="string"?x:x.name;});return r.map(function(row){var o={};names.forEach(function(k,i){o[k]=row[i];});return o;});}
  function runSearch(search,timeout){return new Promise(function(resolve,reject){var id="lsw_home_search_"+Date.now()+"_"+(++searchSeq),done=false,timer,mgr,res;function finish(fn,v){if(done)return;done=true;window.clearTimeout(timer);try{mvc.Components.revokeInstance(id);}catch(e){}fn(v);}try{mgr=new SearchManager({id:id,search:search,preview:false,cache:false,autostart:false,app:APP});res=mgr.data("results",{count:0,output_mode:"json"});res.on("data",function(){try{var p=res.data();if(p)finish(resolve,resultRows(p));}catch(e){finish(reject,e);}});mgr.on("search:error",function(e){finish(reject,new Error("Search error: "+String((e&&e.message)||e)));});mgr.on("search:failed",function(e){finish(reject,new Error("Search failed: "+String((e&&e.message)||e)));});mgr.on("search:done",function(p){if(p&&p.content&&Number(p.content.resultCount||0)===0)finish(resolve,[]);});timer=window.setTimeout(function(){try{mgr.cancel();}catch(e){}finish(reject,new Error("Search timed out"));},timeout||15000);mgr.startSearch();}catch(e){finish(reject,e);}});}
  function licenseStatus(){return runSearch('| lswlicense | fields license_status license_valid edition customer license_id max_monitored_sources shc_allowed multiple_search_heads_allowed managed_service_allowed redistribution_allowed deployment_compliant expires_at days_remaining message',15000).then(function(r){return r&&r[0]?r[0]:{};}).catch(function(){return {license_status:"COMMUNITY",license_valid:1,edition:"Community",license_id:"COMMUNITY",max_monitored_sources:100,days_remaining:"",expires_at:"",message:"Community Edition is active."};});}

  function sourceState(inv,ls,hb){
    var now=epoch(),status=String(inv.status||"active").toLowerCase(),threshold=num(inv.threshold_seconds)||7200,maint=num(inv.maintenance_until),last=ls&&ls.last_seen!==undefined?Number(ls.last_seen):null,age=null,effective;
    var hbLast=hb&&hb.heartbeat_last_seen!==undefined?Number(hb.heartbeat_last_seen):null,hbAge=null,hbStatus="UNKNOWN",diagnosis="",diagnosisLabel="";
    if(last!==null&&isFinite(last))age=Math.max(0,now-last);
    if(hbLast!==null&&isFinite(hbLast)){hbAge=Math.max(0,now-hbLast);hbStatus=hbAge<=HEARTBEAT_STALE_SECONDS?"ALIVE":"STALE";}
    if(status==="retired")effective="RETIRED";
    else if(status==="maintenance"&&(maint===0||maint>now))effective="MAINTENANCE";
    else if(last===null||!isFinite(last))effective="NO LOG OBSERVATION";
    else if(age>threshold)effective="SILENT";
    else effective="OK";
    if(effective==="RETIRED"){diagnosis="RETIRED";diagnosisLabel="Retired";}
    else if(effective==="MAINTENANCE"){diagnosis="MAINTENANCE";diagnosisLabel="Maintenance";}
    else if(effective==="OK"){diagnosis="SOURCE_REPORTING";diagnosisLabel="Source reporting";}
    else if(effective==="SILENT"&&hbStatus==="ALIVE"){diagnosis="SOURCE_SILENT_INTERNAL_ACTIVE";diagnosisLabel="Source silent · _internal active";}
    else if(effective==="SILENT"&&hbStatus==="STALE"){diagnosis="SOURCE_SILENT_INTERNAL_STALE";diagnosisLabel="Source + _internal stale";}
    else if(effective==="SILENT"){diagnosis="SOURCE_SILENT_INTERNAL_UNKNOWN";diagnosisLabel="Source silent · no _internal evidence";}
    else if(effective==="NO LOG OBSERVATION"&&hbStatus==="ALIVE"){diagnosis="NO_LOG_INTERNAL_ACTIVE";diagnosisLabel="No source observation · _internal active";}
    else if(effective==="NO LOG OBSERVATION"&&hbStatus==="STALE"){diagnosis="NO_LOG_INTERNAL_STALE";diagnosisLabel="No source observation · _internal stale";}
    else {diagnosis="NO_LOG_INTERNAL_UNKNOWN";diagnosisLabel="No source observation · no _internal evidence";}
    return {_key:inv._key,index:inv.index||"",host:inv.host||"",status:status,effective_state:effective,threshold_seconds:threshold,threshold_minutes:Math.round(threshold/60),last_seen:last,age_seconds:age,maintenance_until:maint,ratio:(age===null?null:age/threshold),heartbeat_last_seen:hbLast,heartbeat_age_seconds:hbAge,heartbeat_status:hbStatus,heartbeat_type:hb&&hb.heartbeat_type||"",diagnosis:diagnosis,diagnosis_label:diagnosisLabel};
  }

  function icon(name){
    var paths={
      monitored:'<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
      ok:'<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
      silent:'<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
      noobs:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
      maintenance:'<path d="m14.5 6.5 3-3a5 5 0 0 1-6 6L5 16l3 3 6.5-6.5a5 5 0 0 1 6-6l-3 3-3-3Z"/>',
      retired:'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
      alert:'<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
      clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">'+(paths[name]||paths.monitored)+'</svg>';
  }

  function kpi(cls,ico,label,value,hint,share){
    var bar=share===null?'':'<div class="lsw-kpi-progress"><i style="width:'+Math.max(0,Math.min(100,share))+'%"></i></div>';
    return '<article class="lsw-premium-kpi '+cls+'"><div class="lsw-kpi-icon">'+icon(ico)+'</div><div class="lsw-kpi-copy"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(hint)+'</small>'+bar+'</div></article>';
  }

  function renderRisk(rows,monitored){
    var bins=[{label:'Healthy margin',sub:'Less than 50% of threshold used',n:0,cls:'healthy'},{label:'Watch',sub:'50–80% of threshold used',n:0,cls:'watch'},{label:'Near threshold',sub:'80–100% of threshold used',n:0,cls:'near'},{label:'Silent',sub:'Threshold exceeded',n:0,cls:'silent'},{label:'No observation',sub:'No last_seen value',n:0,cls:'noobs'}];
    rows.forEach(function(r){if(r.effective_state==="RETIRED"||r.effective_state==="MAINTENANCE")return;if(r.effective_state==="NO LOG OBSERVATION"){bins[4].n++;return;}if(r.effective_state==="SILENT"){bins[3].n++;return;}var q=r.ratio||0;if(q<.5)bins[0].n++;else if(q<.8)bins[1].n++;else bins[2].n++;});
    var max=Math.max.apply(null,bins.map(function(b){return b.n;}));if(max<1)max=1;
    return '<div class="lsw-risk-chart">'+bins.map(function(b){var width=b.n===0?0:Math.max(2,(b.n/max)*100);return '<div class="lsw-risk-row"><div class="lsw-risk-label"><b>'+b.label+'</b><span>'+b.sub+'</span></div><div class="lsw-risk-track"><i class="'+b.cls+'" style="width:'+width+'%"></i></div><strong>'+b.n+'</strong></div>';}).join('')+'</div>';
  }

  function operationLabel(op){var m={threshold_change:'Threshold changed',maintenance_set:'Maintenance updated',lifecycle_change:'Lifecycle changed',source_enrolled:'Source enrolled'};return m[op]||String(op||'Configuration update').replace(/_/g,' ');}
  function changeClass(op){if(op==='source_enrolled')return 'good';if(op==='maintenance_set')return 'maintenance';if(op==='lifecycle_change')return 'warn';return 'info';}

  function renderLicenseNotice(license,monitored){
    license=license||{};var status=String(license.license_status||"COMMUNITY").toUpperCase(),edition=license.edition||"Community",max=Number(license.max_monitored_sources||100),daysText=license.days_remaining,days=daysText===""?NaN:Number(daysText),util=max>0?pct(monitored,max):0,title="",detail="",cls="warn";
    if(status==="EXPIRED"){cls="critical";title="LICENSE EXPIRED";detail=license.message||("The "+edition+" license has expired. Existing monitoring continues, but capacity expansion is blocked until renewal.");}
    else if(status==="INVALID"){cls="critical";title="LICENSE NEEDS ATTENTION";detail=license.message||"The installed license could not be validated. Review Application Health.";}
    else if(status==="VALID"&&isFinite(days)&&days<=7){cls="critical";title="LICENSE EXPIRES SOON";detail=edition+" license expires in "+days+" day"+(days===1?"":"s")+(license.expires_at?" ("+license.expires_at+")":"")+". Renew before expiry.";}
    else if(status==="VALID"&&isFinite(days)&&days<=30){title="LICENSE EXPIRING";detail=edition+" license expires in "+days+" days"+(license.expires_at?" ("+license.expires_at+")":"")+". Plan renewal before expiry.";}
    else if(max>0&&util>=90){title="LICENSE CAPACITY NEAR LIMIT";detail=monitored.toLocaleString()+" / "+max.toLocaleString()+" monitored-source capacity in use ("+util+"%).";}
    if(!title)return "";
    return '<a href="health" class="lsw-license-notice '+cls+'"><div class="lsw-license-notice-icon">'+icon('alert')+'</div><div><strong>'+esc(title)+'</strong><span>'+esc(detail)+'</span></div><b>View license status →</b></a>';
  }

  function render(payload){
    var inv=payload.inv,seen=payload.seen,heartbeat=payload.heartbeat||[],audit=payload.audit,license=payload.license||{},seenBy={},hbByHost={};seen.forEach(function(x){seenBy[x._key]=x;});heartbeat.forEach(function(x){hbByHost[x.host]=x;});
    var rows=inv.map(function(x){return sourceState(x,seenBy[x._key],hbByHost[x.host]);});
    var counts={OK:0,SILENT:0,'NO LOG OBSERVATION':0,MAINTENANCE:0,RETIRED:0};rows.forEach(function(r){if(counts[r.effective_state]!==undefined)counts[r.effective_state]++;});
    var registered=rows.length, monitored=registered-counts.RETIRED, attention=counts.SILENT+counts['NO LOG OBSERVATION'];
    var health=registered===0?'SETUP REQUIRED':attention>0?'ATTENTION':'GOOD',healthCls=registered===0?'setup':attention>0?'attention':'good';
    var healthDetail=registered===0?'No monitored sources configured':counts.OK+' of '+monitored+' monitored sources healthy ('+pct(counts.OK,monitored)+'%)';

    var total=Math.max(registered,1),pOK=pct(counts.OK,total),pSilent=pct(counts.SILENT,total),pNo=pct(counts['NO LOG OBSERVATION'],total),pMaint=pct(counts.MAINTENANCE,total);
    var s1=pOK,s2=s1+pSilent,s3=s2+pNo,s4=s3+pMaint;
    var donut='conic-gradient(#26c97a 0 '+s1+'%, #ff4f68 '+s1+'% '+s2+'%, #f2ad19 '+s2+'% '+s3+'%, #8c72e8 '+s3+'% '+s4+'%, #728597 '+s4+'% 100%)';

    var attentionRows=rows.filter(function(r){return r.effective_state==='SILENT'||r.effective_state==='NO LOG OBSERVATION';}).sort(function(a,b){if(a.effective_state!==b.effective_state)return a.effective_state==='SILENT'?-1:1;var ar=a.ratio===null?-1:a.ratio,br=b.ratio===null?-1:b.ratio;return br-ar;}).slice(0,7);
    var recent=(audit||[]).slice(0,7);
    var updated=new Date(),z=function(n){return String(n).padStart(2,'0');},updatedText=updated.getFullYear()+'-'+z(updated.getMonth()+1)+'-'+z(updated.getDate())+' '+z(updated.getHours())+':'+z(updated.getMinutes())+':'+z(updated.getSeconds());

    var alertCard=registered===0?'<a href="initial_setup" class="lsw-attention-banner setup"><div class="lsw-attention-symbol">'+icon('alert')+'</div><div><strong>Initial Setup required</strong><span>Configure the first monitoring scope, then use Management → Discover to enroll additional indexes and hosts.</span></div><b>Open setup ›</b></a>':attention?'<a href="silent_hosts" class="lsw-attention-banner"><div class="lsw-attention-symbol">'+icon('alert')+'</div><div><strong>'+attention+' source'+(attention===1?'':'s')+' require review</strong><span>Silent/no-observation sources are correlated with Splunk _internal evidence to narrow the first investigation step.</span></div><b>›</b></a>':'<div class="lsw-attention-banner clear"><div class="lsw-attention-symbol">'+icon('ok')+'</div><div><strong>No sources require review</strong><span>All monitored sources are within policy.</span></div></div>';

    var table=attentionRows.length?attentionRows.map(function(r){var hbCls=r.heartbeat_status==='ALIVE'?'alive':r.heartbeat_status==='STALE'?'stale':'unknown';var hbText=r.heartbeat_status==='ALIVE'?'ALIVE':r.heartbeat_status==='STALE'?'STALE':'NO EVIDENCE';return '<tr><td><b>'+esc(r.host)+'</b></td><td>'+esc(r.index)+'</td><td><span class="lsw-state-pill '+(r.effective_state==='SILENT'?'silent':'noobs')+'">'+esc(r.effective_state)+'</span></td><td class="lsw-age '+(r.effective_state==='SILENT'?'hot':'')+'">'+ageText(r.age_seconds)+'</td><td><span class="lsw-heartbeat-pill '+hbCls+'">'+hbText+'</span></td><td class="lsw-diagnosis">'+esc(r.diagnosis_label)+'</td><td><a href="manage_hosts" class="lsw-row-action">Manage →</a></td></tr>';}).join(''):'<tr><td colspan="7" class="lsw-empty-cell">No sources currently require attention.</td></tr>';
    var changes=recent.length?recent.map(function(a){return '<tr><td>'+fmtEpoch(a.event_time_epoch)+'</td><td><b>'+esc(a.host||'—')+'</b><small>'+esc(a.index||'')+'</small></td><td><span class="lsw-change-dot '+changeClass(a.operation)+'"></span>'+esc(operationLabel(a.operation))+'</td><td>'+esc(a.details||'—')+'</td></tr>';}).join(''):'<tr><td colspan="4" class="lsw-empty-cell">No recent administrative changes available.</td></tr>';

    var licenseNotice=renderLicenseNotice(license,monitored);

    var html=''+
    '<div class="lsw-home-shell">'+
      '<section class="lsw-premium-hero"><div class="lsw-brand-mark"><i></i><i></i></div><div class="lsw-hero-copy"><div class="lsw-home-eyebrow">LOG SOURCE WATCH</div><h1>Log Source Watch</h1><p>Operational monitoring for log source availability and silence detection.</p></div><div class="lsw-health-card '+healthCls+'"><div class="lsw-health-shield">'+icon(health==='GOOD'?'ok':'alert')+'</div><div><span>Operational health</span><strong>'+health+'</strong><small>'+esc(healthDetail)+'</small></div><div class="lsw-health-time"><span>Last updated</span><b>'+updatedText+'</b><button type="button" data-home-action="refresh" title="Refresh">↻</button></div></div></section>'+
      '<section class="lsw-premium-kpis">'+
        kpi('monitored','monitored','MONITORED SOURCES',monitored,'Configured sources in active monitoring',null)+
        kpi('ok','ok','OK',counts.OK,pct(counts.OK,monitored)+'% of monitored',pct(counts.OK,monitored))+
        kpi('silent','silent','SILENT',counts.SILENT,pct(counts.SILENT,monitored)+'% of monitored',pct(counts.SILENT,monitored))+
        kpi('noobs','noobs','NO LOG OBSERVATION',counts['NO LOG OBSERVATION'],pct(counts['NO LOG OBSERVATION'],monitored)+'% of monitored',pct(counts['NO LOG OBSERVATION'],monitored))+
        kpi('maintenance','maintenance','MAINTENANCE',counts.MAINTENANCE,pct(counts.MAINTENANCE,monitored)+'% of monitored',pct(counts.MAINTENANCE,monitored))+
        kpi('retired','retired','RETIRED',counts.RETIRED,'Retained for history',pct(counts.RETIRED,registered))+
      '</section>'+
      licenseNotice+
      '<section class="lsw-home-main-grid"><article class="lsw-home-card lsw-risk-card"><header><div><span class="lsw-card-icon">▥</span><h2>Silence Risk Profile</h2><p>Current monitored population by silence-threshold consumption.</p></div><a href="manage_hosts">Open Management →</a></header>'+renderRisk(rows,monitored)+'</article><aside class="lsw-home-side">'+alertCard+'<article class="lsw-home-card lsw-distribution-card"><header><div><h2>Source State Distribution</h2><p>Current registered source population.</p></div></header><div class="lsw-donut-wrap"><div class="lsw-donut" style="background:'+donut+'"><div><strong>'+registered+'</strong><span>Sources</span></div></div><div class="lsw-donut-legend">'+
        '<div><i class="ok"></i><span>OK</span><b>'+counts.OK+' <small>('+pct(counts.OK,registered)+'%)</small></b></div>'+
        '<div><i class="silent"></i><span>Silent</span><b>'+counts.SILENT+' <small>('+pct(counts.SILENT,registered)+'%)</small></b></div>'+
        '<div><i class="noobs"></i><span>No log observation</span><b>'+counts['NO LOG OBSERVATION']+' <small>('+pct(counts['NO LOG OBSERVATION'],registered)+'%)</small></b></div>'+
        '<div><i class="maintenance"></i><span>Maintenance</span><b>'+counts.MAINTENANCE+' <small>('+pct(counts.MAINTENANCE,registered)+'%)</small></b></div>'+
        '<div><i class="retired"></i><span>Retired</span><b>'+counts.RETIRED+' <small>('+pct(counts.RETIRED,registered)+'%)</small></b></div>'+
      '</div></div></article></aside></section>'+
      '<section class="lsw-home-bottom-grid"><article class="lsw-home-card lsw-attention-table-card"><header><div><span class="lsw-card-icon alert">'+icon('alert')+'</span><h2>Sources Needing Attention</h2><p>Sources outside policy, with _internal correlation for first-step triage.</p></div><a href="manage_hosts">View all sources →</a></header><div class="lsw-table-scroll"><table><thead><tr><th>Host</th><th>Index</th><th>State</th><th>Source age</th><th>_internal</th><th>Diagnosis</th><th></th></tr></thead><tbody>'+table+'</tbody></table></div></article><article class="lsw-home-card lsw-recent-card"><header><div><span class="lsw-card-icon">'+icon('clock')+'</span><h2>Recent Changes</h2><p>Administrative policy and enrollment activity.</p></div><a href="audit_trail">View audit trail →</a></header><div class="lsw-table-scroll"><table><thead><tr><th>Time</th><th>Source</th><th>Change</th><th>Details</th></tr></thead><tbody>'+changes+'</tbody></table></div></article></section>'+
      '<footer class="lsw-premium-footer"><span>Identity <b>index + host</b></span><span>Refresh <b>30 seconds</b></span><span>Policy <b>whole-minute thresholds</b></span><span>State <b>inventory + last_seen + _internal</b></span></footer>'+
    '</div>';
    $(ROOT).html(html);
  }

  function renderError(err){$(ROOT).html('<div class="lsw-home-error"><strong>Could not load operational overview</strong><span>'+esc(err.message||String(err))+'</span><button type="button" data-home-action="refresh">Try again</button></div>');}
  function load(){
    $(ROOT).addClass('is-loading');
    Promise.all([
      kvGet('lsw_inventory',{limit:10000}),
      kvGet('lsw_lastseen',{limit:10000}),
      kvGet('lsw_heartbeat',{limit:10000}).catch(function(){return [];}),
      kvGet('lsw_audit',{sort:'event_time_epoch:-1',limit:8}).catch(function(){return [];}),
      licenseStatus()
    ]).then(function(p){render({inv:p[0],seen:p[1],heartbeat:p[2],audit:p[3],license:p[4]});}).catch(renderError).then(function(){$(ROOT).removeClass('is-loading');});
  }
  $(document).on('click.lswhome','[data-home-action=refresh]',function(){load();});
  timer=window.setInterval(function(){if(!document.hidden)load();},REFRESH_MS);
  $(window).on('unload.lswhome',function(){window.clearInterval(timer);$(document).off('.lswhome');});
  load();
});
