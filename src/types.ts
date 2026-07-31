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

export interface CheckResult {
  id: "resource-uri" | "csp" | "ui-domain" | "ui-initialize" | "ui-ready" | "tool-call";
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
