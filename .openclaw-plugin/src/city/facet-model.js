// Facet catalog for the Code City: pure functions that compute per-building
// facet values from the knowledge graph. No three.js, no DOM — unit-testable
// (see __tests__/facet-model.test.ts).
//
// Design (facet-city-design-2026-07-20.md): the containment tree is the city's
// GEOMETRY (city-model.js); every other natural categorization is a *facet* —
// a function building → value with an objective witness, rendered as a color
// skin on the fixed skeleton. Facet switches never move the city.
//
// Each facet definition:
//   { id, label, kind: "categorical"|"scalar", witness, description,
//     valueOf(building) → key (categorical) | number 0..1 (scalar),
//     colorOf(building) → 0xRRGGBB,
//     legend() → categorical: [{key,label,color,count}] / scalar: {stops,min,max} }

const GOLDEN = [0x5a9ee6, 0xd9a441, 0x5a9e6f, 0xb07fd9, 0xd97fa8, 0x7fd9c9, 0xe6c35a, 0x8b949e];

const TYPE_COLORS = {
  file: 0x5a9ee6,
  module: 0xd9a441,
  function: 0x5a9e6f,
  class: 0xb07fd9,
  document: 0xd97fa8,
  config: 0x7fd9c9,
  concept: 0xe6c35a,
};
const DEFAULT_COLOR = 0x8b949e;
const HOT_COLOR = 0xff4d2e;
const WARM_COLOR = 0xff9d3d;
const COLD_COLOR = 0x2c3a4d;

// ── Aspect taxonomy ──────────────────────────────────────────────────────────
// Ordered rules; first match wins. Witness recorded per building:
// "path" (structural heuristic) beats "tag" (LLM/engine tagging) beats "default".
const ASPECT_COLORS = {
  test: 0x5a9e6f,
  docs: 0xd97fa8,
  config: 0x7fd9c9,
  build: 0x9aa5b1,
  types: 0xe6c35a,
  ui: 0x5a9ee6,
  tooling: 0xb07fd9,
  core: 0xd9a441,
};

