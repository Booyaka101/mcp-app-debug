/**
 * Host-conformance mode (`mcp-app-debug host`): mcp-app-debug becomes a
 * conformant MCP Apps SERVER and grades whoever connects.
 *
 * The fixture speaks BOTH revisions this product supports — the 2025-11-25
 * `initialize` handshake and the stateless 2026-07-28 `server/discover` path —
 * and advertises `io.modelcontextprotocol/ui` in `capabilities.extensions` on
 * both. It exposes one model-visible tool (`probe`, whose result carries
 * `structuredContent` plus a planted `_meta.ui.probeToken`), one app-only tool
 * (`report`, the beacon channel), and one `ui://` resource (the probe app).
 * The JSON-RPC layer is hand-rolled, mirroring test/broken-server.mjs
 * --stateless (validated against the real v2 client): full control over the
 * wire is the point — every request is an observation.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import PROBE_HTML_TEMPLATE from "./app/probe.html";
import { buildHostReport, evaluateHostChecks, PROBE_RESOURCE_URI, UI_EXTENSION } from "./host-checks.js";
import type { HostCheckResult, HostObservations, ProbeBeacon } from "./types.js";
import { summarizeRpcError, truncatePayload } from "./types.js";

export interface HostModeOptions {
  port: number;
  stdio: boolean;
  windowSec: number;
  json: boolean;
}

const RESOURCE_MIME = "text/html;profile=mcp-app";
const REVISION_STATELESS = "2026-07-28";
const REVISION_LEGACY = "2025-11-25";

const isTTY = process.stderr.isTTY ?? false;
const color = (code: number, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const VERDICT_FMT: Record<HostCheckResult["verdict"], string> = {
  pass: color(32, "PASS"),
  fail: color(31, "FAIL"),
  inconclusive: color(33, "INCN"),
};

/** Same sandbox-origin derivation the scan-mode ui-domain check verifies. */
function claudeDomain(url: string): string {
  return `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
};

interface Fixture {
  obs: HostObservations;
  epoch: number;
  html: string;
  uiResourceMeta: Record<string, unknown>;
  onEvent: () => void;
  log: (line: string) => void;
}

function now(fx: Fixture): number {
  return Date.now() - fx.epoch;
}

/**
 * A host may send MCP-Protocol-Version as a header while its initialize body
 * asks for a different revision (Claude does). A server that reads only one of
 * the two draws the wrong conclusion about what was negotiated, so say it out
 * loud once both are known. Reported by itsjet26 in ext-apps#671.
 */
function noteProtocolVersionSplit(fx: Fixture): void {
  const { headerProtocolVersion: header, initProtocolVersion: body } = fx.obs;
  if (!header || !body || header === body || fx.obs.protocolSplitLogged) return;
  fx.obs.protocolSplitLogged = true;
  fx.log(
    `note    MCP-Protocol-Version header says ${header} but the initialize body asks for ${body} ` +
      "— read both before concluding which revision was negotiated",
  );
}

/** The beacon is an untrusted POST body, so the error is shape-checked here. */
function readRpcError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as { code?: unknown; message?: unknown };
  return summarizeRpcError(
    typeof e.code === "number" ? e.code : undefined,
    typeof e.message === "string" ? e.message : undefined,
  );
}

function recordBeacon(fx: Fixture, via: ProbeBeacon["via"], raw: unknown): void {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const beacon: ProbeBeacon = {
    via,
    at: now(fx),
    phase: p.phase === "mounted" || p.phase === "final" ? p.phase : undefined,
    origin: typeof p.origin === "string" ? p.origin : undefined,
    referrer: typeof p.referrer === "string" ? p.referrer : undefined,
    topAccessible: typeof p.topAccessible === "boolean" ? p.topAccessible : undefined,
    uiInitializeAnswered:
      typeof p.uiInitializeAnswered === "boolean" ? p.uiInitializeAnswered : undefined,
    uiInitializeLatencyMs:
      typeof p.uiInitializeLatencyMs === "number" ? p.uiInitializeLatencyMs : undefined,
    uiInitializeError: readRpcError(p.uiInitializeError),
    hostInfo: p.hostInfo,
    sawToolInput: typeof p.sawToolInput === "boolean" ? p.sawToolInput : undefined,
    sawToolResult: typeof p.sawToolResult === "boolean" ? p.sawToolResult : undefined,
    toolResultHadStructuredContent:
      typeof p.toolResultHadStructuredContent === "boolean"
        ? p.toolResultHadStructuredContent
        : undefined,
    probeToken: typeof p.probeToken === "string" ? p.probeToken : null,
    toolResultMetaKeys: Array.isArray(p.toolResultMetaKeys)
      ? p.toolResultMetaKeys.filter((k): k is string => typeof k === "string")
      : undefined,
    cspViolations: Array.isArray(p.cspViolations)
      ? p.cspViolations.filter((v): v is { violatedDirective?: string; blockedURI?: string } =>
          Boolean(v && typeof v === "object"),
        )
      : undefined,
  };
  fx.obs.beacons.push(beacon);
  fx.log(
    `beacon (${via}, ${beacon.phase ?? "?"}) origin=${beacon.origin ?? "?"} ` +
      `topAccessible=${beacon.topAccessible ?? "?"}` +
      (beacon.phase === "final"
        ? ` initializeAnswered=${beacon.uiInitializeAnswered} sawToolResult=${beacon.sawToolResult} probeToken=${beacon.probeToken ? "present" : "MISSING"}`
        : ""),
  );
  fx.onEvent();
}

/**
 * One JSON-RPC message in, one response (or null for notifications) out.
 * Requests carrying the 2026-07-28 `_meta` envelope get modern-shaped results
 * (resultType + ttlMs/cacheScope); everything else gets plain 2025-11-25
 * results.
 */
function handleMessage(fx: Fixture, msg: JsonRpcMessage): Record<string, unknown> | null {
  const response = handleMessageInner(fx, msg);
  fx.onEvent(); // every message is an observation — chips may have resolved
  return response;
}

function handleMessageInner(fx: Fixture, msg: JsonRpcMessage): Record<string, unknown> | null {
  const { id, method, params } = msg ?? {};
  if (typeof method !== "string") return null;
  const obs = fx.obs;
  obs.firstContactAt ??= now(fx);

  const meta = params?._meta;
  const envelopeCaps = meta?.["io.modelcontextprotocol/clientCapabilities"];
  if (envelopeCaps && typeof envelopeCaps === "object") {
    obs.envelopeCapabilities ??= envelopeCaps as Record<string, unknown>;
  }
  const envelopeInfo = meta?.["io.modelcontextprotocol/clientInfo"];
  if (envelopeInfo && typeof envelopeInfo === "object") {
    obs.clientInfo ??= envelopeInfo as { name?: string; version?: string };
  }
  const modern = meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined;

  fx.log(
    `${id !== undefined ? "request " : "notif   "}${method} ${truncatePayload(params ?? {})}`,
  );

  if (id === undefined) return null; // notification — nothing to say back

  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const serverMeta = {
    "io.modelcontextprotocol/serverInfo": { name: "mcp-app-debug fixture", version: __APP_VERSION__ },
  };
  const cacheable = { ttlMs: 60_000, cacheScope: "public" };
  const ok = (result: Record<string, unknown>, cache = false) => ({
    jsonrpc: "2.0",
    id,
    result: modern
      ? { resultType: "complete", _meta: serverMeta, ...(cache ? cacheable : {}), ...result }
      : result,
  });
  const capabilities = {
    tools: {},
    resources: {},
    extensions: { [UI_EXTENSION]: {} },
  };

  switch (method) {
    case "initialize": {
      obs.initCapabilities ??=
        params?.capabilities && typeof params.capabilities === "object"
          ? (params.capabilities as Record<string, unknown>)
          : {};
      const info = params?.clientInfo;
      if (info && typeof info === "object") obs.clientInfo ??= info as { name?: string };
      if (typeof params?.protocolVersion === "string") {
        obs.initProtocolVersion ??= params.protocolVersion;
        noteProtocolVersionSplit(fx);
      }
      return ok({
        // Echo the client's requested version — the fixture accommodates,
        // it does not negotiate; the chips grade behaviour, not version taste.
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : REVISION_LEGACY,
        capabilities,
        serverInfo: { name: "mcp-app-debug fixture", version: __APP_VERSION__ },
      });
    }
    case "server/discover":
      obs.discoverAt ??= now(fx);
      return ok(
        {
          supportedVersions: [REVISION_STATELESS, REVISION_LEGACY],
          capabilities,
          ttlMs: 3_600_000,
          cacheScope: "public",
        },
        false,
      );
    case "ping":
      return ok({});
    case "tools/list":
      obs.toolsListedAt ??= now(fx);
      return ok(
        {
          tools: [
            {
              name: "probe",
              title: "MCP Apps host probe",
              description:
                "Renders the mcp-app-debug probe app, which grades this host's MCP Apps support. Call it with no arguments.",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { resourceUri: PROBE_RESOURCE_URI } },
            },
            {
              name: "report",
              title: "Probe beacon (app-only)",
              description: "Called by the probe app to report what it observed. Not for the model.",
              inputSchema: {
                type: "object",
                properties: { payload: { type: "object" } },
                required: ["payload"],
              },
              _meta: { ui: { visibility: ["app"] } },
            },
          ],
        },
        true,
      );
    case "resources/list":
      return ok(
        {
          resources: [
            {
              uri: PROBE_RESOURCE_URI,
              name: "probe.html",
              mimeType: RESOURCE_MIME,
              _meta: { ui: fx.uiResourceMeta },
            },
          ],
        },
        true,
      );
    case "resources/read": {
      const uri = params?.uri;
      if (uri !== PROBE_RESOURCE_URI) {
        if (typeof uri === "string") {
          obs.otherReads.push(uri);
          fx.onEvent();
        }
        return err(-32602, `Resource not found: ${String(uri)}`);
      }
      obs.resourceReadAt ??= now(fx);
      fx.onEvent();
      return ok(
        {
          contents: [
            {
              uri: PROBE_RESOURCE_URI,
              mimeType: RESOURCE_MIME,
              text: fx.html,
              _meta: { ui: fx.uiResourceMeta },
            },
          ],
        },
        true,
      );
    }
    case "resources/templates/list":
      return ok({ resourceTemplates: [] }, true);
    case "prompts/list":
      return ok({ prompts: [] }, true);
    case "tools/call": {
      const name = params?.name;
      if (name === "probe") {
        obs.probeCalledAt ??= now(fx);
        fx.onEvent();
        return ok({
          content: [
            {
              type: "text",
              text: "probe dispatched — the mcp-app-debug probe app will now grade this host",
            },
          ],
          structuredContent: { probe: true, fixture: "mcp-app-debug", plantedMeta: true },
          _meta: { ui: { probeToken: obs.probeToken } },
        });
      }
      if (name === "report") {
        const args = params?.arguments as Record<string, unknown> | undefined;
        obs.reportCalls++;
        obs.reportCallAt ??= now(fx);
        recordBeacon(fx, "report-call", args?.payload);
        return ok({ content: [{ type: "text", text: "beacon received" }] });
      }
      return err(-32602, `Unknown tool: ${String(name)}`);
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

/* --------------------------------------------------------------- transports */

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function handleBeaconRoute(fx: Fixture, req: http.IncomingMessage, res: http.ServerResponse): void {
  // The probe app posts cross-origin from the sandbox — CORS headers keep the
  // browser quiet, but a "simple" text/plain POST is recorded regardless.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  void readBody(req).then((body) => {
    try {
      recordBeacon(fx, "direct", JSON.parse(body));
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
}

function makeHttpServer(fx: Fixture): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/beacon")) {
      handleBeaconRoute(fx, req, res);
      return;
    }
    if (!url.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end(); // session teardown attempts are fine
      return;
    }
    if (req.method !== "POST") {
      // 2026-07-28 has no GET endpoint; legacy clients treat 405 as
      // "no server-push stream" and carry on.
      res.writeHead(405).end();
      return;
    }
    const headerVersion = req.headers["mcp-protocol-version"];
    if (typeof headerVersion === "string") {
      fx.obs.headerProtocolVersion ??= headerVersion;
      noteProtocolVersionSplit(fx);
    }
    let json: unknown;
    try {
      const body = await readBody(req);
      json = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const responses = (Array.isArray(json) ? json : [json])
      .map((m) => handleMessage(fx, m as JsonRpcMessage))
      .filter((r): r is Record<string, unknown> => r !== null);
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(json) ? responses : responses[0]));
  });
}

function startStdioTransport(fx: Fixture): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let json: JsonRpcMessage;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const response = handleMessage(fx, json);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}

/* ---------------------------------------------------------------- run loop */

export async function runHostConformance(opts: HostModeOptions): Promise<number> {
  const obs: HostObservations = {
    probeToken: randomBytes(16).toString("hex"),
    otherReads: [],
    beacons: [],
    reportCalls: 0,
  };
  const printed = new Set<string>();
  const stderrLog = (line: string) =>
    process.stderr.write(`  ${color(90, `+${String(now(fx)).padStart(6, " ")}ms`)} ${line}\n`);

  const printResolved = () => {
    if (opts.json) return;
    for (const c of evaluateHostChecks(obs, false)) {
      if (!c.resolved || printed.has(c.id)) continue;
      printed.add(c.id);
      process.stderr.write(`  ${VERDICT_FMT[c.verdict]}  ${c.id.padEnd(26)} ${c.detail}\n`);
    }
  };

  const fx: Fixture = {
    obs,
    epoch: Date.now(),
    html: "", // set below once the beacon origin is known
    uiResourceMeta: {},
    onEvent: printResolved,
    log: stderrLog,
  };

  // Transport + beacon endpoint. In HTTP mode both share one port; in stdio
  // mode the beacon gets its own loopback listener (stdout is the transport).
  let fixtureLabel: string;
  let beaconOrigin: string;
  const servers: http.Server[] = [];
  try {
    if (opts.stdio) {
      const beaconServer = makeHttpServer(fx); // /beacon route only ever hit
      await new Promise<void>((resolve, reject) => {
        beaconServer.once("error", reject);
        beaconServer.listen(0, "127.0.0.1", resolve);
      });
      servers.push(beaconServer);
      beaconOrigin = `http://127.0.0.1:${(beaconServer.address() as AddressInfo).port}`;
      fixtureLabel = "stdio";
      startStdioTransport(fx);
    } else {
      const server = makeHttpServer(fx);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, resolve);
      });
      servers.push(server);
      beaconOrigin = `http://127.0.0.1:${opts.port}`;
      fixtureLabel = `http://localhost:${opts.port}/mcp`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `${color(31, "x could not start the fixture server:")} ${msg}\n` +
        (/EADDRINUSE/.test(msg) ? `  Something is already listening on port ${opts.port} — pick another with --port.\n` : ""),
    );
    return 2;
  }

  fx.uiResourceMeta = {
    csp: { connectDomains: [beaconOrigin] },
    // Only meaningful for HTTP: the value scan mode's ui-domain check derives
    // for this exact endpoint spelling. stdio has no endpoint URL to hash.
    ...(opts.stdio ? {} : { domain: claudeDomain(fixtureLabel) }),
  };
  // Global replace — the placeholder also appears in the template's header
  // comment, and .replace with a string only hits the first occurrence.
  fx.html = PROBE_HTML_TEMPLATE.replace(
    /__PROBE_CONFIG__/g,
    JSON.stringify({ beaconUrl: `${beaconOrigin}/beacon`, version: __APP_VERSION__ }).replace(
      /</g,
      "\\u003c",
    ),
  );

  process.stderr.write(
    `\nmcp-app-debug host — fixture ${opts.stdio ? "serving on stdio" : `serving at ${fixtureLabel}`}\n` +
      `  Connect the host you want to grade and ask it to run the ${color(36, "probe")} tool.\n` +
      `  Observation window: ${opts.windowSec} s${opts.json ? " (ends early once every check resolves)" : " (Ctrl-C to finish early)"}.\n\n`,
  );

  // Window loop. In --json mode the run ends 2 s after every chip has reached
  // a definitive verdict (the quiet period settles the report-call vs
  // direct-beacon race); text mode always serves the whole window so a human
  // can keep poking the host.
  const EARLY_EXIT_QUIET_MS = 2000;
  await new Promise<void>((resolve) => {
    let allResolvedSince: number | undefined;
    const poll = setInterval(() => {
      if (!opts.json) return;
      if (evaluateHostChecks(obs, false).every((c) => c.resolved)) {
        allResolvedSince ??= Date.now();
        if (Date.now() - allResolvedSince >= EARLY_EXIT_QUIET_MS) finish();
      } else {
        allResolvedSince = undefined;
      }
    }, 250);
    const timer = setTimeout(finish, opts.windowSec * 1000);
    const onSigint = () => finish();
    process.once("SIGINT", onSigint);
    function finish() {
      clearInterval(poll);
      clearTimeout(timer);
      process.removeListener("SIGINT", onSigint);
      resolve();
    }
  });

  for (const s of servers) s.close();

  if (obs.firstContactAt === undefined) {
    process.stderr.write(
      `${color(31, "x")} no client connected within ${opts.windowSec} s — nothing to grade.\n` +
        `  The fixture was ${opts.stdio ? "serving on stdio" : `serving at ${fixtureLabel}`}; point the host at it and rerun (a longer wait: --window).\n`,
    );
    return 2;
  }

  const report = buildHostReport(obs, fixtureLabel);
  // In stdio mode stdout IS the MCP transport — the verdict goes to stderr.
  const out = opts.stdio ? process.stderr : process.stdout;
  if (opts.json) {
    out.write(JSON.stringify(report) + "\n");
  } else {
    process.stderr.write("\n");
    out.write(`Results — host-conformance, fixture ${fixtureLabel}\n`);
    for (const c of report.checks) {
      out.write(`  ${VERDICT_FMT[c.verdict]}  ${c.id.padEnd(26)} ${c.detail}\n`);
    }
    const parts = [`${report.passed}/${report.checks.length} passed`];
    if (report.failed) parts.push(color(31, `${report.failed} FAILED`));
    if (report.inconclusive) parts.push(color(33, `${report.inconclusive} inconclusive`));
    out.write(`  ${parts.join(" — ")}\n`);
  }

  return report.failed > 0 ? 1 : 0;
}
