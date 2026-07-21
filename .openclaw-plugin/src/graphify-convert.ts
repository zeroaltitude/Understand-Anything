import { basename, extname, isAbsolute, relative } from "node:path";
import type { GraphEdge, GraphNode, KnowledgeGraph, Layer, NodeType, EdgeType } from "@understand-anything/core";
import type { GraphifyEdge, GraphifyGraphJson, GraphifyNode } from "./graphify-run.js";

/**
 * Converts graphify's NetworkX node-link graph.json into UA's KnowledgeGraph
 * schema. Design doc: ~/reports/graphify-ua-integration-plan-2026-07-16.md §5.
 *
 * Graphify nodes carry no explicit kind (function/class/file) — kind is
 * implied by the graph structure — so code-node typing here is heuristic,
 * classified from incident edges (extends ⇒ class, method target ⇒ function,
 * calls target ⇒ function, source_file basename match ⇒ file). Verified
 * against real output 2026-07-16: node attrs {id,label,file_type,source_file,
 * source_location,community,community_name,_origin}, edge attrs {relation,
 * confidence,confidence_score,weight,context,source_file,source_location}.
 */

export const GRAPHIFY_ID_PREFIX = "gfy:";

/** graphify file_type → UA NodeType for non-code nodes. */
const FILE_TYPE_MAP: Record<string, NodeType> = {
  document: "document",
  paper: "article",
  concept: "concept",
  doc_ref: "source",
  rationale: "concept",
  image: "resource",
};

/** graphify relation → UA EdgeType. Unknowns fall back to "related" with the verb preserved. */
const RELATION_MAP: Record<string, EdgeType> = {
  calls: "calls",
  indirect_call: "calls",
  imports: "imports",
  imports_from: "imports",
  dynamic_import: "imports",
  re_exports: "exports",
  contains: "contains",
  defines: "contains",
  method: "contains",
  extends: "inherits",
  implements: "implements",
  references: "related",
  cites: "cites",
  rationale_for: "documents",
  semantically_similar_to: "similar_to",
};

/** Relations whose original verb is worth preserving even though they map cleanly. */
const ANNOTATED_RELATIONS = new Set(["indirect_call", "dynamic_import", "references", "method", "defines", "rationale_for"]);

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".php": "php",
  ".scala": "scala",
  ".md": "markdown",
  ".sql": "sql",
};

function parseLineRange(sourceLocation: string | undefined): [number, number] | undefined {
  if (!sourceLocation) return undefined;
  const m = /^L?(\d+)$/.exec(sourceLocation.trim());
  if (!m) return undefined;
  const line = Number(m[1]);
  return [line, line];
}

function relativizePath(sourceFile: string | undefined, projectRoot: string): string | undefined {
  if (!sourceFile) return undefined;
  if (!isAbsolute(sourceFile)) return sourceFile;
  const rel = relative(projectRoot, sourceFile);
  return rel.startsWith("..") ? undefined : rel;
}

interface NodeEdgeProfile {
  isExtendsEndpoint: boolean;
  isMethodTarget: boolean;
  isCallTarget: boolean;
}

function classifyCodeNode(node: GraphifyNode, profile: NodeEdgeProfile): NodeType {
  const label = node.label ?? node.id;
  const sourceBase = node.source_file ? basename(node.source_file) : undefined;
  if (sourceBase && label === sourceBase) return "file";
  if (profile.isExtendsEndpoint) return "class";
  if (profile.isMethodTarget || profile.isCallTarget) return "function";
  return "module";
}

export function convertGraphifyNodeType(node: GraphifyNode, profile: NodeEdgeProfile): NodeType {
  const ft = node.file_type ?? "code";
  if (ft === "code") return classifyCodeNode(node, profile);
  return FILE_TYPE_MAP[ft] ?? "resource";
}

export interface ConvertOptions {
  projectName?: string;
  analyzedAt?: string;
  /** Prefix node ids (view mode). Merge mode passes "" and reconciles ids itself. */
  idPrefix?: string;
}

export interface ConvertResult {
  graph: KnowledgeGraph;
  droppedHyperedges: number;
  unknownRelations: string[];
}

