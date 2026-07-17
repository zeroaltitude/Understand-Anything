// Engine-view chip — shown only when a graphify companion graph exists for
// this project. Toggles which engine's graph the dashboard renders
// (POST /engine-view.json, then reload so the React app refetches). The
// graphify view is a companion/debugging lens on the same project; the
// native (or merged) graph stays the primary experience.
(function () {
  "use strict";

  var TOKEN = new URLSearchParams(window.location.search).get("token") || "";
  if (!TOKEN) return;

  var STYLE =
    "#ua-engine-chip{position:fixed;bottom:24px;left:24px;z-index:9999;background:#0d1117;color:#e6edf3;" +
    "border:1px solid #30363d;border-radius:20px;padding:6px 14px;font-size:12px;cursor:pointer;" +
    "font-family:system-ui,-apple-system,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);display:flex;gap:6px;align-items:center;}\n" +
    "#ua-engine-chip:hover{border-color:#8b949e;}\n" +
    "#ua-engine-chip .ua-engine-active{color:#58a6ff;font-weight:600;}\n";

  function init() {
    fetch("engine-view.json", { headers: { "X-Ask-Token": TOKEN } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.graphifyAvailable) return; // nothing to toggle to

        var style = document.createElement("style");
        style.textContent = STYLE;
        document.head.appendChild(style);

        var chip = document.createElement("button");
        chip.id = "ua-engine-chip";
        chip.title = "Toggle which engine's graph the dashboard shows";
        function render(engine) {
          chip.innerHTML = "";
          ["native", "graphify"].forEach(function (name, i) {
            if (i > 0) chip.appendChild(document.createTextNode(" ⇄ "));
            var span = document.createElement("span");
            span.textContent = name;
            if (name === engine) span.className = "ua-engine-active";
            chip.appendChild(span);
          });
        }
        render(data.engine);

        chip.addEventListener("click", function () {
          fetch("engine-view.json", { headers: { "X-Ask-Token": TOKEN } })
            .then(function (res) { return res.json(); })
            .then(function (current) {
              var next = current.engine === "graphify" ? "native" : "graphify";
              return fetch("engine-view.json", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Ask-Token": TOKEN },
                body: JSON.stringify({ engine: next }),
              });
            })
            .then(function () { window.location.reload(); })
            .catch(function () { /* leave the chip as-is on failure */ });
        });

        document.body.appendChild(chip);
      })
      .catch(function () { /* endpoint unavailable — no chip */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
