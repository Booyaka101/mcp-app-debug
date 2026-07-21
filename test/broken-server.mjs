/**
 * Broken MCP App server — reproduces the silent-failure modes mcp-app-debug
 * diagnoses. Each scenario should make specific checks FAIL.
 *
 * Usage: node test/broken-server.mjs <scenario> [port]
 *   ok         everything correct (hand-rolled app; all checks can pass)
 *   bad-uri    tool's _meta.ui.resourceUri points to a resource that 404s   → fails (a)
 *   bad-mime   resource served as text/html instead of the MCP App profile → fails (a)
 *   no-ready   HTML never speaks the App Bridge protocol                   → fails (c)(d)(e)
 *   slow-init  app waits 4s before ui/initialize (deadline 3s)             → fails (c)
 *   tool-error every tools/call returns isError:true                       → fails (e)
 *   csp-meta   HTML carries <meta CSP> with frame-ancestors 'none'         → fails (b)
 *   ext-img    HTML loads an external image not declared in _meta.ui.csp   → fails (b)
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const SCENARIOS = ["ok", "bad-uri", "bad-mime", "no-ready", "slow-init", "tool-error", "csp-meta", "ext-img"];
const scenario = process.argv[2] ?? "ok";
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" — one of: ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const port = Number(process.argv[3] ?? process.env.PORT ?? 3009);

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
  registerAppResource(server, actualUri, actualUri, { mimeType: mime }, async () => ({
    contents: [{ uri: actualUri, mimeType: mime, text: html }],
  }));

  return server;
}

http
  .createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
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
