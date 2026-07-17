import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

/** When set, the dashboard serves the interactive (LLM-backed Ask panel) server instead of the plain zero-LLM viewer. */
export interface InteractiveLlmOptions {
  apiKey: string;
  model: string;
}

export interface ViewerInstance {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  token: string;
  lastUsedAtMs: number;
}

const DASHBOARD_URL_RE = /Dashboard URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/;
const START_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;

// Keyed by project root. Holds the in-flight *promise*, not just the settled
// instance — set synchronously before spawn() returns, so two requests for
// the same project racing during the (up to START_TIMEOUT_MS) startup window
// both await the same spawn instead of each starting their own orphaned
// viewer process.
const viewers = new Map<string, Promise<ViewerInstance>>();

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

function resolveViewerBinPath(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("understand-anything-viewer/package.json");
  return join(dirname(pkgJsonPath), "bin", "viewer.mjs");
}

function hasGraph(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, ".ua", "knowledge-graph.json")) ||
    existsSync(join(projectRoot, ".understand-anything", "knowledge-graph.json"))
  );
}

function startViewer(projectRoot: string, log: Logger, llmOptions: InteractiveLlmOptions | null): Promise<ViewerInstance> {
  const viewerBin = resolveViewerBinPath();
  const viewerDist = join(dirname(viewerBin), "..", "dist");
  if (!existsSync(join(viewerDist, "index.html"))) {
    return Promise.reject(
      new Error(
        `understand-anything-viewer has not been built. Run: pnpm --filter understand-anything-viewer build (from the Understand-Anything repo root).`,
      ),
    );
  }

  // With an API key configured, serve the interactive server (adds a live
  // Ask panel) instead of the plain zero-LLM viewer. Same static dashboard
  // build and JSON API underneath — see interactive-server.ts's module doc.
  const interactiveServerPath = join(HERE, "interactive-server.js");
  const useInteractive = llmOptions !== null && existsSync(interactiveServerPath);
  const command = useInteractive ? interactiveServerPath : viewerBin;
  const commandArgs = useInteractive ? [projectRoot, "--port", "0"] : [projectRoot, "--port", "0", "--no-open"];
  const label = useInteractive ? "interactive server" : "viewer";

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [command, ...commandArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: useInteractive
        ? { ...process.env, UNDERSTAND_ANTHROPIC_API_KEY: llmOptions!.apiKey, UNDERSTAND_MODEL: llmOptions!.model }
        : process.env,
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      viewers.delete(projectRoot);
      reject(new Error(`Timed out waiting for the ${label} to start for ${projectRoot}`));
    }, START_TIMEOUT_MS);

    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(DASHBOARD_URL_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        const instance: ViewerInstance = {
          proc,
          port: Number(match[1]),
          token: match[2],
          lastUsedAtMs: Date.now(),
        };
        log.info(`[understand-anything] ${label} started for ${projectRoot} on port ${instance.port}`);
        resolve(instance);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      log.warn(`[understand-anything] ${label} stderr (${projectRoot}): ${chunk.toString().trim()}`);
    });
    proc.on("exit", (code) => {
      // Only clear the map if this process is still the tracked one — an
      // idle-evicted/superseded viewer's belated exit must not clobber a
      // newer entry that has since replaced it.
      viewers.get(projectRoot)?.then(
        (instance) => {
          if (instance.proc === proc) viewers.delete(projectRoot);
        },
        () => viewers.delete(projectRoot),
      );
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        viewers.delete(projectRoot);
        reject(new Error(`${label} exited (code ${code}) before starting for ${projectRoot}`));
      }
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        viewers.delete(projectRoot);
        reject(err);
      }
    });
  });
}

async function getOrStartViewer(projectRoot: string, log: Logger, llmOptions: InteractiveLlmOptions | null): Promise<ViewerInstance> {
  const pending = viewers.get(projectRoot);
  if (pending) {
    try {
      const instance = await pending;
      instance.lastUsedAtMs = Date.now();
      return instance;
    } catch {
      // Fall through and start a fresh one — the failed attempt already
      // removed itself from the map (see startViewer's reject paths).
    }
  }

  const startPromise = startViewer(projectRoot, log, llmOptions);
  viewers.set(projectRoot, startPromise);
  return startPromise;
}

/** Kills every tracked viewer process. Call on gateway shutdown to avoid leaking child processes across restarts. */
export function shutdownAllViewers(log: Logger): void {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  for (const [projectRoot, pending] of viewers) {
    pending
      .then((instance) => instance.proc.kill())
      .catch(() => {
        /* already dead / never started */
      });
    viewers.delete(projectRoot);
  }
  log.info("[understand-anything] shut down all tracked viewer processes");
}

