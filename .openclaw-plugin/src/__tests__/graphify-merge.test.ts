import { describe, expect, it } from "vitest";
import { validateGraph, type KnowledgeGraph } from "@understand-anything/core";
import { convertGraphifyGraph } from "../graphify-convert.js";
import { mergeGraphifyIntoPrimary, stripGraphifyArtifacts } from "../graphify-merge.js";
import type { GraphifyGraphJson } from "../graphify-run.js";

function primaryGraph(): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "test-project",
      languages: ["typescript"],
      frameworks: [],
      description: "Native UA analysis.",
      analyzedAt: "2026-07-16T00:00:00.000Z",
      gitCommitHash: "abc123",
    },
    nodes: [
      {
        id: "file:src/auth.ts",
        type: "file",
        name: "auth.ts",
        filePath: "src/auth.ts",
        summary: "Authentication module (native LLM summary).",
        tags: ["auth"],
        complexity: "moderate",
      },
      {
        id: "fn:src/auth.ts:login",
        type: "function",
        name: "login",
        filePath: "src/auth.ts",
        summary: "Validates credentials and opens a session.",
        tags: [],
        complexity: "simple",
      },
    ],
    edges: [
      {
        source: "file:src/auth.ts",
        target: "fn:src/auth.ts:login",
        type: "contains",
        direction: "forward",
        weight: 0.9,
      },
    ],
    layers: [{ id: "layer-core", name: "Core", description: "Native layer.", nodeIds: ["file:src/auth.ts"] }],
    tour: [],
  };
}

function graphifyRaw(): GraphifyGraphJson {
  return {
    nodes: [
      { id: "auth", label: "auth.ts", file_type: "code", source_file: "src/auth.ts", source_location: "L1", community: 0, community_name: "auth.ts" },
      { id: "auth_login", label: "login", file_type: "code", source_file: "src/auth.ts", source_location: "L10", community: 0, community_name: "auth.ts" },
      { id: "auth_helper", label: "hashPassword", file_type: "code", source_file: "src/auth.ts", source_location: "L30", community: 0, community_name: "auth.ts" },
    ],
    links: [
      // Agrees with the native contains edge (method → contains after mapping):
      { source: "auth", target: "auth_login", relation: "method", confidence: "EXTRACTED", weight: 1.0 },
      // Graphify-only edges:
      { source: "auth", target: "auth_helper", relation: "method", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth_login", target: "auth_helper", relation: "indirect_call", confidence: "INFERRED", confidence_score: 0.6, weight: 1.0 },
    ],
    hyperedges: [],
  };
}

function converted() {
  return convertGraphifyGraph(graphifyRaw(), "/tmp/proj", { idPrefix: "" }).graph;
}

describe("mergeGraphifyIntoPrimary", () => {
  it("reconciles nodes on (filePath, name, kind) — never raw ids", () => {
    const { graph, stats } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    // auth.ts file + login function match; hashPassword is graphify-only.
    expect(stats.matchedNodes).toBe(2);
    expect(stats.addedNodes).toBe(1);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("file:src/auth.ts"); // UA identity kept
    expect(ids).toContain("gfy:auth_helper"); // graphify-only added with prefix
    expect(ids).not.toContain("gfy:auth"); // matched node NOT duplicated
  });

  it("marks cross-engine agreement as origin both / confidence extracted", () => {
    const { graph, stats } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    expect(stats.agreedEdges).toBe(1);
    const agreed = graph.edges.find((e) => e.source === "file:src/auth.ts" && e.target === "fn:src/auth.ts:login");
    expect(agreed?.origin).toBe("both");
    expect(agreed?.confidence).toBe("extracted");
    expect(agreed?.weight).toBe(0.9); // native weight untouched — agreement lives in origin/confidence
  });

  it("adds graphify-only edges with their provenance intact", () => {
    const { graph } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    const indirect = graph.edges.find((e) => e.target === "gfy:auth_helper" && e.type === "calls");
    expect(indirect?.origin).toBe("graphify");
    expect(indirect?.confidence).toBe("inferred");
    expect(indirect?.confidenceScore).toBeCloseTo(0.6);
  });

  it("tags matched nodes engine:both and keeps their native summaries", () => {
    const { graph } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    const authFile = graph.nodes.find((n) => n.id === "file:src/auth.ts");
    expect(authFile?.tags).toContain("engine:both");
    expect(authFile?.summary).toBe("Authentication module (native LLM summary).");
  });

  it("adds community layers alongside native layers with remapped node ids", () => {
    const { graph, stats } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    expect(stats.addedLayers).toBe(1);
    expect(graph.layers.map((l) => l.id)).toEqual(["layer-core", "gfy-community-0"]);
    const community = graph.layers.find((l) => l.id === "gfy-community-0");
    expect(community?.nodeIds).toContain("file:src/auth.ts"); // remapped to UA id
    expect(community?.nodeIds).toContain("gfy:auth_helper");
  });

  it("is idempotent: merging twice yields the identical graph", () => {
    const once = mergeGraphifyIntoPrimary(primaryGraph(), converted()).graph;
    const twice = mergeGraphifyIntoPrimary(once, converted()).graph;
    expect(twice).toEqual(once);
  });

  it("stripGraphifyArtifacts restores a pristine native graph", () => {
    const merged = mergeGraphifyIntoPrimary(primaryGraph(), converted()).graph;
    const stripped = stripGraphifyArtifacts(merged);
    expect(stripped).toEqual(primaryGraph());
  });

  it("merged output passes UA validateGraph", () => {
    const { graph } = mergeGraphifyIntoPrimary(primaryGraph(), converted());
    expect(validateGraph(graph).success).toBe(true);
  });
});
