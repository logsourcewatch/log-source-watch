require([
  "jquery",
  "splunkjs/mvc",
  "splunkjs/mvc/simplexml/ready!"
], function($, mvc) {
  "use strict";
  var defaults = mvc.Components.getInstance("default");
  var submitted = mvc.Components.getInstance("submitted");
  var inFlight = false;

  function configuredRedirect() {
    var service = mvc.createService();
    var apps = service.apps();
    apps.fetch(function(err, collection) {
      if (err) { console.error("LSW setup: unable to fetch app entity", err); return; }
      var app = collection.item("logsource_watch");
      if (!app) { console.error("LSW setup: app entity not found"); return; }
      app.update({ configured: true }, function(updateErr) {
        inFlight = false;
        if (updateErr) { console.error("LSW setup: unable to mark app configured", updateErr); return; }
        window.setTimeout(function() {
          window.location.href = window.location.pathname.replace(/\/initial_setup(?:\?.*)?$/, "/overview");
        }, 500);
      });
    });
  }

  function maybeComplete(value) {
    if (inFlight || !value) return;
    if (String(value).indexOf("Initialization complete") !== 0) return;
    inFlight = true;
    configuredRedirect();
  }

  if (defaults) {
    defaults.on("change:setup_message", function(model, value) { maybeComplete(value); });
    maybeComplete(defaults.get("setup_message"));
  }
  if (submitted) {
    submitted.on("change:setup_message", function(model, value) { maybeComplete(value); });
  }
});
