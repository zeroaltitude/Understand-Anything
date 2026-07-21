// Code City bootstrap + HUD: fetches the graph (+ diff overlay), builds the
// model, drives the renderer, and bridges picks into the shared selection
// contract (window.uaDashboardSelection + "ua:selection") so the standard
// Ask widget — conversation history, grounding and all — works inside the
// city exactly as it does on the 2D dashboard.
import { buildCityModel } from "./city-model.js";
import { createCityView } from "./city-view.js";

const TOKEN = new URLSearchParams(window.location.search).get("token") || "";

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  (children || []).forEach((c) => e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return e;
}

function publishSelection(nodeIds) {
  window.uaDashboardSelection = nodeIds;
  window.dispatchEvent(new CustomEvent("ua:selection", { detail: nodeIds }));
}

async function fetchJson(path, optional = false) {
  const res = await fetch(`${path}?token=${encodeURIComponent(TOKEN)}`);
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

function loadWidgetScripts() {
  // selection.js must register before ask-widget.js reads it (same ordering
  // contract as the dashboard's WIDGET_SCRIPT_TAGS injection).
  const selection = document.createElement("script");
  selection.src = "selection.js";
  selection.onload = () => {
    const ask = document.createElement("script");
    ask.src = "ask-widget.js";
    document.body.appendChild(ask);
  };
  document.body.appendChild(selection);
}

function heatBadge(heat) {
  if (heat === "hot") return el("span", { class: "hot" }, ["● changed"]);
  if (heat === "warm") return el("span", { class: "warm" }, ["● affected"]);
  return el("span", { class: "cold" }, ["unchanged"]);
}

async function main() {
  const statusEl = document.getElementById("city-status");
  try {
    const [graph, overlay] = await Promise.all([
      fetchJson("knowledge-graph.json"),
      fetchJson("diff-overlay.json", true),
    ]);
    const model = buildCityModel(graph, overlay);
    statusEl.remove();

    const info = document.getElementById("city-info");
    const view = createCityView(document.getElementById("city-canvas"), model, {
      onBuildingPick(b, d) {
        publishSelection([b.primaryNodeId]);
        info.innerHTML = "";
        info.appendChild(el("h3", {}, [b.name]));
        info.appendChild(el("div", { class: "path" }, [b.filePath]));
        info.appendChild(el("div", {}, [heatBadge(b.heat)]));
        info.appendChild(
          el("div", { class: "meta" }, [
            `${b.nodeIds.length} node(s) · ${Object.entries(b.typeCounts).map(([t, n]) => `${n} ${t}`).join(", ")}`,
          ]),
        );
        info.appendChild(el("div", { class: "meta" }, [`district: ${d.name}`]));
        info.appendChild(el("div", { class: "hint" }, ["Grounded for Ask (💬) — ask about this file."]));
        info.classList.add("open");
      },
      onDistrictPick(d) {
        view.flyTo(d.x, d.z, d.radius * 3.2);
      },
      onClear() {
        publishSelection([]);
        info.classList.remove("open");
      },
    });

    // ── Search: fuzzy-ish substring over building names/paths → fly ─────────
    const search = document.getElementById("city-search");
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = search.value.trim().toLowerCase();
      if (!q) return;
      for (const d of model.districts) {
        const b = d.buildings.find((b) => b.name.toLowerCase().includes(q) || b.filePath.toLowerCase().includes(q));
        if (b) {
          view.flyTo(d.x + b.x, d.z + b.z, 120);
          return;
        }
      }
    });

    // ── Storm list: districts by heat (only when there's weather) ────────────
    const hud = document.getElementById("city-hud");
    if (model.weather && (model.weather.hotBuildings || model.weather.warmBuildings)) {
      const storms = [...model.districts].filter((d) => d.heat > 0).sort((a, b) => b.heat - a.heat);
      const panel = el("div", { id: "city-storms" }, [
        el("h4", {}, [`⛈ Change weather — ${model.weather.source}`]),
        el("div", { class: "meta" }, [`${model.weather.hotBuildings} changed, ${model.weather.warmBuildings} affected file(s)`]),
      ]);
      storms.slice(0, 8).forEach((d) => {
        const row = el("button", { class: "storm-row" }, [
          `${d.name} — ${Math.round(d.heat * 100)}% (${d.hotCount} hot, ${d.warmCount} warm)`,
        ]);
        row.addEventListener("click", () => view.flyTo(d.x, d.z, d.radius * 3.2));
        panel.appendChild(row);
      });
      hud.appendChild(panel);
    }

    const legend = el("div", { id: "city-legend" }, [
      `${model.districts.length} districts · ${model.buildingCount} buildings` +
        (model.usedCommunityFallback ? " · districts by directory (no communities in graph)" : " · districts by community"),
    ]);
    hud.appendChild(legend);

    loadWidgetScripts();
  } catch (err) {
    statusEl.textContent = `Failed to load city: ${err.message}`;
  }
}

main();
