/**
 * Playwright browser harness: serves the host page + sandbox on two local
 * origins, proxies MCP traffic between the page's AppBridge and the Node MCP
 * client, collects the protocol log, and evaluates the 5 checks.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { buildReport, evaluateChecks } from "./checks.js";
import { buildCspHeader, scanMetaCspForFrameAncestors, type ResourceCsp } from "./csp.js";
import {
  connectToServer,
  fetchUiResource,
  findUiTools,
  getToolDefaults,
  targetLabel,
  type ConnectTarget,
  type ServerConnection,
} from "./mcp.js";
import type { CheckReport, CheckResult, HarnessConfig, HarnessState, LogEntry } from "./types.js";
import { truncatePayload } from "./types.js";

export interface HostOptions {
  connect: ConnectTarget;
  tool?: string;
  args?: string;
  mode: "trusted" | "strict";
  modeNote?: string;
  timeoutSec: number;
  fullWindow: boolean;
  json: boolean;
  headless: boolean;
  interact: boolean;
  click?: string;
  screenshot?: string;
  video?: string;
  logFile?: string;
}

const isTTY = process.stderr.isTTY ?? false;
const color = (code: number, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const DIR_FMT: Record<string, (s: string) => string> = {
  "host→app": (s) => color(34, s),
  "app→host": (s) => color(32, s),
  server: (s) => color(35, s),
  event: (s) => color(33, s),
  error: (s) => color(31, s),
};
const DIR_ARROW: Record<string, string> = {
  "host→app": "->", "app→host": "<-", server: "*", event: ".", error: "x",
};

function printEntry(entry: LogEntry): void {
  const fmt = DIR_FMT[entry.dir] ?? ((s: string) => s);
  const ts = `+${String(Math.round(entry.ts)).padStart(6, " ")}ms`;
  const head = `${DIR_ARROW[entry.dir] ?? "."} ${(entry.kind + "        ").slice(0, 9)}${entry.method ?? (entry.id !== undefined ? `(response id ${entry.id})` : "")}`;
  process.stderr.write(`  ${color(90, ts)} ${fmt(head)} ${color(90, entry.payload ?? "")}\n`);
}

/**
 * Launch Chromium; on the "browser not downloaded" first-run error, run
 * Playwright's own installer and retry once. Installer output goes to stderr
 * so --json stdout stays machine-parseable.
 */
async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Executable doesn't exist|playwright install/i.test(msg)) throw e;
    process.stderr.write(
      `\n${color(36, "Chromium is not installed yet — downloading it now (one-time, ~150 MB)…")}\n`,
    );
    const require = createRequire(import.meta.url);
    const cliPath = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    const exit = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.stdout!.on("data", (d) => process.stderr.write(d));
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (exit !== 0) throw new Error(`"playwright install chromium" exited with code ${exit}`);
    return await chromium.launch({ headless });
  }
}

async function serveOnLocalhost(
  handler: http.RequestListener,
): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

