import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS module shared with the browser page, no types on purpose.
import { aspectFor, buildFacets, exportCounts, importStrata } from "../city/facet-model.js";
// @ts-expect-error — same.
import { buildCityModel } from "../city/city-model.js";

describe("aspectFor", () => {
  it("path heuristics win over tags (witness: path)", () => {
    expect(aspectFor({ filePath: "src/__tests__/foo.test.ts", tagCounts: { react: 3 } })).toEqual({
      aspect: "test",
      witness: "path",
    });
    expect(aspectFor({ filePath: "docs/guide.md", tagCounts: {} })).toEqual({ aspect: "docs", witness: "path" });
    expect(aspectFor({ filePath: "package.json", tagCounts: {} })).toEqual({ aspect: "config", witness: "path" });
    expect(aspectFor({ filePath: "src/types.ts", tagCounts: {} })).toEqual({ aspect: "types", witness: "path" });
    expect(aspectFor({ filePath: "app/components/Nav.tsx", tagCounts: {} })).toEqual({ aspect: "ui", witness: "path" });
    expect(aspectFor({ filePath: "scripts/build.mjs", tagCounts: {} })).toEqual({ aspect: "tooling", witness: "path" });
    expect(aspectFor({ filePath: ".github/workflows/ci.yml", tagCounts: {} })).toEqual({ aspect: "build", witness: "path" });
  });

  it("tags decide when no path rule matches (witness: tag)", () => {
    expect(aspectFor({ filePath: "src/store.ts", tagCounts: { configuration: 2 } })).toEqual({
      aspect: "config",
      witness: "tag",
    });
    expect(aspectFor({ filePath: "src/view.ts", tagCounts: { react: 1 } })).toEqual({ aspect: "ui", witness: "tag" });
  });

  it("falls back to core (witness: default)", () => {
    expect(aspectFor({ filePath: "src/engine.ts", tagCounts: { typescript: 5 } })).toEqual({
      aspect: "core",
      witness: "default",
    });
  });
});

describe("importStrata", () => {
  it("layers a chain: foundation 0, importers above", () => {
    const graph = {
      nodes: [
        { id: "a", type: "file", filePath: "a.ts" },
        { id: "b", type: "file", filePath: "b.ts" },
        { id: "c", type: "file", filePath: "c.ts" },
      ],
      // c imports b, b imports a → a is the foundation.
      edges: [
        { type: "imports", source: "b", target: "a" },
        { type: "imports", source: "c", target: "b" },
      ],
    };
    const layers = importStrata(graph);
    expect(layers.get("a.ts")).toBe(0);
    expect(layers.get("b.ts")).toBe(1);
    expect(layers.get("c.ts")).toBe(2);
  });

  it("assigns cycle members the deepest layer instead of hanging", () => {
    const graph = {
      nodes: [
        { id: "a", type: "file", filePath: "a.ts" },
        { id: "b", type: "file", filePath: "b.ts" },
        { id: "z", type: "file", filePath: "z.ts" },
      ],
      edges: [
        { type: "imports", source: "a", target: "b" },
        { type: "imports", source: "b", target: "a" }, // cycle a↔b
      ],
    };
    const layers = importStrata(graph);
    expect(layers.get("z.ts")).toBe(0); // acyclic isolate is foundation
    expect(layers.get("a.ts")).toBeGreaterThan(0);
    expect(layers.get("b.ts")).toBeGreaterThan(0);
  });
});

describe("exportCounts", () => {
  it("counts export edges per source file", () => {
    const graph = {
      nodes: [
        { id: "a", type: "file", filePath: "a.ts" },
        { id: "fn1", type: "function", filePath: "a.ts" },
        { id: "b", type: "file", filePath: "b.ts" },
      ],
      edges: [
        { type: "exports", source: "a", target: "fn1" },
        { type: "exports", source: "fn1", target: "b" }, // fn1 lives in a.ts → counts for a.ts
        { type: "imports", source: "b", target: "a" }, // not an export
      ],
    };
    const counts = exportCounts(graph);
    expect(counts.get("a.ts")).toBe(2);
    expect(counts.get("b.ts")).toBeUndefined();
  });
});

describe("buildFacets", () => {
  function graphFixture() {
    return {
      nodes: [
        { id: "f1", type: "file", filePath: "src/core.ts", name: "core.ts", tags: [] },
        { id: "f2", type: "file", filePath: "src/ui/App.tsx", name: "App.tsx", tags: ["react"] },
        { id: "f3", type: "file", filePath: "src/__tests__/core.test.ts", name: "core.test.ts", tags: ["test"] },
      ],
      edges: [
        { type: "imports", source: "f2", target: "f1" },
        { type: "exports", source: "f1", target: "f2" },
      ],
      layers: [{ id: "gfy-community-0", name: "core cluster", nodeIds: ["f1", "f2"] }],
    };
  }

  it("decorates buildings and returns catalog with type default (no overlay)", () => {
    const model = buildCityModel(graphFixture());
    const catalog = buildFacets(graphFixture(), model);
    expect(catalog.defaultFacetId).toBe("type");
    expect(catalog.facets.map((f: any) => f.id)).toEqual(["type", "aspect", "strata", "surface", "community"]);
    const app = model.buildings.find((b: any) => b.filePath === "src/ui/App.tsx");
    expect(app.facet.aspect).toBe("ui");
    expect(app.facet.community).toBe("core cluster");
    expect(app.facet.strata).toBeGreaterThan(0); // imports core.ts → above foundation
    const core = model.buildings.find((b: any) => b.filePath === "src/core.ts");
    expect(core.facet.strata).toBe(0);
    expect(core.facet.exports).toBe(1);
    expect(core.facet.surface).toBe(1); // the max exporter normalizes to 1
  });

  it("adds the weather facet (and makes it default) when an overlay exists", () => {
    const model = buildCityModel(graphFixture(), {
      changedNodeIds: ["f1"],
      affectedNodeIds: ["f2"],
      baseBranch: "main",
    });
    const catalog = buildFacets(graphFixture(), model);
    expect(catalog.defaultFacetId).toBe("weather");
    const weather = catalog.facets.find((f: any) => f.id === "weather");
    const legend = weather.legend();
    const byKey = Object.fromEntries(legend.map((e: any) => [e.key, e.count]));
    expect(byKey.hot).toBe(1);
    expect(byKey.warm).toBe(1);
    expect(byKey.cold).toBe(1);
  });

  it("categorical legends count buildings and scalar legends carry gradient stops", () => {
    const model = buildCityModel(graphFixture());
    const catalog = buildFacets(graphFixture(), model);
    const aspect = catalog.facets.find((f: any) => f.id === "aspect");
    const total = aspect.legend().reduce((n: number, e: any) => n + e.count, 0);
    expect(total).toBe(model.buildingCount);
    const strata = catalog.facets.find((f: any) => f.id === "strata");
    const legend = strata.legend();
    expect(legend.stops).toHaveLength(3);
    expect(legend.min).toBe("foundation");
  });

  it("every facet colors every building without throwing", () => {
    const model = buildCityModel(graphFixture());
    const catalog = buildFacets(graphFixture(), model);
    for (const facet of catalog.facets) {
      for (const b of model.buildings) {
        const c = facet.colorOf(b);
        expect(Number.isInteger(c) && c >= 0 && c <= 0xffffff).toBe(true);
      }
    }
  });
});
