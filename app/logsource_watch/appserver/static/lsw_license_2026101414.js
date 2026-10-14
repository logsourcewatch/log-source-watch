require([
    "jquery",
    "splunk.util",
    "splunkjs/mvc/simplexml/ready!"
], function($, SplunkUtil) {
    "use strict";

    var ROOT = "#lsw-license-root";
    var endpointCandidates = [
        SplunkUtil.make_url("/splunkd/__raw/servicesNS/nobody/logsource_watch/lsw/license"),
        SplunkUtil.make_url("/splunkd/__raw/services/lsw/license")
    ];
    var activeEndpoint = endpointCandidates[0];
    var selectedText = "";
    var selectedDoc = null;
    var currentStatus = null;

    function esc(value) {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function formHeaders() {
        var headers = {"X-Requested-With": "XMLHttpRequest"};
        try {
            if (typeof window.getFormKey === "function") {
                var key = window.getFormKey();
                if (key) headers["X-Splunk-Form-Key"] = key;
            }
        } catch (e) {}
        return headers;
    }

    function showAlert(message, kind) {
        var $a = $("#lsw-license-alert");
        $a.removeClass("ok warn bad").addClass(kind || "warn").text(message).show();
    }

    function entitlement(value) { return Number(value || 0) ? "Entitled" : "Not entitled"; }

    function renderStatus(status) {
        currentStatus = status || {};
        var edition = status.edition || "Community";
        var licenseStatus = String(status.license_status || "UNKNOWN").toUpperCase();
        var customer = status.customer || (licenseStatus === "COMMUNITY" ? "Community" : "—");
        var expires = status.expires_at || "Not applicable";
        var days = status.days_remaining;
        var max = Number(status.max_monitored_sources || 0);
        var monitored = Number(status.monitored_sources || 0);
        var pct = max > 0 ? Math.max(0, Math.min(100, monitored / max * 100)) : (monitored > 0 ? 100 : 0);

        $("#lsw-license-edition").text(licenseStatus + " · " + edition);
        $("#lsw-license-message").text(status.message || "");
        $("#lsw-license-capacity").text(status.capacity_text || (monitored + " / " + (max > 0 ? max : "Unlimited")));
        $("#lsw-license-meter").css("width", pct + "%");
        var $meter = $("#lsw-license-meter").parent().removeClass("warn bad");
        if (max > 0 && pct >= 100) $meter.addClass("bad");
        else if (max > 0 && pct >= 80) $meter.addClass("warn");

        $("#lsw-license-status").text(licenseStatus);
        $("#lsw-license-customer").text(customer);
        $("#lsw-license-id").text(status.license_id || "—");
        $("#lsw-license-expires").text(expires);
        $("#lsw-license-days").text(days === "" || days === null || days === undefined ? "" : (days + " days remaining"));
        $("#lsw-license-shc").text(entitlement(status.shc_allowed));
        $("#lsw-license-multi").text(entitlement(status.multiple_search_heads_allowed));
        $("#lsw-license-msp").text(entitlement(status.managed_service_allowed));
        $("#lsw-license-redist").text(entitlement(status.redistribution_allowed));

        var shc = Number(status.environment_shc || 0) === 1;
        $("#lsw-license-shc-note").toggle(shc);
        $("#lsw-license-file").prop("disabled", shc);
        $("#lsw-license-install").prop("disabled", shc || !selectedText);
        $(".lsw-license-drop").css("opacity", shc ? 0.55 : 1);
    }

    function requestStatusAt(index, showMessage, deferred, lastDetail) {
        if (index >= endpointCandidates.length) {
            showAlert(
                "Licensing endpoint is unavailable in the Log Source Watch app namespace." +
                (lastDetail ? " " + lastDetail : ""),
                "bad"
            );
            deferred.reject();
            return;
        }
        $.ajax({
            url: endpointCandidates[index],
            method: "GET",
            dataType: "json",
            cache: false,
            headers: formHeaders()
        }).done(function(resp) {
            if (!resp || !resp.ok) {
                var msg = (resp && (resp.error || resp.message)) || "Unable to read license status.";
                requestStatusAt(index + 1, showMessage, deferred, msg);
                return;
            }
            activeEndpoint = endpointCandidates[index];
            renderStatus(resp.status || {});
            if (showMessage) showAlert("License status refreshed.", "ok");
            else $("#lsw-license-alert").hide();
            deferred.resolve(resp);
        }).fail(function(xhr) {
            var detail = xhr && xhr.responseText ? String(xhr.responseText).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220) : "";
            requestStatusAt(index + 1, showMessage, deferred, detail);
        });
    }

    function loadStatus(showMessage) {
        var deferred = $.Deferred();
        $("#lsw-license-refresh").prop("disabled", true);
        requestStatusAt(0, showMessage, deferred, "");
        deferred.always(function() {
            $("#lsw-license-refresh").prop("disabled", false);
        });
        return deferred.promise();
    }

    function previewDocument(doc, filename) {
        var bits = [];
        bits.push("<b>" + esc(filename) + "</b>");
        bits.push("Edition: " + esc(doc.edition || "—"));
        bits.push("Customer: " + esc(doc.customer || "—"));
        bits.push("License ID: " + esc(doc.license_id || "—"));
        bits.push("Capacity: " + esc(Number(doc.max_monitored_sources || 0) > 0 ? doc.max_monitored_sources : "Unlimited"));
        bits.push("Expires: " + esc(doc.expires_at || "—"));
        $("#lsw-license-preview").html(bits.join("<br>")).show();
    }

    $(ROOT).on("change", "#lsw-license-file", function(evt) {
        selectedText = "";
        selectedDoc = null;
        $("#lsw-license-preview").hide().empty();
        var file = evt.target.files && evt.target.files[0];
        if (!file) {
            $("#lsw-license-file-name").text("No file selected");
            $("#lsw-license-install").prop("disabled", true);
            return;
        }
        $("#lsw-license-file-name").text(file.name);
        if (file.size > 64 * 1024) {
            showAlert("License file is larger than the 64 KiB safety limit.", "bad");
            return;
        }
        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                selectedText = String(e.target.result || "");
                selectedDoc = JSON.parse(selectedText);
                if (!selectedDoc || typeof selectedDoc !== "object" || Array.isArray(selectedDoc)) throw new Error("License JSON must be an object");
                previewDocument(selectedDoc, file.name);
                var shc = currentStatus && Number(currentStatus.environment_shc || 0) === 1;
                $("#lsw-license-install").prop("disabled", shc || !selectedText);
            } catch (err) {
                selectedText = "";
                selectedDoc = null;
                showAlert("The selected file is not valid license JSON: " + err.message, "bad");
                $("#lsw-license-install").prop("disabled", true);
            }
        };
        reader.onerror = function() {
            showAlert("Unable to read the selected license file.", "bad");
        };
        reader.readAsText(file);
    });

    $(ROOT).on("click", "#lsw-license-install", function() {
        if (!selectedText) return;
        var $btn = $(this).prop("disabled", true).text("Validating…");
        $.ajax({
            url: activeEndpoint || endpointCandidates[0],
            method: "POST",
            dataType: "json",
            headers: formHeaders(),
            data: { license: selectedText }
        }).done(function(resp) {
            if (!resp || !resp.ok) {
                showAlert((resp && (resp.error || resp.message)) || "License installation failed.", "bad");
                return;
            }
            showAlert(resp.message || "License installed successfully.", "ok");
            if (resp.status) renderStatus(resp.status);
            selectedText = "";
            selectedDoc = null;
            $("#lsw-license-file").val("");
            $("#lsw-license-file-name").text("No file selected");
            $("#lsw-license-preview").hide().empty();
        }).fail(function(xhr) {
            var detail = xhr && xhr.responseText ? String(xhr.responseText).slice(0, 500) : "";
            showAlert("License installation request failed." + (detail ? " " + detail : ""), "bad");
        }).always(function() {
            $btn.text("Validate and install");
            var shc = currentStatus && Number(currentStatus.environment_shc || 0) === 1;
            $btn.prop("disabled", shc || !selectedText);
        });
    });

    $(ROOT).on("click", "#lsw-license-refresh", function() { loadStatus(true); });

    loadStatus(false);
});
