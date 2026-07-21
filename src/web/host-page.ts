/**
 * Browser-side debug host page.
 *
 * Mounts the MCP App exactly like the official ext-apps basic-host does
 * (AppBridge + PostMessageTransport + double-iframe sandbox), and renders a
 * side panel showing every postMessage exchange in real time.
 *
 * The MCP server client lives in Node; this page reaches it through the
 * Playwright-exposed `__mcpProxy` binding (manual-handler AppBridge mode,
 * documented in the SDK).
 */
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { CheckResult, HarnessConfig, LogEntry } from "../types.js";
import { truncatePayload } from "../types.js";

declare global {
  interface Window {
    __mcpProxy: (op: string, params: unknown) => Promise<never>;
    __mcpLog: (entry: LogEntry) => void;
    __appendLog: (entry: LogEntry) => void;
    __setChecks: (checks: CheckResult[], done: boolean) => void;
  }
}

const epoch = Date.now();
const now = () => Date.now() - epoch;

/* ---------------------------------------------------------------- panel UI */

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
    font: 13px/1.45 "Segoe UI", system-ui, sans-serif; height: 100vh;
    display: flex; flex-direction: column; overflow: hidden; }
  header { padding: 10px 16px 8px; border-bottom: 1px solid #21262d;
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; color: #58a6ff; font-weight: 600; }
  header .meta { color: #8b949e; font-size: 12px; }
  header .meta b { color: #e6edf3; font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.trusted { background: #1f6feb33; color: #58a6ff; }
  .badge.strict { background: #f8514933; color: #f85149; }
  #checks { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #21262d;
    flex-wrap: wrap; }
  .chip { display: flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 12px; font-size: 12px; background: #161b22; border: 1px solid #30363d;
    cursor: default; }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: #d29922; }
  .chip.pass .dot { background: #3fb950; }
  .chip.fail .dot { background: #f85149; }
  .chip.pass { border-color: #3fb95055; }
  .chip.fail { border-color: #f8514955; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 460px; min-height: 0; }
  #appcard { padding: 16px; overflow: auto; display: flex; flex-direction: column; }
  #appcard .cardlabel { color: #8b949e; font-size: 11px; text-transform: uppercase;
    letter-spacing: .08em; margin-bottom: 8px; }
  #frameholder { background: #ffffff; border: 1px solid #30363d; border-radius: 8px;
    overflow: hidden; flex: 1; min-height: 320px; display: flex; }
  #frameholder iframe { border: none; width: 100%; flex: 1; background: #fff; }
  #appmsg { color: #f85149; padding: 12px; font-size: 13px; white-space: pre-wrap; }
  #logpanel { border-left: 1px solid #21262d; display: flex; flex-direction: column;
    min-height: 0; background: #0b0e13; }
  #logheader { padding: 8px 14px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .08em; color: #8b949e; border-bottom: 1px solid #21262d;
    display: flex; justify-content: space-between; }
  #logrows { flex: 1; overflow-y: auto; padding: 6px 0; font-family: Consolas, monospace;
    font-size: 11.5px; }
  .row { padding: 3px 14px; border-left: 3px solid transparent; word-break: break-all; }
  .row:hover { background: #161b22; }
  .row .ts { color: #6e7681; margin-right: 6px; }
  .row .arrow { font-weight: 700; margin-right: 6px; }
  .row .kind { color: #6e7681; font-size: 10px; margin-right: 6px; }
  .row .method { font-weight: 600; }
  .row .payload { color: #8b949e; }
  .row.host-app { border-left-color: #58a6ff; } .row.host-app .arrow,
  .row.host-app .method { color: #58a6ff; }
  .row.app-host { border-left-color: #3fb950; } .row.app-host .arrow,
  .row.app-host .method { color: #3fb950; }
  .row.server { border-left-color: #8b949e55; } .row.server .arrow,
  .row.server .method { color: #d2a8ff; }
  .row.event .method { color: #d29922; }
  .row.error { border-left-color: #f85149; } .row.error .arrow,
  .row.error .method, .row.error .payload { color: #f85149; }
`;

const CHECK_TITLES: Array<[string, string]> = [
  ["resource-uri", "ui:// resource"],
  ["csp", "CSP"],
  ["ui-initialize", "ui/initialize"],
  ["ui-ready", "ui/ready"],
  ["tool-call", "app tools/call"],
];

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildPanel(config: HarnessConfig): void {
  document.head.appendChild(el("style", {}, CSS.trim()) as HTMLStyleElement);
  document.title = `mcp-app-debug — ${config.toolName}`;

  const header = el("header");
  header.appendChild(el("h1", {}, "mcp-app-debug"));
  const meta = el("span", { class: "meta" });
  meta.innerHTML = `server <b></b> · tool <b></b>`;
  const bolds = meta.querySelectorAll("b");
  bolds[0].textContent = `${config.serverName} (${config.serverUrl})`;
  bolds[1].textContent = config.toolName;
  header.appendChild(meta);
  const badge = el("span", { class: `badge ${config.mode}` }, `mode: ${config.mode}`);
  if (config.modeNote) badge.title = config.modeNote;
  header.appendChild(badge);
  document.body.appendChild(header);

  const checks = el("div", { id: "checks" });
  for (const [id, label] of CHECK_TITLES) {
    const chip = el("div", { class: "chip", id: `chip-${id}`, title: "pending…" });
    chip.appendChild(el("span", { class: "dot" }));
    chip.appendChild(el("span", {}, label));
    checks.appendChild(chip);
  }
  document.body.appendChild(checks);

  const main = el("main");
  const card = el("section", { id: "appcard" });
  card.appendChild(el("div", { class: "cardlabel" }, "MCP App (sandboxed iframe)"));
  card.appendChild(el("div", { id: "frameholder" }));
  main.appendChild(card);

  const panel = el("aside", { id: "logpanel" });
  const logHeader = el("div", { id: "logheader" });
  logHeader.appendChild(el("span", {}, "Protocol log"));
  logHeader.appendChild(el("span", { id: "logcount" }, "0 messages"));
  panel.appendChild(logHeader);
  panel.appendChild(el("div", { id: "logrows" }));
  main.appendChild(panel);
  document.body.appendChild(main);
}

let rowCount = 0;
const DIR_CLASS: Record<string, string> = {
  "host→app": "host-app",
  "app→host": "app-host",
  server: "server",
  event: "event",
  error: "error",
};
const DIR_ARROW: Record<string, string> = {
  "host→app": "→",
  "app→host": "←",
  server: "◆",
  event: "•",
  error: "✖",
};

function appendRow(entry: LogEntry): void {
  const rows = document.getElementById("logrows");
  if (!rows) return;
  const row = el("div", { class: `row ${DIR_CLASS[entry.dir] ?? "event"}` });
  row.appendChild(el("span", { class: "ts" }, `+${String(Math.round(entry.ts)).padStart(5, " ")}ms`));
  row.appendChild(el("span", { class: "arrow" }, DIR_ARROW[entry.dir] ?? "•"));
  row.appendChild(el("span", { class: "kind" }, entry.kind));
  row.appendChild(el("span", { class: "method" }, entry.method ?? (entry.id !== undefined ? `⇦ id ${entry.id}` : "")));
  if (entry.payload) row.appendChild(el("span", { class: "payload" }, ` ${entry.payload}`));
  const nearBottom = rows.scrollTop + rows.clientHeight >= rows.scrollHeight - 40;
  rows.appendChild(row);
  rowCount++;
  while (rows.childElementCount > 600) rows.firstElementChild?.remove();
  if (nearBottom) rows.scrollTop = rows.scrollHeight;
  const count = document.getElementById("logcount");
  if (count) count.textContent = `${rowCount} messages`;
}

/** Append locally AND forward to the Node harness. */
function log(entry: LogEntry): void {
  appendRow(entry);
  try {
    window.__mcpLog(entry);
  } catch {
    // binding unavailable (page opened outside harness) — panel still works
  }
}

// Node pushes its own entries (console errors, network failures, notes) here.
window.__appendLog = (entry) => appendRow(entry);

window.__setChecks = (checks) => {
  for (const c of checks) {
    const chip = document.getElementById(`chip-${c.id}`);
    if (!chip) continue;
    chip.classList.toggle("pass", c.pass);
    chip.classList.toggle("fail", !c.pass);
    chip.title = c.detail;
  }
};

/* ------------------------------------------------------- logging transport */

function kindOf(message: JSONRPCMessage): string {
  const m = message as { method?: string; id?: unknown };
  if (m.method !== undefined) return m.id !== undefined ? "request" : "notif";
  return "response";
}

/**
 * Wraps PostMessageTransport so every JSON-RPC message in both directions is
 * logged with direction, timestamp, method and truncated payload, and
 * timeline markers for the checks are emitted.
 */
class LoggingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: unknown) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  private initId: unknown = null;

  constructor(private inner: PostMessageTransport) {}

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error: Error) => {
      log({ ts: now(), dir: "error", kind: "transport", method: "transport-error", payload: truncatePayload(error.message) });
      this.onerror?.(error);
    };
    this.inner.onmessage = (message: JSONRPCMessage, extra?: unknown) => {
      const m = message as { method?: string; id?: unknown; params?: unknown; result?: unknown; error?: unknown };
      const entry: LogEntry = {
        ts: now(),
        dir: "app→host",
        kind: kindOf(message),
        method: m.method,
        id: m.id as string | number | undefined,
        payload: truncatePayload(m.params ?? m.result ?? m.error ?? {}),
      };
      if (m.method === "ui/initialize") {
        this.initId = m.id;
        entry.marker = "ui-initialize";
      } else if (m.method === "ui/notifications/initialized") {
        entry.marker = "ui-ready";
      }
      log(entry);
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const m = message as { method?: string; id?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const entry: LogEntry = {
      ts: now(),
      dir: "host→app",
      kind: kindOf(message),
      method: m.method,
      id: m.id as string | number | undefined,
      payload: truncatePayload(m.params ?? m.result ?? m.error ?? {}),
    };
    if (m.method === "ui/notifications/sandbox-resource-ready") {
      entry.marker = "html-injected";
    } else if (m.method === undefined && this.initId !== null && m.id === this.initId) {
      entry.marker = "ui-initialize-response";
      entry.method = "(ui/initialize response)";
    }
    log(entry);
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/* ------------------------------------------------------------ main harness */

async function main(): Promise<void> {
  const config: HarnessConfig = await (await fetch("/config")).json();
  buildPanel(config);
  for (const entry of config.backlog ?? []) appendRow(entry);

  // Filter __mcpAppDebug messages (CSP violations etc. from the sandbox)
  // BEFORE the transport's listener sees them. Registered first + capture so
  // stopImmediatePropagation keeps them out of PostMessageTransport.
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      const d = event.data;
      if (!d || typeof d !== "object" || !("__mcpAppDebug" in d)) return;
      event.stopImmediatePropagation();
      const { __mcpAppDebug: name, ...data } = d as Record<string, unknown>;
      if (name === "csp-violation") {
        log({
          ts: now(), dir: "error", kind: "event", method: "csp-violation",
          payload: truncatePayload(data), marker: "csp-violation", data,
        });
      } else {
        log({ ts: now(), dir: "event", kind: "event", method: String(name), payload: truncatePayload(data) });
      }
    },
    true,
  );

  if (!config.resource.html) {
    const holder = document.getElementById("frameholder")!;
    holder.appendChild(
      el("div", { id: "appmsg" },
        `UI resource could not be loaded — nothing to render.\n${config.resource.error ?? ""}` +
        `\n\nThis is exactly what a client shows: nothing. See the checks above for why.`),
    );
    log({ ts: now(), dir: "error", kind: "event", method: "resource-missing", payload: config.resource.error });
    return;
  }

  // --- sandbox iframe (outer), served from a different origin
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  const allowAttr = buildAllowAttribute(config.resource.permissions as never);
  if (allowAttr) iframe.setAttribute("allow", allowAttr);

  const proxyReady = new Promise<void>((resolve) => {
    const listener = ({ source, data }: MessageEvent) => {
      if (source === iframe.contentWindow && data?.method === "ui/notifications/sandbox-proxy-ready") {
        window.removeEventListener("message", listener);
        log({ ts: now(), dir: "app→host", kind: "notif", method: "ui/notifications/sandbox-proxy-ready", payload: "{}" });
        resolve();
      }
    };
    window.addEventListener("message", listener);
  });

  iframe.src = config.sandboxUrl;
  document.getElementById("frameholder")!.appendChild(iframe);
  log({ ts: now(), dir: "event", kind: "event", method: "sandbox-loading", payload: config.sandboxUrl });
  await proxyReady;

  // --- AppBridge, capabilities per mode
  const capabilities =
    config.mode === "strict"
      ? {}
      : {
          openLinks: {},
          serverTools: (config.serverCapabilities?.tools as Record<string, boolean>) ?? {},
          serverResources: (config.serverCapabilities?.resources as Record<string, boolean>) ?? {},
          updateModelContext: { text: {} },
          message: { text: {} },
          logging: {},
        };

  const bridge = new AppBridge(
    null,
    { name: "mcp-app-debug", version: "0.1.0" },
    capabilities,
    {
      hostContext: {
        theme: "light",
        platform: "web",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { maxHeight: 4000 },
        locale: navigator.language,
      },
    },
  );

  if (config.mode === "trusted") {
    // Manual proxy handlers — the Node side holds the real MCP client.
    bridge.oncalltool = async (params) =>
      await window.__mcpProxy("tools/call", params);
    bridge.onlistresources = async (params) =>
      await window.__mcpProxy("resources/list", params ?? {});
    bridge.onreadresource = async (params) =>
      await window.__mcpProxy("resources/read", params);
    bridge.onlistresourcetemplates = async (params) =>
      await window.__mcpProxy("resources/templates/list", params ?? {});
    bridge.onlistprompts = async (params) =>
      await window.__mcpProxy("prompts/list", params ?? {});
    bridge.onmessage = async (params) => {
      log({ ts: now(), dir: "event", kind: "event", method: "ui/message accepted", payload: truncatePayload(params) });
      return {};
    };
    bridge.onopenlink = async (params) => {
      log({ ts: now(), dir: "event", kind: "event", method: "ui/open-link (not opened by debug host)", payload: truncatePayload(params) });
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      log({ ts: now(), dir: "event", kind: "event", method: "model-context updated", payload: truncatePayload(params) });
      return {};
    };
    bridge.onrequestdisplaymode = async (params) => ({ mode: params.mode });
  }
  // strict mode: no optional handlers registered, capabilities {} — app
  // requests beyond ping/ui/initialize get JSON-RPC errors, as with a
  // maximally restrictive host. The difference is visible in the
  // ui/initialize response's capabilities in the log.

  bridge.onsizechange = ({ height }) => {
    if (height !== undefined) iframe.style.height = `${Math.min(height, 4000)}px`;
  };
  bridge.onloggingmessage = (params) => {
    log({ ts: now(), dir: "event", kind: "event", method: `app-log/${params.level}`, payload: truncatePayload(params.data) });
  };

  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });

  const transport = new LoggingTransport(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  );
  await bridge.connect(transport);

  // Inject app HTML into the sandbox (CSP applied via HTTP header there).
  await bridge.sendSandboxResourceReady({
    html: config.resource.html,
    csp: config.resource.csp as never,
    permissions: config.resource.permissions as never,
  });

  await initialized;

  // Simulate the LLM host flow (what Claude does after the model calls the
  // tool): send input, execute on the server, send result.
  await bridge.sendToolInput({ arguments: config.toolArgs });
  try {
    const result = await window.__mcpProxy("tools/call:harness", {
      name: config.toolName,
      arguments: config.toolArgs,
    });
    await bridge.sendToolResult(result);
  } catch (e) {
    await bridge.sendToolCancelled({ reason: e instanceof Error ? e.message : String(e) });
  }
}

main().catch((e) => {
  log({ ts: now(), dir: "error", kind: "event", method: "harness-error", payload: truncatePayload(e instanceof Error ? e.stack ?? e.message : e) });
});
