/**
 * Broken MCP App server — reproduces the silent-failure modes mcp-app-debug
 * diagnoses. Each scenario should make specific checks FAIL.
 *
 * Usage: node test/broken-server.mjs <scenario> [port] [--stdio] [--stateless]
 *   --stdio    serve over stdio instead of HTTP (port ignored)
 *   --stateless serve the 2026-07-28 stateless revision: hand-rolled JSON-RPC
 *              implementing server/discover, REJECTING initialize, stamping
 *              resultType/ttlMs/cacheScope, and requiring the Mcp-Method
 *              header on HTTP POSTs (the SDKs are v1-only, so this mode is
 *              hand-rolled by design)
 *   ok         everything correct (hand-rolled app; all checks can pass)
 *   bad-uri    tool's _meta.ui.resourceUri points to a resource that 404s   → fails (a)
 *   bad-mime   resource served as text/html instead of the MCP App profile → fails (a)
 *   no-ready   HTML never speaks the App Bridge protocol                   → fails (c)(d)(e)
 *   slow-init  app waits 4s before ui/initialize (deadline 3s)             → fails (c)
 *   tool-error every tools/call returns isError:true                       → fails (e)
 *   csp-meta   HTML carries <meta CSP> with frame-ancestors 'none'         → fails (b)
 *   ext-img    HTML loads an external image not declared in _meta.ui.csp   → fails (b)
 *   bad-domain _meta.ui.domain is a hash of the endpoint + a trailing slash → fails (c)
 * Stateless-only scenarios:
 *   discover-missing  speaks stateless 2026-07-28 but server/discover -32601s
 *                     (half-migrated server; violates a MUST)      → fails (g)
 *   no-ui-extension   discover result omits io.modelcontextprotocol/ui from
 *                     capabilities.extensions                      → (g) passes with a warning detail
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const SCENARIOS = ["ok", "bad-uri", "bad-mime", "no-ready", "slow-init", "tool-error", "csp-meta", "ext-img", "bad-domain"];
const STATELESS_SCENARIOS = ["ok", "bad-uri", "no-ready", "tool-error", "discover-missing", "no-ui-extension"];
const stdioMode = process.argv.includes("--stdio");
const statelessMode = process.argv.includes("--stateless");
const argv = process.argv.slice(2).filter((a) => a !== "--stdio" && a !== "--stateless");
const scenario = argv[0] ?? "ok";
const validScenarios = statelessMode ? STATELESS_SCENARIOS : SCENARIOS;
if (!validScenarios.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" — one of: ${validScenarios.join(", ")}`);
  process.exit(2);
}
const port = Number(argv[1] ?? process.env.PORT ?? 3009);

/** Same derivation hosts use for the app sandbox origin. */
function claudeDomain(url) {
  return `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

/** Minimal hand-rolled MCP App (no SDK): handshake + optional auto tools/call. */
function appHtml({ delayMs = 0, autoCallTool = null, head = "", body = "" } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8">${head}</head>
<body><h3 style="font-family:sans-serif">broken-server app (${scenario})</h3>${body}
<script>
  const post = (m) => window.parent.postMessage(m, "*");
  let nextId = 1;
  const pending = new Map();
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.id !== undefined && (d.result || d.error) && pending.has(d.id)) {
      pending.get(d.id)(d); pending.delete(d.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    post({ jsonrpc: "2.0", id, method, params });
  });
  setTimeout(async () => {
    await request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "broken-app", version: "1.0.0" },
      appCapabilities: {},
    });
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    ${autoCallTool ? `await request("tools/call", { name: ${JSON.stringify(autoCallTool)}, arguments: {} });` : ""}
  }, ${delayMs});
</script></body></html>`;
}

function buildServer() {
  const server = new McpServer({ name: `broken-server (${scenario})`, version: "1.0.0" });
  const declaredUri = "ui://broken/app.html";
  const actualUri = scenario === "bad-uri" ? "ui://broken/elsewhere.html" : declaredUri;

  const toolIsError = scenario === "tool-error";
  registerAppTool(
    server,
    "poke",
    {
      title: "Poke",
      description: "Returns a poke (or an error, in tool-error scenario).",
      inputSchema: {},
      _meta: { ui: { resourceUri: declaredUri } },
    },
    async () => ({
      content: [{ type: "text", text: toolIsError ? "boom" : "poke!" }],
      isError: toolIsError,
    }),
  );

  let html;
  switch (scenario) {
    case "no-ready":
      html = `<!doctype html><html><body><h3>I render but never speak the protocol</h3></body></html>`;
      break;
    case "slow-init":
      html = appHtml({ delayMs: 4000 });
      break;
    case "tool-error":
      html = appHtml({ autoCallTool: "poke" });
      break;
    case "csp-meta":
      html = appHtml({
        autoCallTool: "poke",
        head: `<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">`,
      });
      break;
    case "ext-img":
      html = appHtml({
        autoCallTool: "poke",
        body: `<img src="https://example.com/undeclared.png" alt="external">`,
      });
      break;
    default:
      html = appHtml({ autoCallTool: "poke" });
  }

  const mime = scenario === "bad-mime" ? "text/html" : RESOURCE_MIME_TYPE;
  // The realistic way to get this wrong: hash a URL that differs from the one
  // the connector was added with — here, the same endpoint plus a trailing slash.
  const uiMeta =
    scenario === "bad-domain"
      ? { ui: { domain: claudeDomain(`http://localhost:${port}/mcp/`) } }
      : undefined;
  registerAppResource(server, actualUri, actualUri, { mimeType: mime }, async () => ({
    contents: [{ uri: actualUri, mimeType: mime, text: html, ...(uiMeta ? { _meta: uiMeta } : {}) }],
  }));

  return server;
}

