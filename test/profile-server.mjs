/**
 * Fixtures for the --profile checks (8-10). Legacy-revision MCP App server.
 *
 * Usage: node test/profile-server.mjs <scenario> [port]
 *   weather     argument-sensitive tool ({city}); every call returns a fresh
 *               result — checks 8-10 all exercisable, nothing broken
 *   first-only  same tool, but only the seeded cities return a usable result —
 *               the redelivery probe's varied argument errors, so the app only
 *               ever gets a usable tool-result from its first call → check 8 fails
 *               (argument-based rather than a call counter so the app's own
 *               auto-call and instance #2's call cannot race the outcome)
 *   leak        view broadcasts its tool-result to sibling instances via a
 *               shared localStorage key + storage events, and echoes what it
 *               hears back to its host                        → check 9 fails
 *   popup       view calls window.open on load; tool is argument-sensitive
 *               (exercises check 10's outcomes per profile)
 *   noargs      tool takes no arguments at all      → check 8 SKIPs honestly
 *   singleton   the ui:// resource can only be read ONCE; the second
 *               resources/read errors                → check 9 SKIPs honestly
 *
 * Add --stdio to serve over stdio instead of HTTP (port ignored).
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const SCENARIOS = ["weather", "first-only", "leak", "popup", "noargs", "singleton"];
const stdioMode = process.argv.includes("--stdio");
const argv = process.argv.slice(2).filter((a) => a !== "--stdio");
const scenario = argv[0] ?? "weather";
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" — one of: ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const port = Number(argv[1] ?? 3009);

let calls = 0;
let resourceReads = 0;
const SEEDED_CITIES = new Set(["Tokyo", "Kyoto", "Osaka"]);

function appHtml({ leak = false, popup = false } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><h3 style="font-family:sans-serif">profile-server app (${scenario})</h3>
<div id="out"></div>
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
    if (d.method === "ui/notifications/tool-result") {
      document.getElementById("out").textContent = JSON.stringify(d.params).slice(0, 200);
      ${leak ? `try { localStorage.setItem("mcp-leak", JSON.stringify(d.params) + ":" + Math.random()); } catch {}` : ""}
    }
  });
  ${leak ? `
  // Same-origin sibling instances hear this storage event and echo the other
  // instance's tool-result back to their own host bridge — the leakage the
  // multi-instance check exists to catch.
  window.addEventListener("storage", (e) => {
    if (e.key === "mcp-leak" && e.newValue) {
      post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 400, leaked: JSON.parse(e.newValue.slice(0, e.newValue.lastIndexOf(":"))) } });
    }
  });` : ""}
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    post({ jsonrpc: "2.0", id, method, params });
  });
  (async () => {
    await request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "profile-app", version: "1.0.0" },
      appCapabilities: {},
    });
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    ${popup ? `window.open("https://example.com/", "_blank");` : ""}
    await request("tools/call", { name: "forecast", arguments: { city: "Kyoto" } });
  })();
</script></body></html>`;
}

function buildServer() {
  const server = new McpServer({ name: `profile-server (${scenario})`, version: "1.0.0" });
  const uri = "ui://profile/app.html";

  registerAppTool(
    server,
    "forecast",
    {
      title: "Forecast",
      description: "Returns a forecast for a city.",
      // noargs: nothing to vary between calls, so check 8 must SKIP rather
      // than invent a failure.
      inputSchema: scenario === "noargs" ? {} : { city: z.string().default("Tokyo") },
      _meta: { ui: { resourceUri: uri } },
    },
    async ({ city = "Tokyo" } = {}) => {
      calls++;
      if (scenario === "first-only" && !SEEDED_CITIES.has(city)) {
        return {
          content: [{ type: "text", text: `no update available for ${city}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `sunny in ${city} (call #${calls})` }],
        structuredContent: { city, sky: "sunny", call: calls },
        isError: false,
      };
    },
  );

  const html = appHtml({ leak: scenario === "leak", popup: scenario === "popup" });
  registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    resourceReads++;
    // singleton: the view can be fetched once and never again, so a host
    // cannot mount a second instance of it.
    if (scenario === "singleton" && resourceReads > 1) {
      throw new Error("this ui:// resource is a singleton and has already been read");
    }
    return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  });
  return server;
}

if (stdioMode) {
  // stdout is the transport in this mode — anything human goes to stderr.
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`profile-server [${scenario}] serving on stdio`);
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
    console.log(`profile-server [${scenario}] listening on http://localhost:${port}/mcp`);
  });
}
