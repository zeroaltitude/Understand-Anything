import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS module shared with the browser page, no types on purpose.
import { buildCityModel } from "../city/city-model.js";

function graphFixture() {
  return {
    nodes: [
      { id: "file:src/auth.ts", type: "file", filePath: "src/auth.ts", name: "auth.ts", summary: "", tags: [], complexity: "simple" },
      { id: "fn:login", type: "function", filePath: "src/auth.ts", name: "login", summary: "", tags: [], complexity: "simple" },
      { id: "fn:logout", type: "function", filePath: "src/auth.ts", name: "logout", summary: "", tags: [], complexity: "simple" },
      { id: "file:src/db.ts", type: "file", filePath: "src/db.ts", name: "db.ts", summary: "", tags: [], complexity: "simple" },
      { id: "file:docs/readme", type: "document", filePath: "docs/README.md", name: "README.md", summary: "", tags: [], complexity: "simple" },
      { id: "concept:x", type: "concept", name: "X", summary: "", tags: [], complexity: "simple" }, // no filePath → no building
    ],
    edges: [],
    layers: [
      { id: "gfy-community-0", name: "auth core", description: "", nodeIds: ["file:src/auth.ts", "fn:login", "fn:logout", "file:src/db.ts"] },
      { id: "gfy-community-1", name: "docs", description: "", nodeIds: ["file:docs/readme"] },
      { id: "layer-native", name: "Native layer", description: "", nodeIds: ["file:src/auth.ts"] }, // non-community layer ignored
    ],
    tour: [],
  };
}

describe("buildCityModel", () => {
  it("makes one building per distinct filePath, skipping filePath-less nodes", () => {
    const model = buildCityModel(graphFixture());
    expect(model.buildingCount).toBe(3);
    const all = model.districts.flatMap((d: any) => d.buildings.map((b: any) => b.filePath));
    expect(all.sort()).toEqual(["docs/README.md", "src/auth.ts", "src/db.ts"]);
  });

  it("assigns districts from community layers and ignores non-community layers", () => {
    const model = buildCityModel(graphFixture());
    expect(model.usedCommunityFallback).toBe(false);
    const names = model.districts.map((d: any) => d.name).sort();
    expect(names).toEqual(["auth core", "docs"]);
  });

  it("falls back to top-level directory districts when no community layers exist", () => {
    const g = graphFixture();
    g.layers = [];
    const model = buildCityModel(g);
    expect(model.usedCommunityFallback).toBe(true);
    expect(model.districts.map((d: any) => d.name).sort()).toEqual(["docs", "src"]);
  });

  it("building height grows with node count and primary node prefers the file node", () => {
    const model = buildCityModel(graphFixture());
    const authDistrict = model.districts.find((d: any) => d.name === "auth core");
    const auth = authDistrict.buildings.find((b: any) => b.filePath === "src/auth.ts");
    const db = authDistrict.buildings.find((b: any) => b.filePath === "src/db.ts");
    expect(auth.height).toBeGreaterThan(db.height); // 3 nodes vs 1
    expect(auth.primaryNodeId).toBe("file:src/auth.ts");
  });

  it("applies diff-overlay heat to buildings and districts", () => {
    const model = buildCityModel(graphFixture(), {
      changedNodeIds: ["fn:login"],
      affectedNodeIds: ["file:src/db.ts"],
      baseBranch: "main",
      generatedAt: "2026-07-16T00:00:00Z",
    });
    const authDistrict = model.districts.find((d: any) => d.name === "auth core");
    const auth = authDistrict.buildings.find((b: any) => b.filePath === "src/auth.ts");
    const db = authDistrict.buildings.find((b: any) => b.filePath === "src/db.ts");
    expect(auth.heat).toBe("hot"); // a room in the building changed
    expect(db.heat).toBe("warm");
    expect(authDistrict.heat).toBeCloseTo((1 + 0.5) / 2);
    expect(model.weather).toEqual({ source: "main", generatedAt: "2026-07-16T00:00:00Z", hotBuildings: 1, warmBuildings: 1 });
    expect(buildCityModel(graphFixture()).weather).toBeNull();
  });

  it("is deterministic: identical input produces identical layout", () => {
    const a = buildCityModel(graphFixture());
    const b = buildCityModel(graphFixture());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("positions districts and buildings without NaNs", () => {
    const model = buildCityModel(graphFixture());
    for (const d of model.districts) {
      expect(Number.isFinite(d.x) && Number.isFinite(d.z) && d.radius > 0).toBe(true);
      for (const b of d.buildings) {
        expect(Number.isFinite(b.x) && Number.isFinite(b.z) && b.height > 0).toBe(true);
        expect(Math.hypot(b.x, b.z)).toBeLessThanOrEqual(d.radius);
      }
    }
  });
});
