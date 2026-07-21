// Code City bootstrap + HUD: fetches the graph (+ diff overlay), builds the
// containment model and facet catalog, drives the renderer, and bridges picks
// into the shared selection contract (window.uaDashboardSelection +
// "ua:selection") so the standard Ask widget — conversation history, grounding
// and all — works inside the city exactly as it does on the 2D dashboard.
import { buildCityModel } from "./city-model.js";
import { buildFacets } from "./facet-model.js";
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

function hexCss(color) {
  return `#${color.toString(16).padStart(6, "0")}`;
}

async function main() {
  const statusEl = document.getElementById("city-status");
  try {
    const [graph, overlay] = await Promise.all([
      fetchJson("knowledge-graph.json"),
      fetchJson("diff-overlay.json", true),
    ]);
    const model = buildCityModel(graph, overlay);
    const facetCatalog = buildFacets(graph, model);
    statusEl.remove();

    const info = document.getElementById("city-info");
    const view = createCityView(document.getElementById("city-canvas"), model, facetCatalog, {
      onBuildingPick(b) {
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
        info.appendChild(el("div", { class: "meta" }, [`district: ${b.districtPath || "(root)"}`]));
        info.appendChild(
          el("div", { class: "meta" }, [
            `aspect: ${b.facet.aspect} (${b.facet.aspectWitness}) · strata: L${b.facet.strataLayer} · exports: ${b.facet.exports}`,
          ]),
        );
        if (b.facet.community !== "(none)") {
          info.appendChild(el("div", { class: "meta" }, [`community: ${b.facet.community}`]));
        }
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

    const hud = document.getElementById("city-hud");

    // ── Facet picker + legend ────────────────────────────────────────────────
    const legendBody = el("div", { id: "facet-legend" }, []);
    const picker = el("div", { id: "facet-picker" }, []);
    const buttons = new Map();

    function renderLegend(facet) {
      legendBody.innerHTML = "";
      legendBody.appendChild(el("div", { class: "meta" }, [`${facet.description} — witness: ${facet.witness}`]));
      const legend = facet.legend();
      if (facet.kind === "categorical") {
        legend.slice(0, 10).forEach((entry) => {
          legendBody.appendChild(
            el("div", { class: "legend-row" }, [
              el("span", { class: "swatch", style: `background:${hexCss(entry.color)}` }, []),
              `${entry.label} (${entry.count})`,
            ]),
          );
        });
        if (legend.length > 10) {
          legendBody.appendChild(el("div", { class: "meta" }, [`… ${legend.length - 10} more`]));
        }
      } else {
        const bar = el("div", {
          class: "legend-gradient",
          style: `background:linear-gradient(90deg, ${legend.stops.map(hexCss).join(", ")})`,
        });
        legendBody.appendChild(bar);
        legendBody.appendChild(
          el("div", { class: "legend-gradient-labels" }, [
            el("span", {}, [legend.min]),
            el("span", {}, [legend.max]),
          ]),
        );
      }
    }

    function selectFacet(id) {
      const facet = view.applyFacet(id);
      for (const [fid, btn] of buttons) {
        btn.classList.toggle("active", fid === facet.id);
      }
      renderLegend(facet);
    }

    for (const facet of facetCatalog.facets) {
      const btn = el("button", { class: "facet-btn" }, [facet.label]);
      btn.addEventListener("click", () => selectFacet(facet.id));
      buttons.set(facet.id, btn);
      picker.appendChild(btn);
    }
    hud.appendChild(el("div", { id: "facet-panel" }, [el("h4", {}, ["Facet"]), picker, legendBody]));
    selectFacet(facetCatalog.defaultFacetId);

    // ── Search: substring over building names/paths → fly ───────────────────
    const search = document.getElementById("city-search");
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = search.value.trim().toLowerCase();
      if (!q) return;
      const b = model.buildings.find(
        (b2) => b2.name.toLowerCase().includes(q) || b2.filePath.toLowerCase().includes(q),
      );
      if (b) view.flyTo(b.ax, b.az, 120);
    });

    // ── Storm list: districts by heat (only when there's weather) ────────────
    if (model.weather && (model.weather.hotBuildings || model.weather.warmBuildings)) {
      const storms = model.districts
        .filter((d) => d.heat > 0 && d.depth > 0)
        .sort((a, b) => b.heat - a.heat || b.fileCount - a.fileCount);
      const panel = el("div", { id: "city-storms" }, [
        el("h4", {}, [`⛈ Change weather — ${model.weather.source}`]),
        el("div", { class: "meta" }, [`${model.weather.hotBuildings} changed, ${model.weather.warmBuildings} affected file(s)`]),
      ]);
      storms.slice(0, 8).forEach((d) => {
        const row = el("button", { class: "storm-row" }, [
          `${d.path} — ${Math.round(d.heat * 100)}% (${d.hotCount} hot, ${d.warmCount} warm)`,
        ]);
        row.addEventListener("click", () => view.flyTo(d.x, d.z, d.radius * 3.2));
        panel.appendChild(row);
      });
      hud.appendChild(panel);
    }

    const legend = el("div", { id: "city-legend" }, [
      `${model.districts.length - 1} districts · ${model.buildingCount} buildings · geometry: directory containment`,
    ]);
    hud.appendChild(legend);

    loadWidgetScripts();
  } catch (err) {
    statusEl.textContent = `Failed to load city: ${err.message}`;
  }
}

main();
