import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { proxyToViewer, withViewerToken, type ViewerInstance } from "../dashboard-route.js";

// Integration test for the gateway-origin reverse proxy: a stub "viewer"
// upstream that echoes what it receives, a front server that routes through
// proxyToViewer, and real HTTP requests through the pair.

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

afterAll(() => {
  for (const s of servers) s.close();
});

async function makePair(): Promise<{ frontPort: number; viewer: ViewerInstance }> {
  // Upstream stub: echoes method/path/body/selected headers as JSON.
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "X-Upstream": "yes" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, askToken: req.headers["x-ask-token"] ?? null, host: req.headers.host ?? null }));
    });
  });
  const upstreamPort = await listen(upstream);
  const viewer: ViewerInstance = { proc: null as never, port: upstreamPort, token: "sekrit", lastUsedAtMs: 0 };

  // Front: strips the /p/0 prefix exactly like the dashboard route does.
  const front = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const rest = u.pathname.replace(/^\/understand-anything\/p\/0/, "") || "/";
    proxyToViewer(req, res, viewer, withViewerToken(`${rest}${u.search}`, viewer.token));
  });
  const frontPort = await listen(front);
  return { frontPort, viewer };
}

describe("dashboard reverse proxy", () => {
  it("streams GETs through with the prefix stripped and the viewer token injected", async () => {
    const { frontPort } = await makePair();
    const res = await fetch(`http://127.0.0.1:${frontPort}/understand-anything/p/0/knowledge-graph.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    const echoed = await res.json();
    expect(echoed.method).toBe("GET");
    expect(echoed.url).toBe("/knowledge-graph.json?token=sekrit");
  });

  it("preserves an existing token instead of overriding it", async () => {
    const { frontPort } = await makePair();
    const res = await fetch(`http://127.0.0.1:${frontPort}/understand-anything/p/0/meta.json?token=user-supplied`);
    const echoed = await res.json();
    expect(echoed.url).toBe("/meta.json?token=user-supplied");
  });

  it("streams POST bodies and pass-through headers (X-Ask-Token)", async () => {
    const { frontPort } = await makePair();
    const res = await fetch(`http://127.0.0.1:${frontPort}/understand-anything/p/0/ask.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ask-Token": "sekrit" },
      body: JSON.stringify({ question: "hi", history: [] }),
    });
    const echoed = await res.json();
    expect(echoed.method).toBe("POST");
    expect(JSON.parse(echoed.body)).toEqual({ question: "hi", history: [] });
    expect(echoed.askToken).toBe("sekrit");
  });

  it("does not leak the gateway Host header to the upstream", async () => {
    const { frontPort, viewer } = await makePair();
    const res = await fetch(`http://127.0.0.1:${frontPort}/understand-anything/p/0/`, {
      headers: { Host: "public.example.com:8443" },
    });
    const echoed = await res.json();
    // Node fills in the actual connection host when none is forwarded.
    expect(echoed.host).toBe(`127.0.0.1:${viewer.port}`);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    // Grab a real ephemeral port, then free it — guarantees ECONNREFUSED
    // (a hardcoded low port can be silently dropped under WSL2 mirrored
    // networking, which hangs instead of refusing).
    const placeholder = createServer(() => {});
    const deadPort = await new Promise<number>((resolve) => {
      placeholder.listen(0, "127.0.0.1", () => {
        const addr = placeholder.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        placeholder.close(() => resolve(port));
      });
    });
    const viewer: ViewerInstance = { proc: null as never, port: deadPort, token: "t", lastUsedAtMs: 0 };
    const front = createServer((req, res) => proxyToViewer(req, res, viewer, "/"));
    const frontPort = await listen(front);
    const res = await fetch(`http://127.0.0.1:${frontPort}/`);
    expect(res.status).toBe(502);
  });

  it("withViewerToken handles query-less, queried, and tokened paths", () => {
    expect(withViewerToken("/", "t")).toBe("/?token=t");
    expect(withViewerToken("/city?graph=graphify", "t")).toBe("/city?graph=graphify&token=t");
    expect(withViewerToken("/x?token=keep", "t")).toBe("/x?token=keep");
  });
});