export function convertGraphifyGraph(
  raw: GraphifyGraphJson,
  projectRoot: string,
  options: ConvertOptions = {},
): ConvertResult {
  const idPrefix = options.idPrefix ?? GRAPHIFY_ID_PREFIX;
  const edgesIn: GraphifyEdge[] = raw.links ?? raw.edges ?? [];

  // Pass 1 over edges: build the incidence profile that code-node typing needs.
  const profiles = new Map<string, NodeEdgeProfile>();
  const profileFor = (id: string): NodeEdgeProfile => {
    let p = profiles.get(id);
    if (!p) {
      p = { isExtendsEndpoint: false, isMethodTarget: false, isCallTarget: false };
      profiles.set(id, p);
    }
    return p;
  };
  for (const e of edgesIn) {
    if (e.relation === "extends") {
      profileFor(e.source).isExtendsEndpoint = true;
      profileFor(e.target).isExtendsEndpoint = true;
    } else if (e.relation === "method") {
      profileFor(e.target).isMethodTarget = true;
    } else if (e.relation === "calls" || e.relation === "indirect_call") {
      profileFor(e.target).isCallTarget = true;
    }
  }

  const emptyProfile: NodeEdgeProfile = { isExtendsEndpoint: false, isMethodTarget: false, isCallTarget: false };
  const knownIds = new Set<string>();
  const languages = new Set<string>();

  const nodes: GraphNode[] = raw.nodes.map((n) => {
    knownIds.add(n.id);
    const filePath = relativizePath(n.source_file, projectRoot);
    if (filePath) {
      const lang = EXT_LANGUAGE[extname(filePath).toLowerCase()];
      if (lang) languages.add(lang);
    }
    const type = convertGraphifyNodeType(n, profiles.get(n.id) ?? emptyProfile);
    const label = n.label ?? n.id;
    const isRationale = n.file_type === "rationale";
    const tags = ["graphify"];
    if (n.community_name) tags.push(`community:${n.community_name}`);
    if (isRationale) tags.push("rationale");
    return {
      id: `${idPrefix}${n.id}`,
      type,
      name: label,
      ...(filePath ? { filePath } : {}),
      ...(parseLineRange(n.source_location) ? { lineRange: parseLineRange(n.source_location) } : {}),
      summary: isRationale
        ? String(label)
        : `${type} ${label}${filePath ? ` in ${filePath}` : ""} (graphify pass-1 extraction).`,
      tags,
      complexity: "simple",
      ...(isRationale ? { knowledgeMeta: { content: String(label) } } : {}),
    };
  });

  const unknownRelations = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of edgesIn) {
    // node-link edges can reference ids that were filtered out upstream; a
    // dangling edge would fail UA validation, so drop rather than invent nodes.
    if (!knownIds.has(e.source) || !knownIds.has(e.target)) continue;
    const relation = e.relation ?? "related";
    const mapped = RELATION_MAP[relation];
    if (!mapped) unknownRelations.add(relation);
    const description = !mapped || ANNOTATED_RELATIONS.has(relation) ? `graphify:${relation}` : undefined;
    const confidence =
      e.confidence === "EXTRACTED" ? "extracted" : e.confidence === "AMBIGUOUS" ? "ambiguous" : e.confidence === "INFERRED" ? "inferred" : undefined;
    const weight = typeof e.weight === "number" ? Math.max(0, Math.min(1, e.weight)) : 0.5;
    edges.push({
      source: `${idPrefix}${e.source}`,
      target: `${idPrefix}${e.target}`,
      type: mapped ?? "related",
      direction: "forward",
      ...(description ? { description } : {}),
      weight: relation === "indirect_call" ? weight * 0.8 : weight,
      origin: "graphify",
      ...(confidence ? { confidence } : {}),
      ...(confidence === "inferred" && typeof e.confidence_score === "number" ? { confidenceScore: Math.max(0, Math.min(1, e.confidence_score)) } : {}),
    });
  }

  // Communities arrive denormalized on nodes (community / community_name) —
  // group them back into UA layers so the dashboard's existing layers UI
  // renders graphify's Leiden clustering with zero UI changes.
  const communities = new Map<number, { name: string; nodeIds: string[] }>();
  for (const n of raw.nodes) {
    if (typeof n.community !== "number") continue;
    let c = communities.get(n.community);
    if (!c) {
      c = { name: n.community_name ?? `Community ${n.community}`, nodeIds: [] };
      communities.set(n.community, c);
    }
    c.nodeIds.push(`${idPrefix}${n.id}`);
  }
  const layers: Layer[] = [...communities.entries()]
    .sort(([a], [b]) => a - b)
    .map(([communityId, c]) => ({
      id: `gfy-community-${communityId}`,
      name: c.name,
      description: `Graphify community ${communityId} (Leiden/Louvain clustering, labeled by hub node).`,
      nodeIds: c.nodeIds,
    }));

  const graph: KnowledgeGraph = {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: options.projectName ?? basename(projectRoot),
      languages: [...languages].sort(),
      frameworks: [],
      description: `Graphify pass-1 (deterministic tree-sitter) analysis of ${options.projectName ?? basename(projectRoot)}.`,
      analyzedAt: options.analyzedAt ?? new Date().toISOString(),
      gitCommitHash: "",
    },
    nodes,
    edges,
    layers,
    tour: [],
  };

  return {
    graph,
    droppedHyperedges: Array.isArray(raw.hyperedges) ? raw.hyperedges.length : 0,
    unknownRelations: [...unknownRelations].sort(),
  };
}
