/**
 * Shared types between the Node CLI/harness and the browser-side host page.
 */

/** One row in the protocol log (side panel + Node collection). */
export interface LogEntry {
  /** ms since page/harness epoch (stamped by whoever created the entry) */
  ts: number;
  /** message direction or entry class */
  dir: "host→app" | "app→host" | "server" | "event" | "error";
  /** request | response | notification | event */
  kind: string;
  /** JSON-RPC method, or event name for non-protocol entries */
  method?: string;
  /** JSON-RPC id, if any */
  id?: string | number;
  /** payload preview, truncated to 200 chars */
  payload?: string;
  /** timeline marker consumed by checks.ts */
  marker?:
    | "html-injected"
    | "ui-initialize"
    | "ui-initialize-response"
    | "ui-ready"
    | "csp-violation";
  /** extra structured data for markers (e.g. CSP violation details) */
  data?: Record<string, unknown>;
}

/** Config served to the host page at GET /config. */
export interface HarnessConfig {
  serverUrl: string;
  serverName: string;
  toolName: string;
  toolTitle?: string;
  toolArgs: Record<string, unknown>;
  mode: "trusted" | "strict";
  modeNote?: string;
  sandboxUrl: string;
  /** null when the ui:// resource could not be fetched (check a fails) */
  resource: {
    uri: string;
    html: string | null;
    mimeType?: string;
    csp?: unknown;
    permissions?: unknown;
    error?: string;
  };
  serverCapabilities: Record<string, unknown> | undefined;
  /** server-phase log entries emitted before the page loaded */
  backlog?: LogEntry[];
}

/** Outcome of the protocol-revision negotiation (structural mirror of
 * NegotiatedProtocol in mcp/connect.ts, kept dependency-free for the browser
 * bundle). */
export interface NegotiatedInfo {
  revision: "2026-07-28" | "2025-11-25";
  via: "server/discover" | "initialize" | "stateless probe";
  discoverImplemented: boolean;
  uiExtensionAdvertised?: boolean;
  serverInfo?: { name: string; version?: string };
  notes: string[];
}

export interface CheckResult {
  id:
    | "resource-uri"
    | "csp"
    | "ui-domain"
    | "ui-initialize"
    | "ui-ready"
    | "tool-call"
    | "protocol-revision";
  title: string;
  pass: boolean;
  detail: string;
  /** measured latency in ms where applicable */
  ms?: number;
}

export interface CheckReport {
  server: string;
  tool: string;
  mode: string;
  passed: number;
  failed: number;
  checks: CheckResult[];
}

/** Everything host.ts accumulates for checks.ts to evaluate. */
export interface HarnessState {
  mode: "trusted" | "strict";
  /** protocol-revision negotiation outcome (set right after connect) */
  negotiated?: NegotiatedInfo;
  resourceUri?: string;
  resourceUriValid: boolean;
  resourceOk: boolean;
  resourceMime?: string;
  resourceBytes?: number;
  resourceError?: string;
  resourceCsp?: unknown;
  /** _meta.ui.domain as declared by the server, if any */
  resourceDomain?: unknown;
  /** endpoint URL for HTTP targets; undefined for stdio (nothing to hash) */
  serverEndpoint?: string;
  /** problem found by static scan of a CSP <meta> tag in the app HTML */
  metaCspIssue?: string;
  cspViolations: Array<Record<string, unknown>>;
  htmlInjectedAt?: number;
  uiInitializeAt?: number;
  uiInitializeRespondedAt?: number;
  uiReadyAt?: number;
  appToolCalls: Array<{ name: string; isError: boolean; at: number }>;
  /** tools/call requests seen on the wire from the app (even if the host rejected them) */
  appToolCallAttempts: number;
  /** the harness-simulated LLM tool call result (not counted for check e) */
  harnessToolCall?: { name: string; isError: boolean };
  interactNote?: string;
}

/* ------------------------------------------------------- host-conformance */

/** What the probe app self-reports from inside the sandbox (`mcp-app-debug
 * host`). Arrives via the app-only `report` tool and/or a direct HTTP beacon
 * to the fixture server — two channels, so a broken app→server relay does not
 * also blind the mount detection. */
export interface ProbeBeacon {
  /** which channel delivered it */
  via: "report-call" | "direct";
  /** "mounted" fires right after the app script runs; "final" after the
   * tool-result wait window */
  phase?: "mounted" | "final";
  /** ms since fixture start, stamped server-side on arrival */
  at: number;
  origin?: string;
  referrer?: string;
  /** true means the app can reach window.top — no sandbox isolation */
  topAccessible?: boolean;
  uiInitializeAnswered?: boolean;
  uiInitializeLatencyMs?: number;
  hostInfo?: unknown;
  sawToolInput?: boolean;
  sawToolResult?: boolean;
  toolResultHadStructuredContent?: boolean;
  /** _meta.ui.probeToken as seen in the tool-result the app received */
  probeToken?: string | null;
  toolResultMetaKeys?: string[];
  cspViolations?: Array<{ violatedDirective?: string; blockedURI?: string }>;
}

/** Everything the fixture server records about the connecting host. All
 * timestamps are ms since fixture start. */
export interface HostObservations {
  probeToken: string;
  firstContactAt?: number;
  clientInfo?: { name?: string; version?: string };
  /** params.capabilities from a 2025-11-25 initialize request */
  initCapabilities?: Record<string, unknown>;
  /** io.modelcontextprotocol/clientCapabilities from any request's _meta
   * envelope (the 2026-07-28 path) */
  envelopeCapabilities?: Record<string, unknown>;
  discoverAt?: number;
  toolsListedAt?: number;
  probeCalledAt?: number;
  resourceReadAt?: number;
  /** resources/read requests for URIs other than the declared one */
  otherReads: string[];
  beacons: ProbeBeacon[];
  reportCalls: number;
  reportCallAt?: number;
}

export interface HostCheckResult {
  id:
    | "client-advertises-ui"
    | "ui-resource-read"
    | "app-mounted"
    | "ui-initialize-answered"
    | "tool-result-meta-preserved"
    | "app-call-relayed"
    | "sandbox-origin-and-csp";
  title: string;
  /** the authoritative outcome — INCONCLUSIVE is never counted as failed */
  verdict: "pass" | "fail" | "inconclusive";
  /** verdict === "pass" — kept so scan-mode `--json` consumers work unchanged */
  pass: boolean;
  detail: string;
  /** measured latency in ms where applicable */
  ms?: number;
  /** internal: verdict can no longer change (stripped from the report) */
  resolved?: boolean;
}

export interface HostReport {
  mode: "host";
  fixture: string;
  passed: number;
  failed: number;
  inconclusive: number;
  checks: HostCheckResult[];
}

export const TRUNCATE_LEN = 200;

export function truncatePayload(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) return "";
  return s.length > TRUNCATE_LEN ? s.slice(0, TRUNCATE_LEN) + "…" : s;
}
