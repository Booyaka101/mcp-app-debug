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
    | "csp-violation"
    | "tool-result-delivered"
    | "second-call-sent"
    | "second-tool-result"
    | "second-tool-result-withheld"
    | "cross-instance-leak"
    | "instance2-skipped";
  /** extra structured data for markers (e.g. CSP violation details) */
  data?: Record<string, unknown>;
  /** which app instance the entry belongs to (profile mode only; 1 when absent) */
  instance?: number;
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
  /** set only when --profile is active — drives checks 8-10 in the page */
  profile?: HarnessProfileConfig;
}

/** The slice of an active profile descriptor the host page needs. */
export interface HarnessProfileConfig {
  name: string;
  /** iframe sandbox attribute value (outer and inner) */
  sandbox: string;
  redeliversToolResult: boolean;
  /** false when the descriptor's maxConcurrentInstances is 1 */
  mountSecondInstance: boolean;
  /** varied arguments for the second tools/call; null = tool is not argument-sensitive */
  secondToolArgs: Record<string, unknown> | null;
  /** human label for the varied argument, e.g. `city: "Tokyo-2"` */
  secondToolLabel?: string;
  /** per-instance markers planted in tool-result _meta so cross-instance
   * leakage is detectable on the wire */
  instanceNonces: [string, string];
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

export type CheckStatus = "pass" | "fail" | "info" | "skip";

export interface CheckResult {
  id:
    | "resource-uri"
    | "csp"
    | "ui-domain"
    | "ui-initialize"
    | "ui-ready"
    | "tool-call"
    | "protocol-revision"
    | "tool-result-redelivery"
    | "multi-instance-isolation"
    | "external-navigation";
  title: string;
  pass: boolean;
  detail: string;
  /** measured latency in ms where applicable */
  ms?: number;
  /** four-state outcome, set in profile mode; absent means pass/fail only */
  status?: CheckStatus;
}

export interface CheckReport {
  server: string;
  tool: string;
  mode: string;
  passed: number;
  failed: number;
  checks: CheckResult[];
  /** profile mode only */
  profile?: string;
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
  /** set when the reply to ui/initialize was a JSON-RPC error, as "<code>: <message>" */
  uiInitializeError?: string;
  uiReadyAt?: number;
  appToolCalls: Array<{ name: string; isError: boolean; at: number }>;
  /** tools/call requests seen on the wire from the app (even if the host rejected them) */
  appToolCallAttempts: number;
  /** the harness-simulated LLM tool call result (not counted for check e) */
  harnessToolCall?: { name: string; isError: boolean };
  interactNote?: string;

  /* -- profile mode (checks 8-10); all undefined outside --profile runs -- */
  /** first ui/notifications/tool-result reached the app (transport send) */
  firstToolResultDeliveredAt?: number;
  /** check 8 — second tools/call with varied arguments */
  secondCall?: {
    label?: string;
    skipped?: string;
    sentAt?: number;
    resultAt?: number;
    resultIsError?: boolean;
    resultErrorMsg?: string;
    /** second ui/notifications/tool-result reached the app */
    deliveredAt?: number;
    /** profile models a host that does not redeliver (ext-apps#750 symptom 1) */
    withheld?: boolean;
  };
  /** check 9 — second concurrent instance of the same view */
  instance2?: {
    skipped?: string;
    mountedAt?: number;
    uiInitializeRespondedAt?: number;
    uiInitializeError?: string;
    readyAt?: number;
    /** frames observed on instance 1 carrying instance 2's marker, and vice versa */
    leaksOn1: number;
    leaksOn2: number;
  };
  /** check 10 — external-navigation probe from inside the sandbox */
  navProbe?: {
    popupsAllowed: boolean;
    windowOpen?: "opened" | "blocked";
    anchor?: "opened" | "blocked";
    /** a console message named the sandbox as the blocker */
    sandboxConsoleSeen?: boolean;
    error?: string;
  };
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
  /** set when the host answered ui/initialize with a JSON-RPC error, as "<code>: <message>" */
  uiInitializeError?: string;
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
  /** params.protocolVersion the client asked for in its initialize body */
  initProtocolVersion?: string;
  /** the MCP-Protocol-Version HTTP header, which can disagree with the body */
  headerProtocolVersion?: string;
  /** the header/body disagreement has already been logged */
  protocolSplitLogged?: boolean;
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

/**
 * One-line summary of a JSON-RPC error for a check detail. Schema validators
 * answer with a pretty-printed issue array, which is unreadable in a report,
 * so reduce it to the offending paths and leave the raw frame in the log.
 */
export function summarizeRpcError(code: number | undefined, message: string | undefined): string {
  const head = code ?? "error";
  const raw = (message ?? "no message").trim();
  const start = raw.indexOf("[");
  if (start !== -1) {
    try {
      const issues = JSON.parse(raw.slice(start)) as Array<{ code?: string; path?: unknown[] }>;
      const paths = issues
        .filter((i) => Array.isArray(i.path) && i.path.length > 0)
        .map((i) => `${i.code ?? "invalid"} at ${i.path!.join(".")}`);
      if (paths.length) return `${head}: ${paths.join("; ")}`;
    } catch {
      // not a validator issue array — fall through to the flattened message
    }
  }
  return `${head}: ${truncatePayload(raw.replace(/\s+/g, " "))}`;
}

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
