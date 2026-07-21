import { describe, expect, it } from "vitest";
import { validateGraph } from "@understand-anything/core";
import { convertGraphifyGraph, GRAPHIFY_ID_PREFIX } from "../graphify-convert.js";
import type { GraphifyGraphJson } from "../graphify-run.js";

/** Fixture matching the real node-link shape observed from `graphify update` (2026-07-16). */
function fixture(): GraphifyGraphJson {
  return {
    directed: false,
    nodes: [
      {
        id: "auth",
        label: "auth.ts",
        file_type: "code",
        source_file: "src/auth.ts",
        source_location: "L1",
        _origin: "ast",
        community: 0,
        community_name: "auth.ts",
      },
      {
        id: "auth_login",
        label: "login",
        file_type: "code",
        source_file: "src/auth.ts",
        source_location: "L10",
        _origin: "ast",
        community: 0,
        community_name: "auth.ts",
      },
      {
        id: "auth_session",
        label: "Session",
        file_type: "code",
        source_file: "src/auth.ts",
        source_location: "L3",
        _origin: "ast",
        community: 0,
        community_name: "auth.ts",
      },
      {
        id: "base_session",
        label: "BaseSession",
        file_type: "code",
        source_file: "src/base.ts",
        source_location: "L2",
        _origin: "ast",
        community: 1,
        community_name: "base.ts",
      },
      {
        id: "auth_rationale",
        label: "Sessions expire after 30m to bound token theft impact",
        file_type: "rationale",
        source_file: "src/auth.ts",
        source_location: "L8",
        community: 0,
        community_name: "auth.ts",
      },
      {
        id: "readme",
        label: "README.md",
        file_type: "document",
        source_file: "README.md",
        source_location: "L1",
        community: 1,
        community_name: "base.ts",
      },
    ],
    links: [
      { source: "auth", target: "auth_login", relation: "method", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth_session", target: "base_session", relation: "extends", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth", target: "auth_login", relation: "calls", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth_login", target: "auth_session", relation: "indirect_call", confidence: "INFERRED", confidence_score: 0.7, weight: 1.0 },
      { source: "auth_rationale", target: "auth_login", relation: "rationale_for", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth", target: "unknown_ghost", relation: "calls", confidence: "EXTRACTED", weight: 1.0 },
      { source: "auth", target: "readme", relation: "some_novel_relation", confidence: "INFERRED", weight: 0.4 },
    ],
    hyperedges: [{ nodes: ["auth", "readme", "base_session"], relation: "grouped" }],
  };
}

describe("convertGraphifyGraph", () => {
  it("produces a graph that passes UA validateGraph", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    const result = validateGraph(graph);
    expect(result.success).toBe(true);
  });

  it("classifies code nodes from edge incidence (file / class / function)", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get(`${GRAPHIFY_ID_PREFIX}auth`)?.type).toBe("file"); // label == basename(source_file)
    expect(byId.get(`${GRAPHIFY_ID_PREFIX}auth_session`)?.type).toBe("class"); // extends endpoint
    expect(byId.get(`${GRAPHIFY_ID_PREFIX}auth_login`)?.type).toBe("function"); // method/call target
  });

  it("maps rationale nodes to concept with content preserved and non-code file_types to knowledge types", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const rationale = byId.get(`${GRAPHIFY_ID_PREFIX}auth_rationale`);
    expect(rationale?.type).toBe("concept");
    expect(rationale?.tags).toContain("rationale");
    expect(rationale?.knowledgeMeta?.content).toMatch(/Sessions expire/);
    expect(byId.get(`${GRAPHIFY_ID_PREFIX}readme`)?.type).toBe("document");
  });

  it("maps relations per the design table and annotates lossy mappings", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    const types = new Set(graph.edges.map((e) => e.type));
    expect(types).toContain("inherits"); // extends
    expect(types).toContain("contains"); // method
    expect(types).toContain("calls");
    expect(types).toContain("documents"); // rationale_for
    const indirect = graph.edges.find((e) => e.description?.includes("graphify:indirect_call"));
    expect(indirect).toBeDefined();
    expect(indirect!.type).toBe("calls");
    expect(indirect!.weight).toBeCloseTo(0.8);
    expect(indirect!.origin).toBe("graphify");
    expect(indirect!.confidence).toBe("inferred");
    expect(indirect!.confidenceScore).toBeCloseTo(0.7);
  });

  it("falls back to related for unknown relations and reports them", () => {
    const { graph, unknownRelations } = convertGraphifyGraph(fixture(), "/tmp/proj");
    expect(unknownRelations).toEqual(["some_novel_relation"]);
    const novel = graph.edges.find((e) => e.description?.includes("graphify:some_novel_relation"));
    expect(novel?.type).toBe("related");
  });

  it("drops edges referencing nodes absent from the node list", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    expect(graph.edges.some((e) => e.target.includes("unknown_ghost"))).toBe(false);
  });

  it("groups communities into layers named by hub", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    expect(graph.layers).toHaveLength(2);
    const layer0 = graph.layers.find((l) => l.id === "gfy-community-0");
    expect(layer0?.name).toBe("auth.ts");
    expect(layer0?.nodeIds).toContain(`${GRAPHIFY_ID_PREFIX}auth_login`);
  });

  it("counts dropped hyperedges instead of silently discarding them", () => {
    const { droppedHyperedges } = convertGraphifyGraph(fixture(), "/tmp/proj");
    expect(droppedHyperedges).toBe(1);
  });

  it("infers project languages from file extensions", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj");
    expect(graph.project.languages).toContain("typescript");
    expect(graph.project.languages).toContain("markdown");
  });

  it("supports an empty id prefix for merge mode", () => {
    const { graph } = convertGraphifyGraph(fixture(), "/tmp/proj", { idPrefix: "" });
    expect(graph.nodes[0].id).toBe("auth");
    expect(graph.edges.every((e) => !e.source.startsWith(GRAPHIFY_ID_PREFIX))).toBe(true);
  });
});
