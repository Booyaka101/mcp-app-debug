/**
 * Dual-protocol MCP connections.
 *
 * One interface (McpConn), two implementations:
 *   - legacyConnect     — @modelcontextprotocol/sdk v1, the 2025-11-25
 *                         initialize/initialized handshake (byte-identical to
 *                         mcp-app-debug ≤0.3.x behaviour).
 *   - statelessConnect  — @modelcontextprotocol/client v2, the 2026-07-28
 *                         stateless revision: server/discover negotiation, a
 *                         _meta envelope on every request, Mcp-Method/Mcp-Name
 *                         headers on Streamable HTTP POSTs, and "missing
 *                         resultType means complete" tolerance (all handled by
 *                         the official v2 client).
 *
 * Everything downstream of listTools() is era-agnostic: host.ts only ever
 * talks to a McpConn.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client as StatelessClient,
  StreamableHTTPClientTransport as StatelessStreamableTransport,
  type ClientOptions as StatelessClientOptions,
  type PriorDiscovery,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as StatelessStdioTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport as LegacyStdioTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyStreamableTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const REVISION_STATELESS = "2026-07-28";
export const REVISION_LEGACY = "2025-11-25";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const RESOURCE_MIME = "text/html;profile=mcp-app";

export const IMPLEMENTATION = { name: "mcp-app-debug", version: __APP_VERSION__ };
const CONNECT_TIMEOUT_MS = 30_000;
/** server/discover probe budget — stdio servers that crash on unknown
 * pre-initialize requests are indistinguishable from slow ones, so the probe
 * is time-boxed and a timeout is treated as a legacy verdict (on stdio). */
export const DISCOVER_PROBE_TIMEOUT_MS = 5_000;

export type ConnectTarget =
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "stdio"; command: string; args: string[] };

/** Display string used in logs and the report's `server` field. */
export function targetLabel(target: ConnectTarget): string {
  return target.kind === "http"
    ? target.url
    : `stdio: ${[target.command, ...target.args].join(" ")}`;
}

export interface NegotiatedProtocol {
  revision: typeof REVISION_STATELESS | typeof REVISION_LEGACY;
  /** how the era was established */
  via: "server/discover" | "initialize" | "stateless probe";
  /** whether the server answered server/discover (a MUST on 2026-07-28) */
  discoverImplemented: boolean;
  /** whether the server advertised io.modelcontextprotocol/ui in
   * capabilities.extensions, via server/discover on 2026-07-28 or the
   * initialize result on 2025-11-25; undefined only when unknowable (the
   * stateless-probe path has no discover result, and a failed handshake has no
   * capabilities) */
  uiExtensionAdvertised?: boolean;
  serverInfo?: { name: string; version?: string };
  /** extra findings surfaced in the protocol-revision check detail */
  notes: string[];
}

/**
 * Everything host.ts needs from a connection, era-independent. The method
 * list mirrors the exact call sites in host.ts (__mcpProxy ops, HarnessConfig
 * capabilities, server naming, teardown) plus the mcp.ts helpers.
 */
