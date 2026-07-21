// Pure model builder for the Code City v2: KnowledgeGraph (+ optional
// DiffOverlay) → a CONTAINMENT TREE of districts with deterministic positions.
// No three.js, no DOM — unit-testable in isolation (see __tests__/city-model.test.ts).
//
// v2 semantics (design doc: facet-city-design-2026-07-20.md):
//   The directory tree IS the geometry — the only categorization that is a true
//   tree, stable and nameable ("App.tsx is IN frontend"). Districts nest:
//   root → one district per path segment, recursively; a file's building lives
//   in its immediate parent district. Everything else (aspects, communities,
//   strata, weather) is a facet SKIN computed by facet-model.js and painted by
//   the renderer — facet switches never move the city.
//
//   v1 (Leiden communities as flat districts) is retired as geometry; community
//   membership survives on each building (communityVotes) for the community facet.
//
// Layout is deterministic by construction (sorted children + golden-angle
// collision-free packing, no physics): the same graph always produces the same
// city, so the city can be *learned*. Aesthetics are traded for stability.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BUILDING_RADIUS = 8; // packing circle for one building (6-wide box + margin)
const DISTRICT_PADDING = 10;

function dominantType(typeCounts) {
  let best = null;
  let bestCount = -1;
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count > bestCount || (count === bestCount && best !== null && type < best)) {
      best = type;
      bestCount = count;
    }
  }
  return best ?? "file";
}

/**
 * Deterministic golden-angle circle packing: place circles (sorted by the
 * caller) around the origin, each at the smallest radius along its
 * golden-angle ray that clears every previously placed circle.
 * @param {Array<{r: number}>} items — mutated: gains x, z
 * @returns {number} enclosing radius
 */
function packCircles(items) {
  const placed = [];
  let enclosing = 0;
  items.forEach((item, i) => {
    if (i === 0) {
      item.x = 0;
      item.z = 0;
    } else {
      const theta = i * GOLDEN_ANGLE;
      const dx = Math.cos(theta);
      const dz = Math.sin(theta);
      // Walk outward along the ray until this circle clears all placed ones.
      let r = 0;
      let safe = false;
      while (!safe) {
        safe = true;
        const x = dx * r;
        const z = dz * r;
        for (const p of placed) {
          const need = p.r + item.r + 2;
          const dist = Math.hypot(x - p.x, z - p.z);
          if (dist < need) {
            // Jump ahead by the overlap (plus a nudge) instead of stepping.
            r += need - dist + 0.5;
            safe = false;
            break;
          }
        }
      }
      item.x = dx * r;
      item.z = dz * r;
    }
    placed.push(item);
    enclosing = Math.max(enclosing, Math.hypot(item.x, item.z) + item.r);
  });
  return enclosing;
}

/**
 * @param {{nodes: Array<any>, edges: Array<any>, layers: Array<any>, project?: any}} graph
 * @param {{changedNodeIds?: string[], affectedNodeIds?: string[], baseBranch?: string, generatedAt?: string} | null} overlay
 */