export async function runDebugHost(opts: HostOptions): Promise<number> {
  const state: HarnessState = {
    mode: opts.mode,
    resourceUriValid: false,
    resourceOk: false,
    cspViolations: [],
    appToolCalls: [],
    appToolCallAttempts: 0,
  };
  const serverLabel = targetLabel(opts.connect);
  // only HTTP targets have a URL for hosts to derive an app origin from
  state.serverEndpoint = opts.connect.kind === "http" ? opts.connect.url : undefined;
  // Every entry (both Node- and page-originated) for --log-file export.
  const allEntries: LogEntry[] = [];
  const emit = (entry: LogEntry) => {
    printEntry(entry);
    allEntries.push(entry);
  };
  // Server-phase entries emitted before the page exists, replayed in the panel.
  const backlog: LogEntry[] = [];
  const early = (entry: LogEntry) => {
    emit(entry);
    backlog.push(entry);
  };
  let nodeEpoch = Date.now();

  /* ---- 1. connect to the MCP server (Node side) */
  process.stderr.write(`\nmcp-app-debug — connecting to ${serverLabel}\n\n`);
  let conn: ServerConnection;
  try {
    conn = await connectToServer(opts.connect);
  } catch (e) {
    process.stderr.write(`${color(31, "x connection failed:")} ${e instanceof Error ? e.message : e}\n`);
    return 2;
  }
  early({
    ts: 0, dir: "server", kind: "event", method: "connected",
    payload: `${conn.serverName} via ${conn.transportKind}, ${conn.tools.length} tool(s)`,
  });

  /* ---- 2. pick the tool */
  const uiTools = findUiTools(conn.tools);
  let chosen = opts.tool
    ? uiTools.find((t) => t.tool.name === opts.tool)
    : uiTools[0];
  if (opts.tool && !chosen) {
    const plain = conn.tools.find((t) => t.name === opts.tool);
    if (!plain) {
      process.stderr.write(
        `${color(31, "x")} tool "${opts.tool}" not found. Server tools: ${conn.tools.map((t) => t.name).join(", ") || "(none)"}\n`,
      );
      return 2;
    }
    chosen = { tool: plain, resourceUri: undefined };
  }
  if (!chosen) {
    process.stderr.write(
      `${color(31, "x")} no tool on this server declares _meta.ui.resourceUri.\n` +
        `  Server tools: ${conn.tools.map((t) => t.name).join(", ") || "(none)"}\n` +
        `  This is itself the diagnosis: a client has no MCP App to render for this server.\n`,
    );
    return 1;
  }

  const tool = chosen.tool;
  state.resourceUri = chosen.resourceUri ?? (tool._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri;
  state.resourceUriValid = !!chosen.resourceUri;
  if (chosen.uriError) state.resourceError = chosen.uriError;
  early({
    ts: 0, dir: "server", kind: "event", method: "tool-selected",
    payload: `${tool.name} -> ${state.resourceUri ?? "(no ui resource)"}`,
  });

  /* ---- 3. fetch the ui:// resource */
  let html: string | null = null;
  let resourceCsp: ResourceCsp | undefined;
  let permissions: unknown;
  if (chosen.resourceUri) {
    const fetched = await fetchUiResource(conn, chosen.resourceUri);
    state.resourceOk = fetched.ok;
    state.resourceMime = fetched.mimeType;
    state.resourceBytes = fetched.bytes;
    state.resourceError = fetched.error;
    state.resourceCsp = fetched.csp;
    state.resourceDomain = fetched.domain;
    resourceCsp = fetched.csp as ResourceCsp | undefined;
    permissions = fetched.permissions;
    if (fetched.html !== undefined && fetched.ok) {
      html = fetched.html;
      state.metaCspIssue = scanMetaCspForFrameAncestors(html);
    }
    early({
      ts: 0, dir: "server", kind: "event", method: "resources/read",
      payload: fetched.ok
        ? `${fetched.mimeType}, ${fetched.bytes} bytes${fetched.csp ? `, csp=${truncatePayload(fetched.csp)}` : ""}`
        : `FAILED: ${fetched.error}`,
    });
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = opts.args ? JSON.parse(opts.args) : getToolDefaults(tool);
  } catch (e) {
    process.stderr.write(`${color(31, "x")} --args is not valid JSON: ${e}\n`);
    return 2;
  }

  /* ---- 4. local servers (host + sandbox on distinct origins) */
  const webDir = new URL("./web/", import.meta.url);
  const [hostPageHtml, hostPageJs, sandboxHtml, sandboxJs] = await Promise.all([
    readFile(new URL("host-page.html", webDir), "utf-8"),
    readFile(new URL("host-page.js", webDir), "utf-8"),
    readFile(new URL("sandbox.html", webDir), "utf-8"),
    readFile(new URL("sandbox.js", webDir), "utf-8"),
  ]);

  const cspHeader = buildCspHeader(resourceCsp);
  const sandbox = await serveOnLocalhost((req, res) => {
    if (req.url?.startsWith("/sandbox.html") || req.url === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": cspHeader,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(sandboxHtml);
    } else if (req.url?.startsWith("/sandbox.js")) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(sandboxJs);
    } else {
      res.writeHead(404).end();
    }
  });

  const config: HarnessConfig = {
    serverUrl: serverLabel,
    serverName: conn.serverName,
    toolName: tool.name,
    toolTitle: tool.title,
    toolArgs,
    mode: opts.mode,
    modeNote: opts.modeNote,
    sandboxUrl: `${sandbox.origin}/sandbox.html`,
    resource: {
      uri: state.resourceUri ?? "(none)",
      html,
      mimeType: state.resourceMime,
      csp: resourceCsp,
      permissions,
      error: state.resourceError,
    },
    serverCapabilities: conn.client.getServerCapabilities() as Record<string, unknown> | undefined,
    backlog,
  };

  const host = await serveOnLocalhost((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/index")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(hostPageHtml);
    } else if (req.url?.startsWith("/host-page.js")) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(hostPageJs);
    } else if (req.url?.startsWith("/config")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config));
    } else if (req.url?.startsWith("/favicon")) {
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });

  /* ---- 5. Playwright */
  let browser: Browser;
  try {
    browser = await launchChromium(opts.headless);
  } catch (e) {
    process.stderr.write(
      `${color(31, "x could not launch Chromium:")} ${e instanceof Error ? e.message : e}\n` +
        `  Try manually: ${color(36, "npx playwright install chromium")}\n`,
    );
    sandbox.server.close();
    host.server.close();
    return 2;
  }
  const viewport = { width: 1440, height: 900 };
  let videoTmpDir: string | undefined;
  let videoContext: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  let page: Page;
  if (opts.video) {
    videoTmpDir = await mkdtemp(path.join(tmpdir(), "mcp-app-debug-video-"));
    videoContext = await browser.newContext({
      viewport,
      recordVideo: { dir: videoTmpDir, size: viewport },
    });
    page = await videoContext.newPage();
  } else {
    page = await browser.newPage({ viewport });
  }

  let pageClosed = false;
  page.on("close", () => { pageClosed = true; });

  const pushToPanel = (entry: LogEntry) => {
    if (pageClosed) return;
    page
      .evaluate(
        (e) => (globalThis as { __appendLog?: (x: unknown) => void }).__appendLog?.(e),
        entry,
      )
      .catch(() => {});
  };
  const pushChecks = (done: boolean) => {
    if (pageClosed) return;
    const checks = evaluateChecks(state);
    page
      .evaluate(
        (arg: { cs: CheckResult[]; d: boolean }) =>
          (globalThis as { __setChecks?: (cs: unknown, d: boolean) => void }).__setChecks?.(
            arg.cs,
            arg.d,
          ),
        { cs: checks, d: done },
      )
      .catch(() => {});
  };
  const note = (method: string, payload?: string, dir: LogEntry["dir"] = "event") => {
    const entry: LogEntry = { ts: Date.now() - nodeEpoch, dir, kind: "event", method, payload };
    emit(entry);
    pushToPanel(entry);
  };

  let interactStarted = false;
  const maybeInteract = () => {
    if (interactStarted || !opts.interact) return;
    interactStarted = true;
    setTimeout(() => {
      autoInteract(page, sandbox.origin, opts.click, state, note).catch(() => {});
    }, 1500);
  };

  // page -> node: protocol log entries (also markers for checks)
  await page.exposeBinding("__mcpLog", (source, entry: LogEntry) => {
    if (source.frame !== page.mainFrame()) return;
    emit(entry);
    if (entry.dir === "app→host" && entry.kind === "request" && entry.method === "tools/call") {
      state.appToolCallAttempts++;
    }
    switch (entry.marker) {
      case "html-injected":
        state.htmlInjectedAt = entry.ts;
        break;
      case "ui-initialize":
        state.uiInitializeAt = entry.ts;
        break;
      case "ui-initialize-response":
        state.uiInitializeRespondedAt = entry.ts;
        break;
      case "ui-ready":
        state.uiReadyAt = entry.ts;
        maybeInteract();
        break;
      case "csp-violation":
        if (entry.data) state.cspViolations.push(entry.data);
        break;
    }
    if (entry.marker) pushChecks(false);
  });

  // page -> node: MCP proxy (manual AppBridge handlers call this)
  await page.exposeBinding("__mcpProxy", async (source, op: string, params: unknown) => {
    if (source.frame !== page.mainFrame()) {
      throw new Error("proxy calls allowed from host page only");
    }
    const p = (params ?? {}) as Record<string, unknown>;
    switch (op) {
      case "tools/call":
      case "tools/call:harness": {
        const fromApp = op === "tools/call";
        const name = String(p.name ?? "");
        const label = fromApp
          ? "tools/call (app-initiated) -> server"
          : "tools/call (harness LLM sim) -> server";
        note(label, truncatePayload(p), "server");
        try {
          const result = (await conn.client.callTool(
            p as { name: string; arguments?: Record<string, unknown> },
          )) as { isError?: boolean };
          const isError = result.isError === true;
          if (fromApp) state.appToolCalls.push({ name, isError, at: Date.now() });
          else state.harnessToolCall = { name, isError };
          note(`server result (${isError ? "isError" : "ok"})`, truncatePayload(result), "server");
          pushChecks(false);
          return result;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (fromApp) state.appToolCalls.push({ name, isError: true, at: Date.now() });
          else state.harnessToolCall = { name, isError: true };
          note("server tools/call threw", msg, "error");
          pushChecks(false);
          return { content: [{ type: "text", text: `tools/call failed: ${msg}` }], isError: true };
        }
      }
      case "resources/list":
        return await conn.client.listResources(p);
      case "resources/read":
        return await conn.client.readResource(p as { uri: string });
      case "resources/templates/list":
        return await conn.client.listResourceTemplates(p);
      case "prompts/list":
        return await conn.client.listPrompts(p);
      default:
        throw new Error(`unknown proxy op: ${op}`);
    }
  });

  // Browser-side failures — often the ONLY evidence for silent render bugs.
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      const entry: LogEntry = {
        ts: Date.now() - nodeEpoch, dir: type === "error" ? "error" : "event", kind: "console",
        method: `console.${type}`, payload: truncatePayload(msg.text()),
      };
      emit(entry);
      pushToPanel(entry);
    }
  });
  page.on("pageerror", (err) => {
    const entry: LogEntry = {
      ts: Date.now() - nodeEpoch, dir: "error", kind: "jserror", method: "pageerror",
      payload: truncatePayload(err.message),
    };
    emit(entry);
    pushToPanel(entry);
  });
  page.on("requestfailed", (req) => {
    if (req.url().includes("favicon")) return;
    const entry: LogEntry = {
      ts: Date.now() - nodeEpoch, dir: "error", kind: "network", method: "request-failed",
      payload: truncatePayload(`${req.url()} — ${req.failure()?.errorText}`),
    };
    emit(entry);
    pushToPanel(entry);
  });

  nodeEpoch = Date.now();
  await page.goto(`${host.origin}/`);

  /* ---- 6. observation window, then verdict.
     Ends early when all checks have passed and stayed passed for a 2 s quiet
     period (late CSP violations can still flip a check), when the user closes
     the window, or at the full window — whichever comes first. */
  const EARLY_EXIT_QUIET_MS = 2000;
  await new Promise<void>((resolve) => {
    let allPassSince: number | undefined;
    const poll = setInterval(() => {
      if (pageClosed) return finish();
      if (opts.fullWindow) return;
      if (evaluateChecks(state).every((c) => c.pass)) {
        allPassSince ??= Date.now();
        if (Date.now() - allPassSince >= EARLY_EXIT_QUIET_MS) {
          note("all checks passed — ending observation early (--full-window to wait the full window)");
          finish();
        }
      } else {
        allPassSince = undefined;
      }
    }, 250);
    const timer = setTimeout(() => finish(), opts.timeoutSec * 1000);
    const finish = () => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    };
  });

  const report = buildReport(state, {
    server: serverLabel,
    tool: tool.name,
    mode: opts.mode + (opts.modeNote ? ` (${opts.modeNote})` : ""),
  });
  pushChecks(true);

  if (opts.screenshot && !pageClosed) {
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: opts.screenshot }).catch((e) => {
      process.stderr.write(`screenshot failed: ${e}\n`);
    });
    process.stderr.write(`screenshot saved: ${opts.screenshot}\n`);
  }

  printHumanReport(report, opts.json);

  if (!opts.json && !opts.headless && !pageClosed) {
    process.stderr.write(
      `\n${color(36, "Browser window stays open for interactive debugging — close it (or Ctrl+C) to exit.")}\n`,
    );
    await Promise.race([
      page.waitForEvent("close", { timeout: 0 }).catch(() => {}),
      new Promise<void>((resolve) => process.once("SIGINT", () => resolve())),
    ]);
  }

  // Video finalizes when the context closes; saveAs needs the browser alive.
  if (opts.video && videoContext) {
    const video = page.video();
    await videoContext.close().catch(() => {});
    if (video) {
      try {
        await video.saveAs(opts.video);
        process.stderr.write(`video saved: ${opts.video}\n`);
      } catch (e) {
        process.stderr.write(`video save failed: ${e}\n`);
      }
    }
  }
  await browser.close().catch(() => {});
  if (videoTmpDir) await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});

  if (opts.logFile) {
    try {
      const lines = [...allEntries.map((e) => JSON.stringify(e)), JSON.stringify(report)];
      await writeFile(opts.logFile, lines.join("\n") + "\n", "utf-8");
      process.stderr.write(`protocol log saved: ${opts.logFile} (${allEntries.length} entries)\n`);
    } catch (e) {
      process.stderr.write(`log file write failed: ${e}\n`);
    }
  }

  sandbox.server.close();
  host.server.close();
  await conn.client.close().catch(() => {});

  return report.failed > 0 ? 1 : 0;
}

