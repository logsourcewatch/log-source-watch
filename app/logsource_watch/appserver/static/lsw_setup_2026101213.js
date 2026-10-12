/* Log Source Watch - Initial Setup
 * Read-only source discovery + authenticated KV Store writes.
 */
require([
  "jquery",
  "splunkjs/mvc",
  "splunkjs/mvc/searchmanager",
  "splunkjs/mvc/simplexml/ready!"
], function($, mvc, SearchManager) {
  "use strict";

  var APP = "logsource_watch";
  var MAX_ENROLL = 10000;
  var seq = 0;
  var busy = false;
  var allowedEarliest = {"-1h":1,"-6h":1,"-24h":1,"-7d":1,"-30d":1};

  var defaults = mvc.Components.getInstance("default");
  var submitted = mvc.Components.getInstance("submitted");
  var kvService = mvc.createService({ owner: "nobody", app: APP });

  function spl(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function token(name) {
    var v = defaults ? defaults.get(name) : undefined;
    if (v === undefined || v === null || v === "") {
      v = defaults ? defaults.get("form." + name) : undefined;
    }
    return v;
  }

  function setMessage(value) {
    if (defaults) defaults.set("setup_message", value);
    if (submitted) submitted.set("setup_message", value);
  }

  function resetAction() {
    ["setup_action","form.setup_action"].forEach(function(k) {
      try { if (defaults) defaults.unset(k); } catch (e) {}
      try { if (submitted) submitted.unset(k); } catch (e2) {}
    });
  }

  function rowsFromPayload(p) {
    if (!p) return [];
    if (p.results && $.isArray(p.results)) return p.results;
    var f = p.fields || [], r = p.rows || [];
    if (!r.length) return [];
    var names = f.map(function(x){ return typeof x === "string" ? x : x.name; });
    return r.map(function(row) {
      var o = {};
      names.forEach(function(n, i){ o[n] = row[i]; });
      return o;
    });
  }

  function cleanupManager(id) {
    setTimeout(function() {
      try {
        if (mvc.Components && mvc.Components.revokeInstance) mvc.Components.revokeInstance(id);
      } catch (e) {}
    }, 0);
  }

  function runSearch(search, timeoutMs) {
    timeoutMs = timeoutMs || 45000;
    return new Promise(function(resolve, reject) {
      var id = "lsw_setup_" + Date.now() + "_" + (++seq);
      var settled = false, timer, manager, results;

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
        else if (message && message.content && message.content.messages && message.content.messages[0]) {
          detail = message.content.messages[0].text || JSON.stringify(message.content.messages[0]);
        } else if (message && message.statusText) detail = message.statusText;
        else {
          try { detail = JSON.stringify(message || {}); }
          catch (e) { detail = String(message); }
        }
        finish(reject, new Error(prefix + (detail ? ": " + detail : "")));
      }

      function consume() {
        try {
          if (results && results.hasData && results.hasData() && results.collection) {
            finish(resolve, results.collection().toJSON() || []);
            return true;
          }
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
        results = manager.data("results", { count: 0, output_mode: "json" });
        results.on("data", consume);
        results.on("error", function(message){ fail("Result retrieval failed", message); });
        manager.on("search:error", function(message){ fail("Search error", message); });
        manager.on("search:failed", function(message){ fail("Search failed", message); });
        manager.on("search:fail", function(message){ fail("Search failed", message); });
        manager.on("search:cancelled", function(){ fail("Search was cancelled"); });
        manager.on("search:done", function(props) {
          var c = props && props.content ? Number(props.content.resultCount || 0) : 0;
          if (c === 0) {
            finish(resolve, []);
            return;
          }
          if (!consume() && results && typeof results.fetch === "function") {
            try { results.fetch(); } catch (e) {}
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
      } catch (e) {
        return String(v.responseText).slice(0, 500);
      }
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
  function safeKey(k) { return /^[a-f0-9]{64}$/i.test(String(k || "")); }

  function licenseStatusQuery() {
    return '| lswlicense'
      + ' | appendcols [ | inputlookup lsw_inventory'
      + ' | where status="active" OR status="maintenance"'
      + ' | stats count AS monitored_sources ]'
      + ' | eval monitored_sources=coalesce(monitored_sources,0)'
      + ' | fields license_status license_valid edition customer license_id'
      + ' max_monitored_sources shc_allowed deployment_compliant'
      + ' monitored_sources message expires_at';
  }

  function assertLicenseCapacity(increment) {
    increment = Math.max(0, Number(increment || 0));
    return runSearch(licenseStatusQuery(), 30000).then(function(rows) {
      var x = rows && rows[0] ? rows[0] : {};
      var compliant = Number(x.deployment_compliant === undefined ? 1 : x.deployment_compliant);
      if (compliant !== 1) {
        throw new Error(x.message || "Current deployment is not permitted by the active Log Source Watch license");
      }
      if (String(x.license_status || "").toUpperCase() === "EXPIRED" && increment > 0) {
        throw new Error(x.message || "Paid Log Source Watch license has expired. Existing monitoring continues, but monitored-source capacity cannot be increased until renewal.");
      }
      var current = Math.max(0, Number(x.monitored_sources || 0));
      var max = Number(x.max_monitored_sources || 100);
      var projected = current + increment;
      if (max > 0 && projected > max) {
        throw new Error(
          "License capacity exceeded: this action would result in "
          + projected.toLocaleString()
          + " monitored sources, but "
          + (x.edition || "Community")
          + " permits "
          + max.toLocaleString()
          + ". Retired sources do not count toward capacity."
        );
      }
      return {edition:x.edition || "Community", current:current, max:max, projected:projected};
    });
  }

  function username() {
    return runSearch('| rest /services/authentication/current-context | head 1 | fields username', 15000)
      .then(function(rows) {
        return String(rows && rows[0] && rows[0].username || "unknown");
      })
      .catch(function(){ return "unknown"; });
  }

  function discoveryQuery(index, earliest) {
    return '| tstats latest(_time) AS observed_last_seen WHERE index="'
      + spl(index)
      + '" earliest='
      + earliest
      + ' latest=now BY index host'
      + ' | where len(host)>0 AND len(host)<=255 AND NOT match(host,"[\\x00-\\x1F\\x7F*?]")'
      + ' | eval _key=sha256(index."|".host)'
      + ' | lookup local=true lsw_inventory _key'
      + ' OUTPUT status AS existing_status threshold_seconds AS existing_threshold'
      + ' maintenance_until AS existing_maintenance change_ref AS existing_ref'
      + ' created_at AS existing_created'
      + ' | table _key index host observed_last_seen existing_status existing_threshold'
      + ' existing_maintenance existing_ref existing_created'
      + ' | sort 0 index host'
      + ' | head ' + (MAX_ENROLL + 1);
  }

  function canonicalState(inv, ls) {
    var now = nowEpoch();
    var status = String(inv.status || "active").toLowerCase();
    var threshold = Number(inv.threshold_seconds || 7200);
    var until = Number(inv.maintenance_until || 0);
    var last = Number(ls.last_seen);
    var age = isFinite(last) ? Math.max(0, now-last) : null;
    var effective;

    if (status === "retired") effective = "RETIRED";
    else if (status === "maintenance" && (until === 0 || until > now)) effective = "MAINTENANCE";
    else if (age === null) effective = "NO LOG OBSERVATION";
    else if (age > threshold) effective = "SILENT";
    else effective = "OK";

    return {
      _key: inv._key,
      index: inv.index,
      host: inv.host,
      status: status,
      threshold_seconds: threshold,
      threshold_minutes: Math.round(threshold/60),
      maintenance_until: until,
      change_ref: inv.change_ref,
      last_seen: isFinite(last) ? last : null,
      lastseen_updated_at: ls.updated_at,
      age_seconds: age,
      age_minutes: age === null ? null : Math.round(age/6)/10,
      effective_state: effective,
      alarm: effective === "SILENT" ? 1 : 0,
      state_updated_at: now
    };
  }

  function documents(rows, thresholdSeconds, actor) {
    var now = nowEpoch();
    var inventory = [], lastseen = [], states = [], audits = [];
    var newCount = 0;

    rows.forEach(function(c) {
      if (!c || !safeKey(c._key) || !c.index || !c.host) return;

      var isNew = !String(c.existing_status || "").trim();
      if (isNew) newCount += 1;

      var seen = Number(c.observed_last_seen);
      var status = isNew ? "active" : String(c.existing_status || "active").toLowerCase();
      var threshold = isNew ? thresholdSeconds : Number(c.existing_threshold || thresholdSeconds);
      var maintenance = isNew ? 0 : Number(c.existing_maintenance || 0);
      var changeRef = isNew ? "setup-initial-enrollment" : String(c.existing_ref || "setup-refresh");
      var created = isNew ? now : Number(c.existing_created || now);

      var inv = {
        _key: String(c._key),
        index: String(c.index),
        host: String(c.host),
        status: status,
        threshold_seconds: threshold,
        maintenance_until: maintenance,
        change_ref: changeRef,
        created_at: created,
        updated_at: now
      };

      var ls = {
        _key: String(c._key),
        index: String(c.index),
        host: String(c.host),
        last_seen: isFinite(seen) ? seen : null,
        updated_at: now
      };

      inventory.push(inv);
      if (isFinite(seen)) lastseen.push(ls);
      states.push(canonicalState(inv, ls));

      if (isNew) {
        audits.push({
          event_time_epoch: now,
          actor: actor || "unknown",
          scope: "initial_setup",
          operation: "source_enrolled",
          index: String(c.index),
          host: String(c.host),
          old_status: "",
          new_status: "active",
          old_threshold_seconds: 0,
          new_threshold_seconds: threshold,
          old_maintenance_until: 0,
          new_maintenance_until: 0,
          change_ref: "setup-initial-enrollment",
          details: "Source enrolled by Initial Setup"
        });
      }
    });

    return {inventory:inventory, lastseen:lastseen, states:states, audits:audits, newCount:newCount};
  }

  function markConfiguredAndRedirect(count) {
    var service = mvc.createService();
    var apps = service.apps();
    apps.fetch(function(err, collection) {
      if (err) {
        busy = false;
        setMessage("Initialization data was written, but Splunk could not load app configuration for finalization: " + String(err.message || err));
        resetAction();
        return;
      }
      var app = collection.item(APP);
      if (!app) {
        busy = false;
        setMessage("Initialization data was written, but Splunk could not locate the Log Source Watch app entity to mark setup complete.");
        resetAction();
        return;
      }
      app.update({ configured: true }, function(updateErr) {
        if (updateErr) {
          busy = false;
          setMessage("Initialization data was written, but Splunk could not mark the app configured. Check app write permissions before continuing.");
          resetAction();
          return;
        }
        setMessage(
          "Initialization complete. "
          + count.toLocaleString()
          + " sources are registered. Opening Overview; use Management → Discover to add additional source scopes."
        );
        window.setTimeout(function() {
          window.location.href = window.location.pathname.replace(/\/initial_setup(?:\?.*)?$/, "/overview");
        }, 1800);
      });
    });
  }

  function initialize() {
    if (busy) return;

    var index = String(token("setup_index") || "");
    var earliest = String(token("setup_earliest") || "-24h");
    var thresholdSeconds = Number(token("setup_threshold") || 7200);

    if (!index || index === "-") {
      setMessage("Select an index before initializing Log Source Watch.");
      resetAction();
      return;
    }
    if (!allowedEarliest[earliest]) {
      setMessage("Invalid baseline lookback.");
      resetAction();
      return;
    }
    if (!isFinite(thresholdSeconds) || thresholdSeconds < 60 || thresholdSeconds > 604800) {
      setMessage("Invalid silence threshold.");
      resetAction();
      return;
    }

    busy = true;
    resetAction();
    setMessage("Initializing Log Source Watch: discovering the selected first source scope…");

    var actor = "unknown";
    var docs;

    Promise.all([runSearch(discoveryQuery(index, earliest), 90000), username()])
    .then(function(values) {
      var rows = values[0] || [];
      actor = values[1] || "unknown";

      if (!rows.length) {
        throw new Error("No eligible index + host sources were found in the selected index and baseline window.");
      }
      if (rows.length > MAX_ENROLL) {
        throw new Error("Initial Setup found more than " + MAX_ENROLL.toLocaleString() + " sources. Narrow the first source scope and enroll additional sources later from Management → Discover.");
      }

      docs = documents(rows, thresholdSeconds, actor);
      if (!docs.inventory.length) throw new Error("No valid sources were available for enrollment.");

      setMessage("Checking license capacity for " + docs.newCount.toLocaleString() + " new monitored sources…");
      return assertLicenseCapacity(docs.newCount);
    }).then(function() {
      setMessage("Writing source inventory…");
      return kvBatchSave("lsw_inventory", docs.inventory);
    }).then(function() {
      setMessage("Seeding latest observations…");
      return kvBatchSave("lsw_lastseen", docs.lastseen);
    }).then(function() {
      setMessage("Building canonical monitoring state…");
      return kvBatchSave("lsw_state", docs.states);
    }).then(function() {
      setMessage("Writing initialization audit records…");
      return kvBatchSave("lsw_audit", docs.audits);
    }).then(function() {
      setMessage("Verifying initialized state…");
      return runSearch(
        '| inputlookup lsw_inventory | stats count AS inventory'
        + ' | appendcols [ | inputlookup lsw_lastseen | stats count AS lastseen ]'
        + ' | appendcols [ | inputlookup lsw_state | stats count AS state ]'
        + ' | fields inventory lastseen state',
        30000
      );
    }).then(function(vrows) {
      var v = vrows && vrows[0] ? vrows[0] : {};
      var inventory = Number(v.inventory || 0);
      var state = Number(v.state || 0);

      if (inventory <= 0) throw new Error("Verification failed: inventory is still empty after KV Store write.");
      if (state !== inventory) {
        throw new Error("Verification failed: inventory contains " + inventory + " sources but canonical state contains " + state + ".");
      }

      markConfiguredAndRedirect(inventory);
    }).catch(function(err) {
      busy = false;
      resetAction();
      setMessage("Initial Setup failed: " + String(err && err.message ? err.message : err));
      if (window.console && console.error) console.error("Log Source Watch Initial Setup failed", err);
    });
  }

  function bindTokens(model) {
    if (!model) return;
    model.on("change:setup_request_nonce", function() { initialize(); });
  }

  bindTokens(defaults);
  bindTokens(submitted);
});