/** Starts the idle-eviction sweep (kills viewers unused for IDLE_TIMEOUT_MS). Idempotent. */
export function startIdleViewerSweep(log: Logger): void {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [projectRoot, pending] of viewers) {
      pending
        .then((instance) => {
          if (now - instance.lastUsedAtMs > IDLE_TIMEOUT_MS) {
            log.info(`[understand-anything] evicting idle viewer for ${projectRoot} (port ${instance.port})`);
            instance.proc.kill();
            viewers.delete(projectRoot);
          }
        })
        .catch(() => viewers.delete(projectRoot));
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

// ── Reverse proxy: gateway origin → per-project 127.0.0.1 viewer ─────────────
// Serving the dashboards *through* the gateway's own port means no per-project
// random ports ever reach the browser: Caddy/firewall/device-pairing all apply
// once, at the gateway, for every project. Requires all dashboard/widget/city
// URLs to be relative (they are, as of this change).

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const PROXY_TIMEOUT_MS = 120_000;

/**
 * Streams one request through to a viewer instance and streams the response
 * back. `targetPath` must already include the query string. Exported for
 * direct integration testing without a gateway process.
 */
export function proxyToViewer(req: IncomingMessage, res: ServerResponse, viewer: ViewerInstance, targetPath: string): void {
  viewer.lastUsedAtMs = Date.now();
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }

  const upstream = http.request(
    { hostname: "127.0.0.1", port: viewer.port, path: targetPath, method: req.method, headers, timeout: PROXY_TIMEOUT_MS },
    (upstreamRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) outHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("viewer proxy timeout")));
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Dashboard proxy error: ${err.message}`);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

/** Ensure the viewer's access token is present in a path's query string (never overrides an existing one). */
export function withViewerToken(restPathAndQuery: string, token: string): string {
  const u = new URL(restPathAndQuery, "http://localhost");
  if (!u.searchParams.has("token")) u.searchParams.set("token", token);
  return u.pathname + u.search;
}

const PROJECT_PROXY_RE = /^\/understand-anything\/p\/(\d+)(\/.*)?$/;

function redirectToPicker(res: ServerResponse, error?: string): void {
  const location = error ? `/understand-anything?error=${encodeURIComponent(error)}` : "/understand-anything";
  res.writeHead(302, { Location: location });
  res.end();
}

export interface PickerOptions {
  getJobState: (root: string) => "running" | "done" | "error" | null;
  canAddProject: boolean;
  error?: string;
}

function pickerHtml(projects: string[], opts: PickerOptions): string {
  let anyRunning = false;
  const items = projects
    .map((p, i) => {
      const analyzed = hasGraph(p);
      const jobState = opts.getJobState(p);
      if (jobState === "running") anyRunning = true;

      if (analyzed) {
        if (jobState === "running") {
          return `<li><a href="/understand-anything/open?project=${i}">${escapeHtml(p)}</a> <em>(re-analyzing…)</em></li>`;
        }
        return `<li><a href="/understand-anything/open?project=${i}">${escapeHtml(p)}</a>
          <form method="POST" action="/understand-anything/analyze?project=${i}" style="display:inline">
            <button type="submit" style="font-size: 0.85em;">Re-analyze</button>
          </form></li>`;
      }
      if (jobState === "running") {
        return `<li>${escapeHtml(p)} — <em>analyzing… (this page refreshes automatically)</em></li>`;
      }
      if (jobState === "error") {
        return `<li>${escapeHtml(p)} — <span style="color:#c0392b">analysis failed</span>
          <form method="POST" action="/understand-anything/analyze?project=${i}" style="display:inline">
            <button type="submit">Retry analysis</button>
          </form></li>`;
      }
      return `<li>${escapeHtml(p)}
        <form method="POST" action="/understand-anything/analyze?project=${i}" style="display:inline">
          <button type="submit">Understand this project</button>
        </form></li>`;
    })
    .join("\n");

  const addForm = opts.canAddProject
    ? `<h2>Add a project</h2>
<form method="POST" action="/understand-anything/add-project">
  <input type="text" name="input" placeholder="https://github.com/owner/repo or /local/path" style="width: 400px;" required />
  <button type="submit">Add &amp; understand</button>
</form>
<p style="color:#666; font-size: 0.9em;">GitHub URLs are shallow-cloned locally. Local paths must already exist on this machine.</p>`
    : "";

  const errorBanner = opts.error
    ? `<p style="color:#c0392b; border: 1px solid #c0392b; padding: 8px 12px; border-radius: 6px;">${escapeHtml(opts.error)}</p>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Understand Anything</title>${
    anyRunning ? `<meta http-equiv="refresh" content="5">` : ""
  }</head>
<body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto;">
<h1>Understand Anything</h1>
${errorBanner}
<p>Configured projects:</p>
<ul>${items || "<li>No projects configured — set plugins.entries.understand-anything.config.projects</li>"}</ul>
${addForm}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pathFromUrl(url: string | undefined): { pathname: string; query: URLSearchParams } {
  const u = new URL(url ?? "/", "http://localhost");
  return { pathname: u.pathname, query: u.searchParams };
}

const MAX_FORM_BODY_BYTES = 8192;

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FORM_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

export interface DashboardRouteOptions {
  getProjects: () => string[];
  getLlmOptions: () => InteractiveLlmOptions | null;
  getJobState: (root: string) => "running" | "done" | "error" | null;
  startAnalysis: (root: string) => { started: true } | { error: string };
  /** null when runtime project addition is disabled (allowAddProject config flag is off). */
  addProject: ((input: string) => Promise<{ root: string } | { error: string }>) | null;
}

