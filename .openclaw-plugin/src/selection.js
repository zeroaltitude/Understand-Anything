// Shared node-selection discovery — the single source of truth for "what
// node(s) is the user currently looking at in the graph canvas", read by both
// ask-widget.js and tours-widget.js (previously each widget that cared kept
// its own private MutationObserver; now there's exactly one discovery).
//
// Two sources, merged:
// 1. The dashboard's own store mirror (window.uaDashboardSelection +
//    "ua:selection" CustomEvent) — the reliable path. The dashboard tracks
//    selection in its Zustand store and does NOT use React Flow's built-in
//    node selection, so DOM classes alone can't see it (this exact gap made
//    the Ask widget claim "nothing selected" while the INFO panel clearly
//    showed a focused node — found live 2026-07-16).
// 2. React Flow's ".react-flow__node.selected" class — kept as a fallback
//    for older dashboard builds that predate the store mirror.
//
// Must be loaded before ask-widget.js/tours-widget.js — see WIDGET_SCRIPT_TAGS
// in interactive-server.ts.
(function () {
  "use strict";

  var selectedNodeIds = [];
  var subscribers = [];

  function sameIds(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function currentIds() {
    var ids = [];
    var seen = {};
    var fromStore = window.uaDashboardSelection;
    if (Array.isArray(fromStore)) {
      fromStore.forEach(function (id) {
        if (typeof id === "string" && id && !seen[id]) {
          seen[id] = true;
          ids.push(id);
        }
      });
    }
    var nodes = document.querySelectorAll(".react-flow__node.selected");
    Array.prototype.forEach.call(nodes, function (n) {
      var id = n.getAttribute("data-id");
      if (id && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    });
    return ids;
  }

  function refresh() {
    var next = currentIds();
    if (sameIds(next, selectedNodeIds)) return;
    selectedNodeIds = next;
    subscribers.forEach(function (cb) { cb(selectedNodeIds.slice()); });
  }

  window.uaSelection = {
    // Current selection snapshot — a plain array of graph node ids.
    get: function () { return selectedNodeIds.slice(); },
    // Called with the new selection (array of ids) whenever it changes.
    // Returns an unsubscribe function.
    subscribe: function (cb) {
      subscribers.push(cb);
      return function () { subscribers = subscribers.filter(function (s) { return s !== cb; }); };
    },
  };

  function start() {
    // Primary: the dashboard store mirror announces every selection change.
    window.addEventListener("ua:selection", refresh);
    // Fallback: React Flow toggles the "selected" class on node elements in
    // builds that still use built-in selection.
    var observer = new MutationObserver(refresh);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
