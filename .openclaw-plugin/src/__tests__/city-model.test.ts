import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS module shared with the browser page, no types on purpose.
import { buildCityModel } from "../city/city-model.js";

function graphFixture() {
  return {
    nodes: [
      { id: "file:frontend/App.tsx", type: "file", filePath: "frontend/App.tsx", name: "App.tsx", summary: "", tags: ["react"], complexity: "simple" },
      { id: "file:src/auth.ts", type: "file", filePath: "src/auth.ts", name: "auth.ts", summary: "", tags: [], complexity: "simple" },
      { id: "fn:login", type: "function", filePath: "src/auth.ts", name: "login", summary: "", tags: [], complexity: "simple" },
      { id: "fn:logout", type: "function", filePath: "src/auth.ts", name: "logout", summary: "", tags: [], complexity: "simple" },
      { id: "file:src/db/index.ts", type: "file", filePath: "src/db/index.ts", name: "index.ts", summary: "", tags: [], complexity: "simple" },
      { id: "file:docs/readme", type: "document", filePath: "docs/README.md", name: "README.md", summary: "", tags: [], complexity: "simple" },
      { id: "concept:x", type: "concept", name: "X", summary: "", tags: [], complexity: "simple" }, // no filePath → no building
    ],
    edges: [],
    layers: [
      { id: "gfy-community-0", name: "auth core", description: "", nodeIds: ["file:src/auth.ts", "fn:login", "fn:logout", "file:src/db/index.ts"] },
      { id: "gfy-community-1", name: "docs", description: "", nodeIds: ["file:docs/readme"] },
      { id: "layer-native", name: "Native layer", description: "", nodeIds: ["file:src/auth.ts"] }, // non-community layer ignored
    ],
    tour: [],
  };
}

describe("buildCityModel (containment tree)", () => {
  it("makes one building per distinct filePath, skipping filePath-less nodes", () => {
    const model = buildCityModel(graphFixture());
    expect(model.buildingCount).toBe(4);
    expect(model.buildings.map((b: any) => b.filePath).sort()).toEqual([
      "docs/README.md",
      "frontend/App.tsx",
      "src/auth.ts",
      "src/db/index.ts",
    ]);
  });

  it("nests districts by directory containment: App.tsx is IN frontend", () => {
    const model = buildCityModel(graphFixture());
    const app = model.buildings.find((b: any) => b.filePath === "frontend/App.tsx");
    expect(app.districtPath).toBe("frontend");
    const frontend = model.districts.find((d: any) => d.path === "frontend");
    expect(frontend.depth).toBe(1);
    expect(frontend.buildings.map((b: any) => b.filePath)).toEqual(["frontend/App.tsx"]);
    // Deep nesting: src/db/index.ts lives in district src/db, whose parent is src.
    const db = model.districts.find((d: any) => d.path === "src/db");
    expect(db.depth).toBe(2);
    expect(db.buildings[0].filePath).toBe("src/db/index.ts");
    const src = model.districts.find((d: any) => d.path === "src");
    expect(src.children.map((c: any) => c.path)).toContain("src/db");
  });

  it("keeps community membership as building metadata (facet skin, not geometry)", () => {
    const model = buildCityModel(graphFixture());
    const auth = model.buildings.find((b: any) => b.filePath === "src/auth.ts");
    expect(auth.communityVotes["auth core"]).toBe(3);
    // Geometry is unaffected by layers: removing them changes no positions.
    const g = graphFixture();
    g.layers = [];
    const bare = buildCityModel(g);
    const authBare = bare.buildings.find((b: any) => b.filePath === "src/auth.ts");
    expect(authBare.ax).toBe(auth.ax);
    expect(authBare.az).toBe(auth.az);
  });

  it("building height grows with node count and primary node prefers the file node", () => {
    const model = buildCityModel(graphFixture());
    const auth = model.buildings.find((b: any) => b.filePath === "src/auth.ts");
    const db = model.buildings.find((b: any) => b.filePath === "src/db/index.ts");
    expect(auth.height).toBeGreaterThan(db.height); // 3 nodes vs 1
    expect(auth.primaryNodeId).toBe("file:src/auth.ts");
  });

  it("applies diff-overlay heat to buildings and propagates it up the district tree", () => {
    const model = buildCityModel(graphFixture(), {
      changedNodeIds: ["fn:login"],
      affectedNodeIds: ["file:src/db/index.ts"],
      baseBranch: "main",
      generatedAt: "2026-07-16T00:00:00Z",
    });
    const auth = model.buildings.find((b: any) => b.filePath === "src/auth.ts");
    const db = model.buildings.find((b: any) => b.filePath === "src/db/index.ts");
    expect(auth.heat).toBe("hot"); // a room in the building changed
    expect(db.heat).toBe("warm");
    const src = model.districts.find((d: any) => d.path === "src");
    // src subtree: 2 files, 1 hot + 1 warm → (1 + 0.5)/2
    expect(src.hotCount).toBe(1);
    expect(src.warmCount).toBe(1);
    expect(src.heat).toBeCloseTo((1 + 0.5) / 2);
    // Root aggregates the whole city.
    expect(model.root.hotCount).toBe(1);
    expect(model.weather).toEqual({ source: "main", generatedAt: "2026-07-16T00:00:00Z", hotBuildings: 1, warmBuildings: 1 });
    expect(buildCityModel(graphFixture()).weather).toBeNull();
  });

  it("is deterministic: identical input produces identical layout", () => {
    const a = buildCityModel(graphFixture());
    const b = buildCityModel(graphFixture());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("positions everything without NaNs, inside its parent district", () => {
    const model = buildCityModel(graphFixture());
    const byPath = new Map(model.districts.map((d: any) => [d.path, d]));
    for (const d of model.districts) {
      expect(Number.isFinite(d.x) && Number.isFinite(d.z) && d.radius > 0).toBe(true);
    }
    for (const b of model.buildings) {
      expect(Number.isFinite(b.ax) && Number.isFinite(b.az) && b.height > 0).toBe(true);
      const d: any = byPath.get(b.districtPath);
      expect(Math.hypot(b.ax - d.x, b.az - d.z)).toBeLessThanOrEqual(d.radius);
    }
  });

  it("sibling children of a district do not overlap", () => {
    // Many files in one directory + a subdirectory: circles must stay disjoint.
    const nodes = [];
    for (let i = 0; i < 12; i++) {
      nodes.push({ id: `f${i}`, type: "file", filePath: `pkg/file${i}.ts`, name: `file${i}.ts`, tags: [] });
    }
    nodes.push({ id: "s1", type: "file", filePath: "pkg/sub/one.ts", name: "one.ts", tags: [] });
    nodes.push({ id: "s2", type: "file", filePath: "pkg/sub/two.ts", name: "two.ts", tags: [] });
    const model = buildCityModel({ nodes, edges: [], layers: [] });
    const pkg = model.districts.find((d: any) => d.path === "pkg");
    const sub = model.districts.find((d: any) => d.path === "pkg/sub");
    const circles = [
      ...pkg.buildings.map((b: any) => ({ x: b.ax, z: b.az, r: 8 })),
      { x: sub.x, z: sub.z, r: sub.radius },
    ];
    for (let i = 0; i < circles.length; i++) {
      for (let j = i + 1; j < circles.length; j++) {
        const dist = Math.hypot(circles[i].x - circles[j].x, circles[i].z - circles[j].z);
        expect(dist + 0.001).toBeGreaterThanOrEqual(circles[i].r + circles[j].r);
      }
    }
  });
});
