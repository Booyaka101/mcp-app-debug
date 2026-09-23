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
 *   bare-names  the ext-apps#753 shape: the tool name is written into the
 *               bundle, so behind an aggregator the app calls a name no
 *               upstream owns            → check 11 FAILs under --aggregator
 *   resolved-names  the resolveToolName() pattern from ext-apps#753: the name
 *               comes from hostContext.toolInfo.tool.name in the ui/initialize
 *               result                   → check 11 PASSes with and without it
 *   listed-names  the other route ext-apps#745 calls correct: the app sends
 *               tools/list through the bridge and calls the name it finds
 *                                                       → check 11 PASSes
 *   namespaced  the tool is already called "alpha__forecast" upstream, so an
 *               aggregator must not prefix it twice     → check 11 PASSes
 *   csp-origins the resource declares _meta.ui.csp with one resourceDomains and
 *               one connectDomains origin, so check 12 has something to probe:
 *               PASS under spec, FAIL under claude-web (ext-apps#761)
 *   csp-wildcard  resourceDomains carries a wildcard, a duplicate and a bare
 *               host with no scheme — check 12 probes a synthetic subdomain,
 *               dedupes, and reports the schemeless entry as unprobeable
 *   csp-paths   one entry is a path prefix and one names an exact file — the
 *               prefix is probed under itself, the file is not probeable
 *   csp-self-asset  the app really loads an image from the one origin it
 *               declared, served by this fixture so nothing leaves the machine:
 *               allowed under spec, a genuine check-2 violation under
 *               claude-web, which check 12's own violations must not mask
 *   csp-unmatchable  the declared entry carries userinfo, so Chromium matches
 *               it against nothing — check 12 FAILs even under spec, where the
 *               host does apply the declaration, and blames the app
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

const SCENARIOS = [
  "weather", "first-only", "leak", "popup", "noargs", "singleton",
  "bare-names", "resolved-names", "listed-names", "namespaced", "csp-origins",
  "csp-wildcard", "csp-paths", "csp-self-asset", "csp-unmatchable",
];
const stdioMode = process.argv.includes("--stdio");
const argv = process.argv.slice(2).filter((a) => a !== "--stdio");
const scenario = argv[0] ?? "weather";
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" — one of: ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const port = Number(argv[1] ?? 3009);

// namespaced: the upstream name already carries the separator.
const TOOL_NAME = scenario === "namespaced" ? "alpha__forecast" : "forecast";

// The declaration each csp-* scenario ships. The origins are never contacted —
// the harness answers /__mcp-app-debug-probe itself — so example.com is safe.
const DECLARED_CSP = {
  "csp-self-asset": { resourceDomains: [`http://localhost:${port}`], connectDomains: [] },
  // a source expression's path is part of the match: the first is a prefix the
  // probe can go under, the second matches only that one file
  "csp-paths": {
    resourceDomains: ["https://cdn.example.com/assets/", "https://exact.example.com/logo.png"],
    connectDomains: [],
  },
  // a wildcard, the same origin twice, and a bare host CSP accepts but that is
  // not an origin anything can be requested from
  "csp-wildcard": {
    resourceDomains: [
      "https://*.example.com",
      "https://cdn.example.com",
      "https://cdn.example.com",
      "cdn.example.com",
    ],
    connectDomains: [],
  },
  // userinfo makes a source expression unmatchable: Chromium parses it, then it
  // matches nothing, not even its own origin. The sanitizer keeps it and the
  // planner can derive a URL from it, so only a real request finds the mistake.
  "csp-unmatchable": {
    resourceDomains: ["https://user@cdn.example.com"],
    connectDomains: [],
  },
  "csp-origins": {
    resourceDomains: ["https://cdn.example.com"],
    connectDomains: ["https://api.example.com"],
  },
}[scenario];

let calls = 0;
let resourceReads = 0;
const SEEDED_CITIES = new Set(["Tokyo", "Kyoto", "Osaka"]);

function appHtml({ leak = false, popup = false, resolve = false, list = false, asset = false } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><h3 style="font-family:sans-serif">profile-server app (${scenario})</h3>
${asset ? `<img src="http://localhost:${port}/asset.png" width="8" height="8" alt="">` : ""}
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
  ${resolve ? `
  // ext-apps#753's resolveToolName: whatever prefix the host applied to the
  // tool that instantiated this view is the prefix its own calls need.
  const resolveToolName = (baseName, hostContext) => {
    const invoked = hostContext && hostContext.toolInfo && hostContext.toolInfo.tool
      ? hostContext.toolInfo.tool.name : undefined;
    if (!invoked || invoked === baseName) return baseName;
    return invoked.endsWith(baseName)
      ? invoked.slice(0, invoked.length - baseName.length) + baseName
      : baseName;
  };` : ""}
  (async () => {
    const init = await request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "profile-app", version: "1.0.0" },
      appCapabilities: {},
    });
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    ${popup ? `window.open("https://example.com/", "_blank");` : ""}
    // ext-apps#753: writing the name into the bundle is the defect. Reading it
    // from hostContext, or from tools/list, is the fix. All three spellings
    // work on a direct connection, which is why the bug hides until a gateway.
    const toolName = ${
      resolve
        ? `resolveToolName(${JSON.stringify(TOOL_NAME)}, init && init.result ? init.result.hostContext : undefined)`
      : list
        ? `((await request("tools/list", {})).result?.tools?.[0]?.name ?? ${JSON.stringify(TOOL_NAME)})`
        : JSON.stringify(TOOL_NAME)};
    await request("tools/call", { name: toolName, arguments: { city: "Kyoto" } });
  })();
</script></body></html>`;
}

function buildServer() {
  const server = new McpServer(
    { name: `profile-server (${scenario})`, version: "1.0.0" },
    // registerAppTool/registerAppResource do not declare this; the server must
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } },
  );
  const uri = "ui://profile/app.html";

  registerAppTool(
    server,
    TOOL_NAME,
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

  const html = appHtml({
    leak: scenario === "leak",
    popup: scenario === "popup",
    resolve: scenario === "resolved-names",
    list: scenario === "listed-names",
    asset: scenario === "csp-self-asset",
  });
  registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    resourceReads++;
    // singleton: the view can be fetched once and never again, so a host
    // cannot mount a second instance of it.
    if (scenario === "singleton" && resourceReads > 1) {
      throw new Error("this ui:// resource is a singleton and has already been read");
    }
    return {
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          ...(scenario.startsWith("csp-") ? { _meta: { ui: { csp: DECLARED_CSP } } } : {}),
        },
      ],
    };
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

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function startHttp() {
http
  .createServer(async (req, res) => {
    // the one real asset the csp-self-asset app loads; local, so the suite
    // still sends nothing to the network
    if (req.url === "/asset.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG_1x1);
      return;
    }
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
