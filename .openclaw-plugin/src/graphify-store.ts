import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUaDir, type KnowledgeGraph } from "@understand-anything/core";

/**
 * Companion-graph persistence for the graphify engine — a sibling of
 * knowledge-graph.json in the project's .ua/ dir, mirroring the existing
 * domain-graph.json / diff-overlay.json companion-file pattern in
 * packages/core/persistence. The graphify view is a separate lens on the
 * same project, never a replacement for the primary graph.
 */

const GRAPHIFY_GRAPH_FILE = "graphify-graph.json";

export function graphifyGraphPath(projectRoot: string): string {
  return join(resolveUaDir(projectRoot), GRAPHIFY_GRAPH_FILE);
}

export function saveGraphifyGraph(projectRoot: string, graph: KnowledgeGraph): void {
  const dir = resolveUaDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(graphifyGraphPath(projectRoot), JSON.stringify(graph, null, 2), "utf-8");
}

export function loadGraphifyGraph(projectRoot: string): KnowledgeGraph | null {
  const p = graphifyGraphPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as KnowledgeGraph;
  } catch {
    return null;
  }
}
