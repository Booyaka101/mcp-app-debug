/**
 * fake-host — a minimal MCP Apps HOST used to exercise `mcp-app-debug host`.
 *
 * default      conformant: connects with the 2025-11-25 initialize handshake
 *              advertising io.modelcontextprotocol/ui in
 *              capabilities.extensions, calls `probe`, reads the ui://
 *              resource, mounts the HTML in a Playwright page through the SAME
 *              double-iframe sandbox files dist/web ships (sandbox.html +
 *              sandbox.js, CSP applied as an HTTP header built from
 *              _meta.ui.csp), answers ui/initialize, forwards tool-input +
 *              tool-result with _meta intact, and relays app tools/call.
 * --drop       the pydantic-ai#6613 shape: capabilities.extensions omitted and
 *              tool-result _meta stripped before it reaches the app.
 *              Everything else stays conformant.
 * --list-only  connects and lists tools but never calls `probe`.
 * --reject-init answers ui/initialize with a JSON-RPC error instead of a result.
 *              Everything else stays conformant, so it catches a fixture that
 *              grades "a reply arrived" rather than "the handshake succeeded".
 *
 * Usage: node test/fake-host.mjs <fixture-url> [--drop|--list-only|--reject-init]
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const drop = args.includes("--drop");
const listOnly = args.includes("--list-only");
const rejectInit = args.includes("--reject-init");
const url = args.find((a) => !a.startsWith("--"));
if (!url) {
  console.error("usage: node test/fake-host.mjs <fixture-url> [--drop|--list-only|--reject-init]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ 1. MCP client (Node side) */

const capabilities = drop
  ? {} // no extensions map at all — the pydantic-ai#6613 defect
  : { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
const client = new Client({ name: "fake-host", version: "0.5.0" }, { capabilities });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();

if (listOnly) {
  await sleep(1000);
  await client.close();
  console.error("fake-host: listed tools, never called probe (--list-only)");
  process.exit(0);
}

const probe = tools.find((t) => t._meta?.ui?.resourceUri);
if (!probe) {
  console.error("fake-host: no tool with _meta.ui.resourceUri on this server");
  process.exit(2);
}
const toolResult = await client.callTool({ name: probe.name, arguments: {} });
const read = await client.readResource({ uri: probe._meta.ui.resourceUri });
const content = read.contents[0] ?? {};
const uiMeta = content._meta?.ui ?? {};
if (drop) delete toolResult._meta; // the _map_mcp_tool_result defect

/* --------------------------------------- 2. sandbox + host page (two origins) */

// Mirror of src/csp.ts buildCspHeader (the official basic-host policy) — the
// dist bundle exposes no exports, so the test carries its own copy.
function buildCspHeader(csp) {
  const clean = (d) => (d ?? []).filter((x) => typeof x === "string" && !/[;\r\n'" ]/.test(x)).join(" ");
  const resourceDomains = clean(csp?.resourceDomains);
  const connectDomains = clean(csp?.connectDomains);
  const frameDomains = clean(csp?.frameDomains) || null;
  const baseUriDomains = clean(csp?.baseUriDomains) || null;
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ].join("; ");
}

const [sandboxHtml, sandboxJs] = await Promise.all([
  readFile(new URL("../dist/web/sandbox.html", import.meta.url), "utf-8"),
  readFile(new URL("../dist/web/sandbox.js", import.meta.url), "utf-8"),
]);

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

const cspHeader = buildCspHeader(uiMeta.csp);
const sandbox = await serve((req, res) => {
  if (req.url?.startsWith("/sandbox.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": cspHeader,
    });
    res.end(sandboxHtml);
  } else if (req.url?.startsWith("/sandbox.js")) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(sandboxJs);
  } else {
    res.writeHead(404).end();
  }
});

const cfg = {
  sandboxUrl: `${sandbox.origin}/sandbox.html`,
  html: content.text ?? "",
  csp: uiMeta.csp,
  permissions: uiMeta.permissions,
  toolResult,
  rejectInit,
};
const hostPageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>fake-host</title></head>
<body><script>
const CFG = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
iframe.style.cssText = "width:900px;height:600px;border:none;";
window.addEventListener("message", async (e) => {
  if (e.source !== iframe.contentWindow) return;
  const d = e.data;
  if (!d) return;
  const reply = (m) => iframe.contentWindow.postMessage(m, "*");
  if (d.method === "ui/notifications/sandbox-proxy-ready") {
    reply({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready",
      params: { html: CFG.html, csp: CFG.csp, permissions: CFG.permissions } });
    return;
  }
  if (d.jsonrpc !== "2.0") return;
  if (d.method === "ui/initialize" && d.id !== undefined) {
    if (CFG.rejectInit) {
      reply({ jsonrpc: "2.0", id: d.id, error: { code: -32603, message: "app rejected by this host" } });
      return;
    }
    reply({ jsonrpc: "2.0", id: d.id, result: {
      protocolVersion: d.params?.protocolVersion ?? "2026-01-26",
      hostInfo: { name: "fake-host", version: "0.5.0" },
      hostCapabilities: { serverTools: {} },
      hostContext: { theme: "light", platform: "web", displayMode: "inline", availableDisplayModes: ["inline"] },
    } });
    return;
  }
  if (d.method === "ui/notifications/initialized") {
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: CFG.toolResult });
    return;
  }
  if (d.method === "tools/call" && d.id !== undefined) {
    try {
      const result = await window.__relayToolCall(d.params);
      reply({ jsonrpc: "2.0", id: d.id, result });
    } catch (err) {
      reply({ jsonrpc: "2.0", id: d.id, error: { code: -32603, message: String(err) } });
    }
    return;
  }
  // size-changed, logging etc. — a minimal host ignores them
});
iframe.src = CFG.sandboxUrl;
document.body.appendChild(iframe);
</script></body></html>`;

const hostPage = await serve((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(hostPageHtml);
});

/* ----------------------------------------------------- 3. drive the browser */

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let reportRelayed;
const reportPromise = new Promise((r) => (reportRelayed = r));
await page.exposeBinding("__relayToolCall", async (_source, params) => {
  const result = await client.callTool(params);
  if (params?.name === "report") reportRelayed();
  return result;
});
await page.goto(`${hostPage.origin}/`);

await Promise.race([reportPromise, sleep(20_000)]);
await sleep(1000); // let the direct beacon land at the fixture too

await browser.close();
await client.close();
sandbox.server.close();
hostPage.server.close();
console.error(`fake-host: done (${drop ? "--drop" : "conformant"})`);
process.exit(0);
