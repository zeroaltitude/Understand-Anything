// Pure model builder for the Code City view: KnowledgeGraph (+ optional
// DiffOverlay) → districts/buildings with deterministic positions and heat.
// No three.js, no DOM — unit-testable in isolation (see __tests__/city-model.test.ts).
//
// City semantics (design doc: code-city-vision-and-prototype-plan-2026-07-16.md §2):
//   district = Leiden community (gfy-community-* layer), falling back to
//              top-level directory when the graph has no community layers
//   building = distinct filePath; height ∝ how many graph nodes live in that
//              file ("rooms"); color by dominant node type
//   weather  = diff overlay heat: hot (changed) / warm (affected), and a
//              per-district heat fraction for the storm list
//
// Layout is deterministic by construction (sorted inputs + golden-angle
// spirals, no physics): the same graph always produces the same city, so the
// city can be *learned*. Aesthetics are deliberately traded for stability.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** @param {string} filePath */
function topLevelDir(filePath) {
  const i = filePath.indexOf("/");
  return i === -1 ? "(root)" : filePath.slice(0, i);
}

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
 * @param {{nodes: Array<any>, edges: Array<any>, layers: Array<any>, project?: any}} graph
 * @param {{changedNodeIds?: string[], affectedNodeIds?: string[], baseBranch?: string, generatedAt?: string} | null} overlay
 */
export function buildCityModel(graph, overlay = null) {
  const changed = new Set(overlay?.changedNodeIds ?? []);
  const affected = new Set(overlay?.affectedNodeIds ?? []);

  // District assignment: community layers first, directory fallback.
  const communityLayers = (graph.layers ?? []).filter((l) => l.id.startsWith("gfy-community-"));
  const nodeToDistrict = new Map();
  for (const layer of communityLayers) {
    for (const nodeId of layer.nodeIds) {
      if (!nodeToDistrict.has(nodeId)) nodeToDistrict.set(nodeId, layer.name);
    }
  }
  const usedCommunityFallback = communityLayers.length === 0;

  // Buildings: one per distinct filePath.
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
        heat: null, // null | "warm" | "hot"
        districtVotes: new Map(),
      };
      buildingsByPath.set(node.filePath, b);
    }
    b.nodeIds.push(node.id);
    b.typeCounts[node.type] = (b.typeCounts[node.type] ?? 0) + 1;
    if (node.type === "file" && b.primaryNodeId === null) b.primaryNodeId = node.id;
    if (changed.has(node.id)) b.heat = "hot";
    else if (affected.has(node.id) && b.heat !== "hot") b.heat = "warm";
    const district = usedCommunityFallback
      ? topLevelDir(node.filePath)
      : (nodeToDistrict.get(node.id) ?? topLevelDir(node.filePath));
    b.districtVotes.set(district, (b.districtVotes.get(district) ?? 0) + 1);
  }

  // Finalize buildings: primary node, dominant type, majority district.
  const districtsByName = new Map();
  for (const b of buildingsByPath.values()) {
    if (b.primaryNodeId === null) b.primaryNodeId = b.nodeIds[0];
    b.dominantType = dominantType(b.typeCounts);
    let districtName = "(root)";
    let bestVotes = -1;
    for (const [name, votes] of b.districtVotes) {
      if (votes > bestVotes || (votes === bestVotes && name < districtName)) {
        districtName = name;
        bestVotes = votes;
      }
    }
    delete b.districtVotes;
    let d = districtsByName.get(districtName);
    if (!d) {
      d = { name: districtName, buildings: [], nodeCount: 0, hotCount: 0, warmCount: 0 };
      districtsByName.set(districtName, d);
    }
    d.buildings.push(b);
    d.nodeCount += b.nodeIds.length;
    if (b.heat === "hot") d.hotCount++;
    else if (b.heat === "warm") d.warmCount++;
  }

  // Deterministic ordering everywhere: districts by size then name; buildings
  // by name. Positions come from golden-angle spirals over those orderings.
  const districts = [...districtsByName.values()].sort(
    (a, b) => b.buildings.length - a.buildings.length || (a.name < b.name ? -1 : 1),
  );

  const BUILDING_SPACING = 14;
  let maxDistrictRadius = 0;
  for (const d of districts) {
    d.buildings.sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
    d.radius = Math.max(24, Math.ceil(Math.sqrt(d.buildings.length)) * BUILDING_SPACING * 0.75);
    maxDistrictRadius = Math.max(maxDistrictRadius, d.radius);
    d.heat = d.buildings.length === 0 ? 0 : (d.hotCount + 0.5 * d.warmCount) / d.buildings.length;
    d.id = `district:${d.name}`;
    d.buildings.forEach((b, i) => {
      const r = d.radius * 0.85 * Math.sqrt((i + 0.5) / d.buildings.length);
      const theta = i * GOLDEN_ANGLE;
      b.x = Math.cos(theta) * r;
      b.z = Math.sin(theta) * r;
      b.width = 6;
      b.height = 4 + Math.min(b.nodeIds.length, 40) * 1.5;
    });
  }
  districts.forEach((d, i) => {
    if (i === 0) {
      d.x = 0;
      d.z = 0;
      return;
    }
    const r = maxDistrictRadius * 2.4 * Math.sqrt(i + 0.5);
    const theta = i * GOLDEN_ANGLE;
    d.x = Math.cos(theta) * r;
    d.z = Math.sin(theta) * r;
  });

  return {
    districts,
    buildingCount: buildingsByPath.size,
    usedCommunityFallback,
    weather: overlay
      ? {
          source: overlay.baseBranch ?? "diff",
          generatedAt: overlay.generatedAt ?? null,
          hotBuildings: districts.reduce((n, d) => n + d.hotCount, 0),
          warmBuildings: districts.reduce((n, d) => n + d.warmCount, 0),
        }
      : null,
  };
}