export function registerDashboardRoutes(
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }) => void,
  log: Logger,
  opts: DashboardRouteOptions,
): void {
  startIdleViewerSweep(log);

  const servePicker = async (req: IncomingMessage, res: ServerResponse) => {
    const { query } = pathFromUrl(req.url);
    sendHtml(
      res,
      200,
      pickerHtml(opts.getProjects(), {
        getJobState: opts.getJobState,
        canAddProject: opts.addProject !== null,
        error: query.get("error") ?? undefined,
      }),
    );
  };

  registerHttpRoute({ path: "/understand-anything", auth: "plugin", match: "exact", handler: servePicker });
  registerHttpRoute({
    path: "/understand-anything/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      const { pathname, query } = pathFromUrl(req.url);
      const method = (req.method ?? "GET").toUpperCase();

      // Same-origin dashboard proxy: /understand-anything/p/<idx>/<rest> —
      // the browser only ever talks to the gateway's port; the per-project
      // 127.0.0.1 viewer stays an implementation detail.
      const proxyMatch = PROJECT_PROXY_RE.exec(pathname);
      if (proxyMatch) {
        const projects = opts.getProjects();
        const idx = Number(proxyMatch[1]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= projects.length) {
          return sendHtml(res, 404, '<p>Unknown project index. <a href="/understand-anything">Back</a></p>');
        }
        const projectRoot = projects[idx];
        if (!hasGraph(projectRoot)) {
          return sendHtml(res, 404, `<p>No knowledge graph for <code>${escapeHtml(projectRoot)}</code> yet — analyze it first.</p>`);
        }
        try {
          const viewer = await getOrStartViewer(projectRoot, log, opts.getLlmOptions());
          const rest = proxyMatch[2];
          if (rest === undefined || rest === "") {
            // Canonicalize to the trailing-slash form so the page's relative
            // URLs resolve inside the /p/<idx>/ prefix.
            const search = new URL(req.url ?? "/", "http://localhost").search;
            res.writeHead(302, { Location: withViewerToken(`/understand-anything/p/${idx}/${search}`, viewer.token) });
            res.end();
            return;
          }
          const search = new URL(req.url ?? "/", "http://localhost").search;
          proxyToViewer(req, res, viewer, withViewerToken(`${rest}${search}`, viewer.token));
        } catch (err) {
          log.error(`[understand-anything] proxy failed for ${projectRoot}:`, err);
          sendHtml(res, 502, `<p>Failed to reach dashboard viewer: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
        }
        return;
      }

      if (pathname === "/understand-anything/analyze" && method === "POST") {
        const projects = opts.getProjects();
        const idx = Number(query.get("project"));
        if (!Number.isInteger(idx) || idx < 0 || idx >= projects.length) {
          return redirectToPicker(res, "Unknown project index.");
        }
        const result = opts.startAnalysis(projects[idx]);
        return redirectToPicker(res, "error" in result ? result.error : undefined);
      }

      if (pathname === "/understand-anything/add-project" && method === "POST") {
        if (!opts.addProject) return redirectToPicker(res, "Adding projects is disabled.");
        try {
          const form = await readFormBody(req);
          const input = form.get("input") ?? "";
          const result = await opts.addProject(input);
          if ("error" in result) return redirectToPicker(res, result.error);
          opts.startAnalysis(result.root); // add & understand in one step
          return redirectToPicker(res);
        } catch (err) {
          return redirectToPicker(res, err instanceof Error ? err.message : String(err));
        }
      }

      if (pathname === "/understand-anything/open") {
        const projects = opts.getProjects();
        if (!query.has("project")) {
          return sendHtml(res, 400, "<p>Missing required <code>project</code> query param. <a href=\"/understand-anything\">Back</a></p>");
        }
        const idx = Number(query.get("project"));
        if (!Number.isInteger(idx) || idx < 0 || idx >= projects.length) {
          return sendHtml(res, 400, "<p>Unknown project index. <a href=\"/understand-anything\">Back</a></p>");
        }
        const projectRoot = projects[idx];
        if (!hasGraph(projectRoot)) {
          return sendHtml(
            res,
            404,
            `<p>No knowledge graph found for <code>${escapeHtml(projectRoot)}</code> yet. Call the <code>understand_analyze_project</code> tool first.</p>`,
          );
        }
        try {
          // Same-origin redirect into the gateway-mounted proxy — the browser
          // never sees the viewer's 127.0.0.1 port (it wouldn't be reachable
          // from another machine anyway; the gateway's port is the one that
          // Caddy/firewall/pairing already cover).
          const viewer = await getOrStartViewer(projectRoot, log, opts.getLlmOptions());
          res.writeHead(302, { Location: `/understand-anything/p/${idx}/?token=${viewer.token}` });
          res.end();
        } catch (err) {
          log.error(`[understand-anything] failed to start viewer for ${projectRoot}:`, err);
          sendHtml(res, 500, `<p>Failed to start dashboard viewer: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
        }
        return;
      }

      return servePicker(req, res);
    },
  });

  log.info("[understand-anything] dashboard routes registered: /understand-anything");
}