const ASPECT_PATH_RULES = [
  { aspect: "test", re: /(^|\/)__tests__\/|\.test\.|\.spec\.|(^|\/)tests?\//i },
  { aspect: "docs", re: /\.mdx?$|(^|\/)docs?\//i },
  { aspect: "build", re: /(^|\/)\.github\/|(^|\/)(dockerfile|makefile)|\.ya?ml$|(^|\/)pnpm-|(^|\/)\.husky\//i },
  { aspect: "config", re: /(^|\/)package\.json$|tsconfig|\.config\.|\.env|(^|\/)\.[a-z0-9-]+rc(\.|$)/i },
  { aspect: "types", re: /\.d\.ts$|(^|\/)types?\.[jt]sx?$|(^|\/)types?\//i },
  { aspect: "ui", re: /\.(tsx|jsx|css|scss|html)$|(^|\/)(components?|ui|pages?|views?)\//i },
  { aspect: "tooling", re: /(^|\/)scripts?\//i },
];

const ASPECT_TAG_RULES = [
  { aspect: "test", tags: ["test", "unit-test", "vitest", "e2e"] },
  { aspect: "config", tags: ["configuration", "config"] },
  { aspect: "docs", tags: ["documentation", "rationale"] },
  { aspect: "ui", tags: ["react", "dashboard", "frontend", "component"] },
  { aspect: "tooling", tags: ["utility", "script", "cli", "tooling"] },
  { aspect: "build", tags: ["build", "ci"] },
];

/**
 * Assign an aspect to one building. Returns { aspect, witness }.
 * @param {{filePath: string, tagCounts?: Record<string, number>}} building
 */
export function aspectFor(building) {
  const path = building.filePath || "";
  for (const rule of ASPECT_PATH_RULES) {
    if (rule.re.test(path)) return { aspect: rule.aspect, witness: "path" };
  }
  const tags = building.tagCounts || {};
  for (const rule of ASPECT_TAG_RULES) {
    if (rule.tags.some((t) => tags[t] > 0)) return { aspect: rule.aspect, witness: "tag" };
  }
  return { aspect: "core", witness: "default" };
}

// ── Strata: Kahn layering over the file-level import graph ──────────────────
/**
 * Longest-path layer per filePath over `imports` edges, cycle-tolerant:
 * Kahn's algorithm assigns layers to the acyclic part; any node left over
 * (member of a cycle) is assigned maxLayer+1 so cyclic cores read as "deep".
 * Returns Map filePath → integer layer (0 = imports nothing / foundation).
 * Direction: if A imports B, B is A's dependency → B's layer < A's layer.
 * @param {{nodes: any[], edges: any[]}} graph
 */
export function importStrata(graph) {
  const fileOf = new Map();
  for (const n of graph.nodes) {
    if (n.filePath) fileOf.set(n.id, n.filePath);
  }
  // dep edges between files: importer → imported
  const deps = new Map(); // file → Set(files it imports)
  const rdeps = new Map(); // file → Set(files importing it)
  const files = new Set(fileOf.values());
  for (const f of files) {
    deps.set(f, new Set());
    rdeps.set(f, new Set());
  }
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const a = fileOf.get(e.source ?? e.from);
    const b = fileOf.get(e.target ?? e.to);
    if (!a || !b || a === b) continue;
    deps.get(a).add(b);
    rdeps.get(b).add(a);
  }
  // Kahn from the foundation up: start with files that import nothing.
  const layer = new Map();
  const remainingDeps = new Map();
  const queue = [];
  for (const f of files) {
    remainingDeps.set(f, deps.get(f).size);
    if (deps.get(f).size === 0) {
      layer.set(f, 0);
      queue.push(f);
    }
  }
  queue.sort(); // determinism
  let maxLayer = 0;
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];
    const l = layer.get(f);
    maxLayer = Math.max(maxLayer, l);
    const importers = [...rdeps.get(f)].sort();
    for (const g of importers) {
      layer.set(g, Math.max(layer.get(g) ?? 0, l + 1));
      const left = remainingDeps.get(g) - 1;
      remainingDeps.set(g, left);
      if (left === 0) queue.push(g);
    }
  }
  // Cycle members: never reached in-degree 0 from the dependency side.
  for (const f of files) {
    if (!layer.has(f) || remainingDeps.get(f) > 0) layer.set(f, maxLayer + 1);
  }
  return layer;
}

// ── Surface: export-edge count per file, log-normalized ─────────────────────
/** @param {{nodes: any[], edges: any[]}} graph → Map filePath → count */
export function exportCounts(graph) {
  const fileOf = new Map();
  for (const n of graph.nodes) {
    if (n.filePath) fileOf.set(n.id, n.filePath);
  }
  const counts = new Map();
  for (const e of graph.edges) {
    if (e.type !== "exports") continue;
    const f = fileOf.get(e.source ?? e.from);
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

function scalarColor(t) {
  // foundation blue → surface orange, perceptually simple two-stop lerp.
  const a = { r: 0x2e, g: 0x5c, b: 0x8a };
  const b = { r: 0xff, g: 0x9d, b: 0x3d };
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return (r << 16) | (g << 8) | bl;
}

function hashHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GOLDEN[h % GOLDEN.length];
}

/**
 * Build the facet catalog for a city model.
 * `model.buildings` must each carry: filePath, dominantType, tagCounts,
 * communityVotes (Map name→count or plain object), heat.
 *
 * @param {{nodes: any[], edges: any[], layers?: any[]}} graph
 * @param {{buildings: Array<any>, weather: any}} model
 * @returns {{facets: Array<any>, defaultFacetId: string}}
 */
export function buildFacets(graph, model) {
  const buildings = model.buildings;

  // Precompute per-building assignments.
  const strataByFile = importStrata(graph);
  let maxStratum = 0;
  for (const l of strataByFile.values()) maxStratum = Math.max(maxStratum, l);
  const exportsByFile = exportCounts(graph);
  let maxExportLog = 0;
  for (const c of exportsByFile.values()) maxExportLog = Math.max(maxExportLog, Math.log1p(c));

  for (const b of buildings) {
    const a = aspectFor(b);
    b.facet = {
      type: b.dominantType,
      aspect: a.aspect,
      aspectWitness: a.witness,
      community: majorityKey(b.communityVotes) ?? "(none)",
      strata: maxStratum === 0 ? 0 : (strataByFile.get(b.filePath) ?? 0) / maxStratum,
      strataLayer: strataByFile.get(b.filePath) ?? 0,
      surface: maxExportLog === 0 ? 0 : Math.log1p(exportsByFile.get(b.filePath) ?? 0) / maxExportLog,
      exports: exportsByFile.get(b.filePath) ?? 0,
      weather: b.heat ?? "cold",
    };
  }

  const categorical = (id, label, witness, description, keyOf, colorFor) => ({
    id,
    label,
    kind: "categorical",
    witness,
    description,
    colorOf: (b) => colorFor(keyOf(b)),
    legend: () => {
      const counts = new Map();
      for (const b of buildings) {
        const k = keyOf(b);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .map(([key, count]) => ({ key, label: key, color: colorFor(key), count }));
    },
  });

  const scalar = (id, label, witness, description, valueOf, describe) => ({
    id,
    label,
    kind: "scalar",
    witness,
    description,
    colorOf: (b) => scalarColor(valueOf(b)),
    legend: () => ({ stops: [scalarColor(0), scalarColor(0.5), scalarColor(1)], ...describe() }),
  });

  const facets = [
    categorical(
      "type",
      "Node type",
      "engine typing (both)",
      "Dominant graph node type per file",
      (b) => b.facet.type,
      (k) => TYPE_COLORS[k] ?? DEFAULT_COLOR,
    ),
    categorical(
      "aspect",
      "Aspect",
      "path heuristics ▸ engine tags",
      "Developer-natural role: tests, docs, config, UI, types, tooling, core",
      (b) => b.facet.aspect,
      (k) => ASPECT_COLORS[k] ?? DEFAULT_COLOR,
    ),
    scalar(
      "strata",
      "Import strata",
      "imports DAG (graphify)",
      "Dependency depth — foundation (imports nothing) to surface",
      (b) => b.facet.strata,
      () => ({ min: "foundation", max: `surface (layer ${maxStratum})` }),
    ),
    scalar(
      "surface",
      "Public surface",
      "exports edges",
      "How much this file exports — interior to storefront",
      (b) => b.facet.surface,
      () => ({ min: "internal", max: "storefront" }),
    ),
    categorical(
      "community",
      "Community",
      "Leiden clustering (graphify)",
      "Emergent correlation clusters — statistically real, humanly unnameable",
      (b) => b.facet.community,
      (k) => (k === "(none)" ? DEFAULT_COLOR : hashHue(k)),
    ),
  ];

  if (model.weather) {
    facets.unshift(
      categorical(
        "weather",
        "Change weather",
        "diff overlay",
        `Changed vs affected files (${model.weather.source})`,
        (b) => b.facet.weather,
        (k) => (k === "hot" ? HOT_COLOR : k === "warm" ? WARM_COLOR : COLD_COLOR),
      ),
    );
  }

  return { facets, defaultFacetId: model.weather ? "weather" : "type" };
}

function majorityKey(votes) {
  if (!votes) return null;
  const entries = votes instanceof Map ? [...votes.entries()] : Object.entries(votes);
  let best = null;
  let bestCount = -1;
  for (const [k, c] of entries) {
    if (c > bestCount || (c === bestCount && best !== null && k < best)) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}
