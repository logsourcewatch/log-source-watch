/* Log Source Watch - Sourcetype policy threshold editor
 * Capture-phase handler intentionally owns [data-threshold] clicks so the beta
 * workspace can read the modal value before the modal DOM is removed.
 */
require(["jquery","splunkjs/mvc","splunkjs/mvc/simplexml/ready!"], function($, mvc) {
    "use strict";
    var APP="logsource_watch";
    var service=mvc.createService({owner:"nobody",app:APP});

    function esc(v){return String(v===null||v===undefined?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
    function parse(data){if(typeof data==="string"){try{return JSON.parse(data);}catch(e){return data;}}return data;}
    function errText(v){if(!v)return"Unknown KV Store error";if(v.message)return String(v.message);if(v.statusText)return String(v.statusText);if(v.responseText){try{var p=JSON.parse(v.responseText);return p&&p.messages&&p.messages[0]?p.messages[0].text:JSON.stringify(p);}catch(e){return String(v.responseText).slice(0,400);}}return String(v);}
    function get(collection,key){return new Promise(function(resolve,reject){service.get("storage/collections/data/"+collection+"/"+encodeURIComponent(key),{},function(err,res){if(err){reject(new Error(errText(err)));return;}resolve(parse(res&&res.data!==undefined?res.data:res));});});}
    function batch(collection,docs){return new Promise(function(resolve,reject){service.request("storage/collections/data/"+collection+"/batch_save","POST",null,null,JSON.stringify(docs),{"Content-Type":"application/json"},null).done(function(d){resolve(parse(d));}).fail(function(e){reject(new Error(errText(e)));});});}
    function createAudit(doc){return new Promise(function(resolve,reject){service.request("storage/collections/data/lsw_audit","POST",null,null,JSON.stringify(doc),{"Content-Type":"application/json"},null).done(function(d){resolve(parse(d));}).fail(function(e){reject(new Error(errText(e)));});});}
    function username(){return new Promise(function(resolve){service.get("authentication/current-context",{},function(err,res){if(err){resolve("unknown");return;}var d=res&&res.data?res.data:res;resolve(String(d&&d.username||(d&&d.entry&&d.entry[0]&&d.entry[0].content&&d.entry[0].content.username)||"unknown"));});});}
    function toast(msg,type){var $root=$("#lsw-toasts");if(!$root.length)return;var $t=$('<div class="lsw-toast '+(type||"success")+'"><span class="lsw-toast-icon">'+(type==="error"?"!":"✓")+'</span><div>'+esc(msg)+'</div></div>');$root.append($t);setTimeout(function(){$t.addClass("show");},10);setTimeout(function(){$t.removeClass("show");setTimeout(function(){$t.remove();},250);},4200);}

    function editor(key){
        if(!/^[a-f0-9]{64}$/i.test(String(key||"")))return;
        Promise.all([get("lsw_feed_inventory",key),username()]).then(function(parts){
            var policy=parts[0],actor=parts[1],current=Math.round(Number(policy.threshold_seconds||7200)/60);
            var $m=$("#lsw-modal"),$b=$("#lsw-modal-backdrop");
            $b.removeAttr("hidden");
            $m.removeAttr("hidden").html('<div class="lsw-modal-head"><h3>Change feed threshold</h3></div><div class="lsw-modal-body"><p><b>'+esc(policy.host)+'</b><br><span class="lsw-mono">'+esc(policy.sourcetype)+'</span></p><label class="lsw-control-label">New threshold</label><div class="lsw-inline-control"><input id="lsw-feed-safe-threshold" type="number" min="1" max="10080" step="1" value="'+current+'"/><span>minutes</span></div></div><div class="lsw-modal-actions"><button class="lsw-btn lsw-btn-ghost" id="lsw-feed-safe-cancel">Cancel</button><button class="lsw-btn lsw-btn-primary" id="lsw-feed-safe-save">Save threshold</button></div>');
            function close(){$m.attr("hidden",true).empty();$b.attr("hidden",true);}
            $("#lsw-feed-safe-cancel").one("click",close);
            $("#lsw-feed-safe-save").one("click",function(){
                var minutes=Number($("#lsw-feed-safe-threshold").val());
                if(!isFinite(minutes)||minutes<1||minutes>10080||Math.floor(minutes)!==minutes){toast("Threshold must be a whole number between 1 and 10080 minutes","error");return;}
                var old=Number(policy.threshold_seconds||7200),now=Math.floor(Date.now()/1000);
                policy.threshold_seconds=minutes*60;policy.updated_at=now;policy.change_ref="ui-feed-threshold";
                $(this).prop("disabled",true).text("Saving…");
                batch("lsw_feed_inventory",[policy]).then(function(){
                    return get("lsw_feed_state",key).catch(function(){return null;});
                }).then(function(st){
                    if(st){st.threshold_seconds=minutes*60;st.threshold_minutes=minutes;st.state_updated_at=now;return batch("lsw_feed_state",[st]);}
                }).then(function(){
                    return createAudit({event_time_epoch:now,actor:actor,scope:"feed_policy",operation:"feed_threshold_change",index:policy.index,host:policy.host,sourcetype:policy.sourcetype,old_status:"",new_status:"",old_threshold_seconds:old,new_threshold_seconds:minutes*60,old_maintenance_until:0,new_maintenance_until:0,change_ref:"ui-feed-threshold",details:"Sourcetype threshold changed to "+minutes+" minutes"});
                }).then(function(){close();toast("Feed threshold updated");window.setTimeout(function(){window.location.reload();},350);}).catch(function(e){toast(e.message||String(e),"error");$("#lsw-feed-safe-save").prop("disabled",false).text("Save threshold");});
            });
        }).catch(function(e){toast(e.message||String(e),"error");});
    }

    document.addEventListener("click",function(ev){var t=ev.target&&ev.target.closest?ev.target.closest("[data-threshold]"):null;if(!t)return;ev.preventDefault();ev.stopPropagation();if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();editor(t.getAttribute("data-threshold"));},true);
});
