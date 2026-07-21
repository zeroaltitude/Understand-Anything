import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GraphifyConfig {
  /** Path to a graphify checkout managed by uv (runs `uv run --project <dir> graphify`). */
  dir?: string;
  /** Explicit command override, e.g. ["graphify"] for a pip install. Wins over `dir`. */
  cmd?: string[];
  timeoutMs?: number;
}

export interface GraphifyRunResult {
  graphJsonPath: string;
  stdout: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolves how to invoke the graphify CLI. Three tiers, most explicit wins:
 * an exact `cmd` array from config, a uv-managed checkout via `dir`, or a
 * bare `graphify` already on the gateway's PATH. Returns null when none is
 * configured — callers treat that as "engine unavailable", never an error
 * that blocks native analysis.
 */
export function resolveGraphifyCommand(cfg: GraphifyConfig | undefined): string[] | null {
  if (cfg?.cmd?.length) return [...cfg.cmd];
  if (cfg?.dir) {
    if (!existsSync(join(cfg.dir, "pyproject.toml"))) return null;
    return ["uv", "run", "--project", cfg.dir, "graphify"];
  }
  return null;
}

/**
 * Runs graphify's deterministic pass-1 extraction (`graphify update <root>`)
 * as a subprocess — no LLM calls, pure tree-sitter + clustering, sub-second on
 * small projects. Output lands in `<root>/graphify-out/graph.json` (location
 * fixed by graphify itself). The subprocess gets a hard timeout: a wedged
 * child must never hold an analysis job open indefinitely (same rationale as
 * the HTTPS deadline in llm.ts).
 */
export function runGraphifyExtract(
  projectRoot: string,
  cfg: GraphifyConfig | undefined,
  onProgress?: (message: string) => void,
): Promise<GraphifyRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const command = resolveGraphifyCommand(cfg);
    if (!command) {
      rejectPromise(new Error("graphify engine not configured (set graphify.dir or graphify.cmd in plugin config)"));
      return;
    }

    const timeoutMs = cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    onProgress?.(`graphify: running ${command.join(" ")} update ${projectRoot}`);

    const child = spawn(command[0], [...command.slice(1), "update", projectRoot], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new Error(`graphify timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`graphify failed to start (${command[0]}): ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`graphify exited with code ${code}: ${(stderr || stdout).slice(-500)}`));
        return;
      }
      const graphJsonPath = join(projectRoot, "graphify-out", "graph.json");
      if (!existsSync(graphJsonPath)) {
        rejectPromise(new Error(`graphify completed but ${graphJsonPath} was not produced: ${(stderr || stdout).slice(-500)}`));
        return;
      }
      onProgress?.(`graphify: extraction complete in ${Date.now() - started}ms`);
      resolvePromise({ graphJsonPath, stdout, durationMs: Date.now() - started });
    });
  });
}

/** Parsed node-link graph.json, minimally typed to what the converter consumes. */
export interface GraphifyGraphJson {
  directed?: boolean;
  nodes: GraphifyNode[];
  links?: GraphifyEdge[];
  edges?: GraphifyEdge[];
  hyperedges?: unknown[];
}

export interface GraphifyNode {
  id: string;
  label?: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number;
  community_name?: string;
  _origin?: string;
  [key: string]: unknown;
}

export interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  confidence_score?: number;
  weight?: number;
  context?: string;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}

export function readGraphifyGraph(graphJsonPath: string): GraphifyGraphJson {
  const parsed = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphifyGraphJson;
  if (!Array.isArray(parsed.nodes)) throw new Error(`${graphJsonPath}: missing nodes array`);
  if (!Array.isArray(parsed.links) && !Array.isArray(parsed.edges)) {
    throw new Error(`${graphJsonPath}: missing links/edges array`);
  }
  return parsed;
}