export function buildCityModel(graph, overlay = null) {
  const changed = new Set(overlay?.changedNodeIds ?? []);
  const affected = new Set(overlay?.affectedNodeIds ?? []);

  // Community membership (kept as building metadata for the community facet).
  const communityLayers = (graph.layers ?? []).filter((l) => l.id.startsWith("gfy-community-"));
  const nodeToCommunity = new Map();
  for (const layer of communityLayers) {
    for (const nodeId of layer.nodeIds) {
      if (!nodeToCommunity.has(nodeId)) nodeToCommunity.set(nodeId, layer.name);
    }
  }

  // ── Buildings: one per distinct filePath ───────────────────────────────────
  const buildingsByPath = new Map();
  for (const node of graph.nodes) {
    if (!node.filePath) continue;
    let b = buildingsByPath.get(node.filePath);
    if (!b) {
      b = {
        filePath: node.filePath,
        name: node.filePath.split("/").pop() ?? node.filePath,
        nodeIds: [],
        primaryNodeId: null,
        typeCounts: {},
        tagCounts: {},
        communityVotes: {},
        heat: null, // null | "warm" | "hot"
      };
      buildingsByPath.set(node.filePath, b);
    }
    b.nodeIds.push(node.id);
    b.typeCounts[node.type] = (b.typeCounts[node.type] ?? 0) + 1;
    for (const tag of node.tags ?? []) {
      b.tagCounts[tag] = (b.tagCounts[tag] ?? 0) + 1;
    }
    if (node.type === "file" && b.primaryNodeId === null) b.primaryNodeId = node.id;
    if (changed.has(node.id)) b.heat = "hot";
    else if (affected.has(node.id) && b.heat !== "hot") b.heat = "warm";
    const community = nodeToCommunity.get(node.id);
    if (community) b.communityVotes[community] = (b.communityVotes[community] ?? 0) + 1;
  }

  // ── Containment tree ───────────────────────────────────────────────────────
  const root = makeDistrict("(root)", "", null, 0);
  const districtsByPath = new Map([["", root]]);

  function makeDistrict(name, path, parent, depth) {
    return {
      id: `district:${path || "(root)"}`,
      name,
      path,
      parent,
      depth,
      children: [], // sub-districts
      buildings: [], // direct child files
      nodeCount: 0,
      hotCount: 0,
      warmCount: 0,
      fileCount: 0,
    };
  }

  function districtFor(dirPath) {
    const existing = districtsByPath.get(dirPath);
    if (existing) return existing;
    const idx = dirPath.lastIndexOf("/");
    const parentPath = idx === -1 ? "" : dirPath.slice(0, idx);
    const name = idx === -1 ? dirPath : dirPath.slice(idx + 1);
    const parent = districtFor(parentPath);
    const d = makeDistrict(name, dirPath, parent, parent.depth + 1);
    parent.children.push(d);
    districtsByPath.set(dirPath, d);
    return d;
  }

  for (const b of buildingsByPath.values()) {
    if (b.primaryNodeId === null) b.primaryNodeId = b.nodeIds[0];
    b.dominantType = dominantType(b.typeCounts);
    const idx = b.filePath.lastIndexOf("/");
    const dirPath = idx === -1 ? "" : b.filePath.slice(0, idx);
    const d = districtFor(dirPath);
    d.buildings.push(b);
    b.district = d;
  }

  // Aggregate counts up the tree (post-order).
  function aggregate(d) {
    d.children.sort((a, b2) => (a.path < b2.path ? -1 : 1));
    d.buildings.sort((a, b2) => (a.filePath < b2.filePath ? -1 : 1));
    let nodes = 0;
    let hot = 0;
    let warm = 0;
    let files = d.buildings.length;
    for (const b of d.buildings) {
      nodes += b.nodeIds.length;
      if (b.heat === "hot") hot++;
      else if (b.heat === "warm") warm++;
    }
    for (const c of d.children) {
      aggregate(c);
      nodes += c.nodeCount;
      hot += c.hotCount;
      warm += c.warmCount;
      files += c.fileCount;
    }
    d.nodeCount = nodes;
    d.hotCount = hot;
    d.warmCount = warm;
    d.fileCount = files;
    d.heat = files === 0 ? 0 : (hot + 0.5 * warm) / files;
  }
  aggregate(root);

  // ── Layout: recursive deterministic packing (bottom-up radii) ─────────────
  // Children of a district = sub-districts + direct buildings, as circles,
  // sorted by size desc then name so big things sit central and the layout is
  // stable across runs.
  function layout(d) {
    for (const c of d.children) layout(c);
    const items = [
      ...d.children.map((c) => ({ kind: "district", ref: c, r: c.radius })),
      ...d.buildings.map((b) => ({ kind: "building", ref: b, r: BUILDING_RADIUS })),
    ];
    items.sort((a, b2) => {
      if (b2.r !== a.r) return b2.r - a.r;
      const an = a.kind === "district" ? a.ref.path : a.ref.filePath;
      const bn = b2.kind === "district" ? b2.ref.path : b2.ref.filePath;
      return an < bn ? -1 : 1;
    });
    const enclosing = packCircles(items);
    for (const item of items) {
      item.ref.relX = item.x;
      item.ref.relZ = item.z;
    }
    d.radius = Math.max(24, enclosing + DISTRICT_PADDING);
  }
  layout(root);

  // Absolute coordinates (pre-order).
  const districts = [];
  const buildings = [];
  function absolutize(d, ax, az) {
    d.x = ax;
    d.z = az;
    districts.push(d);
    for (const b of d.buildings) {
      b.ax = ax + b.relX; // absolute (renderer, search, fly-to)
      b.az = az + b.relZ;
      b.width = 6;
      b.height = 4 + Math.min(b.nodeIds.length, 40) * 1.5;
      buildings.push(b);
    }
    for (const c of d.children) {
      absolutize(c, ax + c.relX, az + c.relZ);
    }
  }
  absolutize(root, 0, 0);

  // Drop circular refs so the model stays JSON-safe for consumers.
  let maxDepth = 0;
  for (const d of districts) {
    delete d.parent;
    delete d.relX;
    delete d.relZ;
    maxDepth = Math.max(maxDepth, d.depth);
  }
  for (const b of buildings) {
    b.districtPath = b.district.path;
    b.districtName = b.district.path === "" ? "(root)" : b.district.name;
    delete b.district;
    delete b.relX;
    delete b.relZ;
  }

  return {
    root,
    districts,
    buildings,
    buildingCount: buildings.length,
    maxDepth,
    weather: overlay
      ? {
          source: overlay.baseBranch ?? "diff",
          generatedAt: overlay.generatedAt ?? null,
          hotBuildings: root.hotCount,
          warmBuildings: root.warmCount,
        }
      : null,
  };
}