export interface McpConn {
  transportKind: "streamable-http" | "sse" | "stdio";
  negotiated: NegotiatedProtocol;
  listTools(): Promise<{ tools: Tool[] }>;
  listResources(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  readResource(params: { uri: string }): Promise<{ contents: Array<Record<string, unknown>> }>;
  listResourceTemplates(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  listPrompts(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getServerCapabilities(): Record<string, unknown> | undefined;
  getServerVersion(): { name: string; version?: string } | undefined;
  close(): Promise<void>;
}

/** Minimal structural view of a transport, so one tap fits both SDK eras. */
interface SendingTransport {
  send(message: unknown, options?: unknown): Promise<void>;
}

/** Box the id of one tools/call travels back in. */
const toolCallIdBox = new AsyncLocalStorage<{ id?: string | number }>();

/**
 * Watch a transport's outgoing frames for tools/call request ids. Wrapping
 * `send` is the only place the id is visible: both clients mint it inside
 * `request()` and neither returns it.
 */
function tapToolCallIds<T>(transport: T): T {
  const t = transport as T & SendingTransport;
  const inner = t.send.bind(t);
  t.send = (message: unknown, options?: unknown) => {
    const m = message as { method?: string; id?: string | number };
    const box = toolCallIdBox.getStore();
    if (box && m?.method === "tools/call" && m.id !== undefined) box.id = m.id;
    return inner(message, options);
  };
  return t;
}

/**
 * One tools/call, plus the JSON-RPC id the client actually put on the wire —
 * what hostContext.toolInfo.id has to carry. The id comes back through an
 * async-context box rather than a "last id seen" field because the harness
 * keeps several calls in flight (the redelivery probe and instance #2).
 */
export async function callToolWithId(
  conn: McpConn,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<{ result: Record<string, unknown>; id?: string | number }> {
  const box: { id?: string | number } = {};
  const result = await toolCallIdBox.run(box, () => conn.callTool(params));
  return { result, id: box.id };
}

export function withTimeout<T>(
  promise: Promise<T>,
  what: string,
  ms = CONNECT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not complete within ${ms / 1000} s — ` +
              `the server accepted the connection but never finished the MCP handshake`,
          ),
        ),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/* ------------------------------------------------------------------ legacy */

/**
 * SDK v1 connection: Streamable HTTP with SSE fallback, or stdio — the exact
 * transport logic mcp-app-debug has always used.
 */
export async function legacyConnect(
  target: ConnectTarget,
  negotiated: NegotiatedProtocol,
): Promise<McpConn> {
  let client: LegacyClient;
  let transportKind: McpConn["transportKind"];

  if (target.kind === "stdio") {
    client = new LegacyClient(IMPLEMENTATION);
    const transport = tapToolCallIds(
      new LegacyStdioTransport({
        command: target.command,
        args: target.args,
        stderr: "inherit", // server logs stay visible — often the only evidence
      }),
    );
    await withTimeout(client.connect(transport), "stdio MCP handshake");
    transportKind = "stdio";
  } else {
    const url = new URL(target.url);
    const headers = target.headers;
    const hasHeaders = Object.keys(headers).length > 0;
    try {
      client = new LegacyClient(IMPLEMENTATION);
      await withTimeout(
        client.connect(
          tapToolCallIds(
            new LegacyStreamableTransport(url, hasHeaders ? { requestInit: { headers } } : {}),
          ),
        ),
        "Streamable HTTP connect",
      );
      transportKind = "streamable-http";
    } catch (streamableError) {
      try {
        client = new LegacyClient(IMPLEMENTATION);
        const sseOpts = hasHeaders
          ? {
              requestInit: { headers },
              // the SSE GET stream ignores requestInit — inject headers via fetch
              eventSourceInit: {
                fetch: (input: string | URL, init?: RequestInit) =>
                  fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }),
              },
            }
          : {};
        await withTimeout(
          client.connect(tapToolCallIds(new SSEClientTransport(url, sseOpts))),
          "SSE connect",
        );
        transportKind = "sse";
      } catch (sseError) {
        const pathHint =
          url.pathname === "/" || url.pathname === ""
            ? `\n  Hint: most MCP servers serve on a path, commonly ${url.origin}/mcp`
            : "";
        throw new Error(
          `Could not connect to ${target.url} with any transport.\n` +
            `  Streamable HTTP: ${streamableError}\n  SSE: ${sseError}${pathHint}`,
        );
      }
    }
  }

  const serverVersion = client.getServerVersion();
  if (serverVersion) {
    negotiated.serverInfo = { name: serverVersion.name, version: serverVersion.version };
  }

  // 2025-11-25 carries the server's extensions map in the initialize result, so
  // the declaration is observable on this path too — an absent map is a definite
  // "not advertised", not an unknown.
  const serverCaps = client.getServerCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;
  negotiated.uiExtensionAdvertised = serverCaps
    ? UI_EXTENSION_ID in (serverCaps.extensions ?? {})
    : undefined;

  return {
    transportKind,
    negotiated,
    listTools: () => client.listTools() as Promise<{ tools: Tool[] }>,
    listResources: (p) => client.listResources(p) as Promise<Record<string, unknown>>,
    readResource: (p) =>
      client.readResource(p) as Promise<{ contents: Array<Record<string, unknown>> }>,
    listResourceTemplates: (p) =>
      client.listResourceTemplates(p) as Promise<Record<string, unknown>>,
    listPrompts: (p) => client.listPrompts(p) as Promise<Record<string, unknown>>,
    callTool: (p) => client.callTool(p) as Promise<Record<string, unknown>>,
    getServerCapabilities: () =>
      client.getServerCapabilities() as Record<string, unknown> | undefined,
    getServerVersion: () => client.getServerVersion(),
    close: () => client.close(),
  };
}

/* --------------------------------------------------------------- stateless */

/** The client capabilities every stateless request advertises in its _meta
 * envelope (the v2 client attaches them automatically once a modern era is
 * negotiated) — the documented MCP Apps client shape. */
export function statelessClientCapabilities(): NonNullable<StatelessClientOptions["capabilities"]> {
  return {
    extensions: {
      [UI_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME] },
    },
  } as NonNullable<StatelessClientOptions["capabilities"]>;
}

export interface StatelessConnectOptions {
  /** pin to exactly 2026-07-28 (no legacy fallback inside the v2 client) */
  pin?: boolean;
  /** adopt a prior era verdict instead of probing (zero-round-trip connect) */
  prior?: PriorDiscovery;
}

export interface StatelessConnection {
  client: StatelessClient;
  transportKind: McpConn["transportKind"];
}

/**
 * Open a v2-client connection. In auto mode the v2 client probes with
 * server/discover and may come back with era "legacy" — the caller decides
 * what to do with that verdict (negotiate.ts closes it and re-connects via
 * legacyConnect so the legacy path stays on SDK v1).
 */
export async function statelessClientConnect(
  target: ConnectTarget,
  opts: StatelessConnectOptions = {},
): Promise<StatelessConnection> {
  const client = new StatelessClient(IMPLEMENTATION, {
    capabilities: statelessClientCapabilities(),
    versionNegotiation: {
      mode: opts.pin ? { pin: REVISION_STATELESS } : "auto",
      probe: { timeoutMs: DISCOVER_PROBE_TIMEOUT_MS },
    },
  });

  if (target.kind === "stdio") {
    const transport = tapToolCallIds(
      new StatelessStdioTransport({
        command: target.command,
        args: target.args,
        stderr: "inherit",
      }),
    );
    await withTimeout(
      client.connect(transport, opts.prior ? { prior: opts.prior } : undefined),
      "stdio MCP connect (2026-07-28 negotiation)",
    );
    return { client, transportKind: "stdio" };
  }

  const headers = target.headers;
  const hasHeaders = Object.keys(headers).length > 0;
  const transport = tapToolCallIds(
    new StatelessStreamableTransport(
      new URL(target.url),
      hasHeaders ? { requestInit: { headers } } : {},
    ),
  );
  await withTimeout(
    client.connect(transport, opts.prior ? { prior: opts.prior } : undefined),
    "Streamable HTTP connect (2026-07-28 negotiation)",
  );
  return { client, transportKind: "streamable-http" };
}

/** Wrap an era-"modern" v2 client as a McpConn. */
export function statelessConn(
  { client, transportKind }: StatelessConnection,
  negotiated: NegotiatedProtocol,
): McpConn {
  const serverVersion = client.getServerVersion();
  if (serverVersion) {
    negotiated.serverInfo = { name: serverVersion.name, version: serverVersion.version };
  }
  return {
    transportKind,
    negotiated,
    listTools: () => client.listTools() as unknown as Promise<{ tools: Tool[] }>,
    listResources: (p) =>
      client.listResources(p as never) as unknown as Promise<Record<string, unknown>>,
    readResource: (p) =>
      client.readResource(p as never) as unknown as Promise<{
        contents: Array<Record<string, unknown>>;
      }>,
    listResourceTemplates: (p) =>
      client.listResourceTemplates(p as never) as unknown as Promise<Record<string, unknown>>,
    listPrompts: (p) =>
      client.listPrompts(p as never) as unknown as Promise<Record<string, unknown>>,
    callTool: (p) => client.callTool(p as never) as unknown as Promise<Record<string, unknown>>,
    getServerCapabilities: () =>
      client.getServerCapabilities() as Record<string, unknown> | undefined,
    getServerVersion: () => client.getServerVersion(),
    close: () => client.close(),
  };
}
