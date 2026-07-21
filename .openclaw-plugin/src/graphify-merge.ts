import type { GraphEdge, GraphNode, KnowledgeGraph, NodeType } from "@understand-anything/core";
import { GRAPHIFY_ID_PREFIX } from "./graphify-convert.js";

/**
 * Merges a converted graphify graph (produced with idPrefix: "") into the
 * primary UA knowledge graph, provenance-tagged. Design doc §6:
 *
 * - The UA graph is primary: matched nodes keep their UA identity/summary.
 * - Reconciliation is on (filePath, name, kind-category) — NEVER raw ids;
 *   the two engines' id schemes are unrelated.
 * - Edges both engines agree on → origin "both", confidence "extracted"
 *   (two independent engines agreeing is the strongest signal we have).
 * - Graphify-only nodes/edges are added with origin/tag markers.
 * - Communities land as extra layers (id prefix "gfy-community-").
 *
 * Idempotent by construction: every merge first strips all graphify-origin
 * artifacts from the primary graph, then re-adds from the fresh conversion —
 * re-running a merge can never accrete duplicates (graphify's own #1917
 * id-accretion regression is the cautionary tale here).
 */

const GRAPHIFY_NODE_TAG = "origin:graphify";
const BOTH_ENGINES_TAG = "engine:both";
const GRAPHIFY_LAYER_PREFIX = "gfy-community-";

/** Collapse both engines' node types into comparable kind buckets. */
function kindCategory(type: NodeType): string {
  switch (type) {
    case "file":
      return "file";
    case "function":
      return "function";
    case "class":
      return "class";
    case "module":
      return "module";
    default:
      return "other";
  }
}

function reconcileKey(n: GraphNode): string | null {
  // Nodes without a filePath (project-level concepts, LLM syntheses) are too
  // ambiguous to match across engines — never reconcile them.
  if (!n.filePath) return null;
  return `${n.filePath}|${n.name.toLowerCase()}|${kindCategory(n.type)}`;
}

function edgeKey(e: GraphEdge): string {
  return `${e.source}→${e.target}|${e.type}`;
}

export interface MergeResult {
  graph: KnowledgeGraph;
  stats: {
    matchedNodes: number;
    addedNodes: number;
    agreedEdges: number;
    addedEdges: number;
    addedLayers: number;
  };
}

/** Remove every graphify-origin artifact from a (possibly previously merged) graph. */
export function stripGraphifyArtifacts(graph: KnowledgeGraph): KnowledgeGraph {
  const removedNodeIds = new Set(
    graph.nodes.filter((n) => n.tags.includes(GRAPHIFY_NODE_TAG) || n.id.startsWith(GRAPHIFY_ID_PREFIX)).map((n) => n.id),
  );
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => !removedNodeIds.has(n.id))
      .map((n) => (n.tags.includes(BOTH_ENGINES_TAG) ? { ...n, tags: n.tags.filter((t) => t !== BOTH_ENGINES_TAG) } : n)),
    edges: graph.edges
      .filter((e) => e.origin !== "graphify" && !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target))
      .map((e) => {
        if (e.origin !== "both") return e;
        // Demote prior cross-engine agreement back to plain UA provenance;
        // this merge will re-derive it if the engines still agree.
        const { origin: _origin, confidence: _confidence, confidenceScore: _score, ...rest } = e;
        return rest;
      }),
    layers: graph.layers.filter((l) => !l.id.startsWith(GRAPHIFY_LAYER_PREFIX)),
  };
}

export function mergeGraphifyIntoPrimary(primary: KnowledgeGraph, graphify: KnowledgeGraph): MergeResult {
  const base = stripGraphifyArtifacts(primary);

  // Reconcile graphify node ids → primary node ids.
  const primaryByKey = new Map<string, GraphNode>();
  for (const n of base.nodes) {
    const key = reconcileKey(n);
    if (key && !primaryByKey.has(key)) primaryByKey.set(key, n);
  }

  const idMap = new Map<string, string>(); // graphify node id → merged-graph node id
  const matchedPrimaryIds = new Set<string>();
  const addedNodes: GraphNode[] = [];

  for (const gn of graphify.nodes) {
    const key = reconcileKey(gn);
    const match = key ? primaryByKey.get(key) : undefined;
    if (match) {
      idMap.set(gn.id, match.id);
      matchedPrimaryIds.add(match.id);
    } else {
      const newId = `${GRAPHIFY_ID_PREFIX}${gn.id}`;
      idMap.set(gn.id, newId);
      addedNodes.push({
        ...gn,
        id: newId,
        tags: gn.tags.includes(GRAPHIFY_NODE_TAG) ? gn.tags : [...gn.tags, GRAPHIFY_NODE_TAG],
      });
    }
  }

  const nodes = base.nodes.map((n) => (matchedPrimaryIds.has(n.id) ? { ...n, tags: [...n.tags, BOTH_ENGINES_TAG] } : n));
  nodes.push(...addedNodes);

  // Edges: agreement detection on (reconciled source, reconciled target, type).
  const primaryEdgeIndex = new Map<string, number>();
  const edges: GraphEdge[] = base.edges.map((e, i) => {
    primaryEdgeIndex.set(edgeKey(e), i);
    return { ...e };
  });

  let agreedEdges = 0;
  let addedEdges = 0;
  for (const ge of graphify.edges) {
    const source = idMap.get(ge.source);
    const target = idMap.get(ge.target);
    if (!source || !target) continue;
    const remapped: GraphEdge = { ...ge, source, target };
    const existingIdx = primaryEdgeIndex.get(edgeKey(remapped));
    if (existingIdx !== undefined) {
      const existing = edges[existingIdx];
      // Keep the native weight untouched — agreement is expressed via
      // origin/confidence, and leaving weight alone keeps stripGraphifyArtifacts
      // a perfect inverse of the merge.
      edges[existingIdx] = { ...existing, origin: "both", confidence: "extracted" };
      agreedEdges++;
    } else {
      edges.push({ ...remapped, origin: "graphify" });
      primaryEdgeIndex.set(edgeKey(remapped), edges.length - 1);
      addedEdges++;
    }
  }

  // Graphify community layers, node ids remapped through the reconciliation.
  const gfyLayers = graphify.layers
    .filter((l) => l.id.startsWith(GRAPHIFY_LAYER_PREFIX))
    .map((l) => ({
      ...l,
      nodeIds: l.nodeIds.map((id) => idMap.get(id) ?? id).filter((id, i, arr) => arr.indexOf(id) === i),
    }));

  return {
    graph: { ...base, nodes, edges, layers: [...base.layers, ...gfyLayers] },
    stats: {
      matchedNodes: matchedPrimaryIds.size,
      addedNodes: addedNodes.length,
      agreedEdges,
      addedEdges,
      addedLayers: gfyLayers.length,
    },
  };
}