async function autoInteract(
  page: Page,
  sandboxOrigin: string,
  clickText: string | undefined,
  state: HarnessState,
  note: (method: string, payload?: string, dir?: LogEntry["dir"]) => void,
): Promise<void> {
  const sandboxFrame = page.frames().find((f) => f.url().startsWith(sandboxOrigin));
  const appFrame: Frame | undefined = sandboxFrame?.childFrames()[0];
  if (!appFrame) {
    state.interactNote = "auto-interact: app frame not found";
    note("auto-interact", state.interactNote);
    return;
  }
  const target = clickText
    ? appFrame.getByRole("button", { name: clickText }).or(appFrame.getByText(clickText)).first()
    : appFrame.locator("button").first();
  try {
    await target.click({ timeout: 4000 });
    const label = clickText ?? (await target.textContent().catch(() => null)) ?? "(first button)";
    note("auto-interact", `clicked ${JSON.stringify(label.trim())} in the app to provoke app-initiated activity`);
  } catch {
    state.interactNote = clickText
      ? `auto-interact could not click "${clickText}"`
      : "auto-interact found no clickable button in the app";
    note("auto-interact", state.interactNote);
  }
}

function printHumanReport(report: CheckReport, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  const mark = (p: boolean) => (p ? color(32, "PASS") : color(31, "FAIL"));
  process.stderr.write("\n");
  process.stdout.write(
    `Results — server ${report.server}, tool ${report.tool}, mode ${report.mode}\n`,
  );
  for (const c of report.checks) {
    process.stdout.write(`  ${mark(c.pass)}  ${c.title.padEnd(30)} ${c.detail}\n`);
  }
  process.stdout.write(
    `  ${report.passed}/${report.checks.length} checks passed` +
      (report.failed ? ` — ${color(31, `${report.failed} FAILED`)}` : ` ${color(32, "OK")}`) +
      "\n",
  );
}