/* ------------------------------------------------ stateless (2026-07-28) */

/** App HTML for the stateless scenarios (same selection as buildServer). */
function statelessHtml() {
  if (scenario === "no-ready") {
    return `<!doctype html><html><body><h3>I render but never speak the protocol</h3></body></html>`;
  }
  return appHtml({ autoCallTool: "poke" });
}

/**
 * Hand-rolled 2026-07-28 request handler (one JSON-RPC message in, one
 * response out; null for notifications). Stateless: no initialize, every
 * result stamped with resultType, cacheable results carry ttlMs/cacheScope.
 */
function makeStatelessHandler() {
  const declaredUri = "ui://broken/app.html";
  const actualUri = scenario === "bad-uri" ? "ui://broken/elsewhere.html" : declaredUri;
  const toolIsError = scenario === "tool-error";
  const html = statelessHtml();
  const serverMeta = {
    "io.modelcontextprotocol/serverInfo": {
      name: `broken-server (${scenario}, stateless)`,
      version: "1.0.0",
    },
  };
  const cacheable = { ttlMs: 60_000, cacheScope: "public" };

  return (msg) => {
    const { id, method, params } = msg ?? {};
    if (id === undefined) return null; // notification — nothing to say back
    const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const ok = (result) => ({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", _meta: serverMeta, ...result },
    });
    switch (method) {
      case "initialize":
        return err(-32601, "Method not found: initialize (stateless 2026-07-28 server — use server/discover)");
      case "server/discover":
        if (scenario === "discover-missing") return err(-32601, "Method not found");
        return ok({
          supportedVersions: ["2026-07-28"],
          capabilities: {
            tools: {},
            resources: {},
            extensions:
              scenario === "no-ui-extension" ? {} : { "io.modelcontextprotocol/ui": {} },
          },
          ttlMs: 3_600_000,
          cacheScope: "public",
        });
      case "tools/list":
        return ok({
          tools: [
            {
              name: "poke",
              title: "Poke",
              description: "Returns a poke (or an error, in tool-error scenario).",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { resourceUri: declaredUri } },
            },
          ],
          ...cacheable,
        });
      case "resources/list":
        return ok({
          resources: [{ uri: actualUri, name: actualUri, mimeType: RESOURCE_MIME_TYPE }],
          ...cacheable,
        });
      case "resources/read":
        if (params?.uri !== actualUri) {
          return err(-32602, `Resource not found: ${params?.uri}`);
        }
        return ok({
          contents: [{ uri: actualUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
          ...cacheable,
        });
      case "resources/templates/list":
        return ok({ resourceTemplates: [], ...cacheable });
      case "prompts/list":
        return ok({ prompts: [], ...cacheable });
      case "tools/call":
        if (params?.name !== "poke") return err(-32602, `Unknown tool: ${params?.name}`);
        return ok({
          content: [{ type: "text", text: toolIsError ? "boom" : "poke!" }],
          isError: toolIsError,
        });
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  };
}

function startStatelessHttp() {
  const handle = makeStatelessHandler();
  http
    .createServer(async (req, res) => {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      const token = process.env.AUTH_TOKEN;
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // 2026-07-28 removed the HTTP GET endpoint (replaced by subscriptions/listen)
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let json;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400).end();
        return;
      }
      // 2026-07-28 requires the Mcp-Method header on every POSTed request
      if (json?.method && json.id !== undefined && req.headers["mcp-method"] !== json.method) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: json.id,
            error: {
              code: -32020,
              message: `HeaderMismatch: Mcp-Method header ${JSON.stringify(req.headers["mcp-method"] ?? null)} does not match request method "${json.method}"`,
            },
          }),
        );
        return;
      }
      const response = handle(json);
      if (!response) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    })
    .listen(port, () => {
      console.log(`broken-server [${scenario}] (stateless 2026-07-28) listening on http://localhost:${port}/mcp`);
    });
}

function startStatelessStdio() {
  const handle = makeStatelessHandler();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const response = handle(json);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
  console.error(`broken-server [${scenario}] (stateless 2026-07-28) serving on stdio`);
}

if (statelessMode) {
  if (stdioMode) startStatelessStdio();
  else startStatelessHttp();
} else if (stdioMode) {
  // stdout is the MCP transport in this mode — anything human goes to stderr.
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`broken-server [${scenario}] serving on stdio`);
} else {
  startHttp();
}

function startHttp() {
http
  .createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    // AUTH_TOKEN=x makes the server demand "Authorization: Bearer x" —
    // exercises the CLI's --header option.
    const token = process.env.AUTH_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let json;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, json);
    } catch (e) {
      console.error("MCP error:", e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })
  .listen(port, () => {
    console.log(`broken-server [${scenario}] listening on http://localhost:${port}/mcp`);
  });
}
