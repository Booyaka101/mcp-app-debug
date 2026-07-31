/**
 * Node-side MCP client: connect (Streamable HTTP with SSE fallback, as in the
 * official basic-host, or stdio), discover UI-declaring tools, fetch ui://
 * resources.
 */
import {
  getToolUiResourceUri,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

const IMPLEMENTATION = { name: "mcp-app-debug", version: __APP_VERSION__ };
const CONNECT_TIMEOUT_MS = 30_000;

export type ConnectTarget =
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "stdio"; command: string; args: string[] };

/** Display string used in logs and the report's `server` field. */
export function targetLabel(target: ConnectTarget): string {
  return target.kind === "http"
    ? target.url
    : `stdio: ${[target.command, ...target.args].join(" ")}`;
}

export interface ServerConnection {
  client: Client;
  serverName: string;
  transportKind: "streamable-http" | "sse" | "stdio";
  tools: Tool[];
  resources: Map<string, Resource>;
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not complete within ${CONNECT_TIMEOUT_MS / 1000} s — ` +
              `the server accepted the connection but never finished the MCP handshake`,
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function connectTransport(target: ConnectTarget): Promise<{
  client: Client;
  transportKind: ServerConnection["transportKind"];
}> {
  if (target.kind === "stdio") {
    const client = new Client(IMPLEMENTATION);
    const transport = new StdioClientTransport({
      command: target.command,
      args: target.args,
      stderr: "inherit", // server logs stay visible — often the only evidence
    });
    await withTimeout(client.connect(transport), "stdio MCP handshake");
    return { client, transportKind: "stdio" };
  }

  const url = new URL(target.url);
  const headers = target.headers;
  const hasHeaders = Object.keys(headers).length > 0;
  try {
    const client = new Client(IMPLEMENTATION);
    await withTimeout(
      client.connect(
        new StreamableHTTPClientTransport(url, hasHeaders ? { requestInit: { headers } } : {}),
      ),
      "Streamable HTTP connect",
    );
    return { client, transportKind: "streamable-http" };
  } catch (streamableError) {
    try {
      const client = new Client(IMPLEMENTATION);
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
      await withTimeout(client.connect(new SSEClientTransport(url, sseOpts)), "SSE connect");
      return { client, transportKind: "sse" };
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

export async function connectToServer(target: ConnectTarget): Promise<ServerConnection> {
  const { client, transportKind } = await connectTransport(target);

  const serverName = client.getServerVersion()?.name ?? targetLabel(target);
  const toolsList = await client.listTools();

  // resources/list is optional server-side; UI metadata may live at listing level
  let resources = new Map<string, Resource>();
  try {
    const resourcesList = await client.listResources();
    resources = new Map(resourcesList.resources.map((r) => [r.uri, r]));
  } catch {
    // server has no resources capability — resource read will surface errors
  }

  return { client, serverName, transportKind, tools: toolsList.tools, resources };
}

export interface UiTool {
  tool: Tool;
  resourceUri?: string;
  /** set when _meta.ui.resourceUri exists but is malformed (not ui://) */
  uriError?: string;
}

/** Tools that declare a UI resource (or declare one invalidly). */
export function findUiTools(tools: Tool[]): UiTool[] {
  const result: UiTool[] = [];
  for (const tool of tools) {
    try {
      const uri = getToolUiResourceUri(tool);
      if (uri) result.push({ tool, resourceUri: uri });
    } catch (e) {
      result.push({ tool, uriError: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

export interface UiResourceFetch {
  ok: boolean;
  html?: string;
  mimeType?: string;
  bytes?: number;
  csp?: unknown;
  permissions?: unknown;
  domain?: unknown;
  error?: string;
}

/**
 * Fetch and validate the ui:// resource, mirroring basic-host getUiResource:
 * exactly one content item, RESOURCE_MIME_TYPE, content-level _meta.ui
 * preferred over listing-level.
 */
export async function fetchUiResource(
  conn: ServerConnection,
  uri: string,
): Promise<UiResourceFetch> {
  let resource;
  try {
    resource = await conn.client.readResource({ uri });
  } catch (e) {
    return { ok: false, error: `resources/read failed: ${e instanceof Error ? e.message : e}` };
  }

  if (!resource || resource.contents.length !== 1) {
    return {
      ok: false,
      error: `expected exactly 1 content item, got ${resource?.contents.length ?? 0}`,
    };
  }

  const content = resource.contents[0] as Record<string, unknown>;
  const mimeType = content.mimeType as string | undefined;
  const html =
    typeof content.blob === "string"
      ? Buffer.from(content.blob, "base64").toString("utf-8")
      : (content.text as string | undefined);

  if (html === undefined) {
    return { ok: false, mimeType, error: "resource content has neither text nor blob" };
  }

  const mimeOk = mimeType === RESOURCE_MIME_TYPE;

  // content-level _meta (spec) or meta (Python SDK quirk), else listing-level
  const contentMeta =
    (content._meta as Record<string, unknown> | undefined) ??
    (content.meta as Record<string, unknown> | undefined);
  const listingMeta = (conn.resources.get(uri) as Record<string, unknown> | undefined)?.[
    "_meta"
  ] as Record<string, unknown> | undefined;
  const uiMeta = (contentMeta?.ui ?? listingMeta?.ui) as
    | { csp?: unknown; permissions?: unknown; domain?: unknown }
    | undefined;

  return {
    ok: mimeOk,
    html,
    mimeType,
    bytes: Buffer.byteLength(html, "utf-8"),
    csp: uiMeta?.csp,
    permissions: uiMeta?.permissions,
    domain: uiMeta?.domain,
    error: mimeOk
      ? undefined
      : `unexpected mimeType "${mimeType}" (spec requires "${RESOURCE_MIME_TYPE}")`,
  };
}

/** Default tool arguments from inputSchema `default` values (as basic-host does). */
export function getToolDefaults(tool: Tool): Record<string, unknown> {
  const props = tool.inputSchema?.properties;
  if (!props) return {};
  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop && typeof prop === "object" && "default" in prop) {
      defaults[key] = (prop as { default: unknown }).default;
    }
  }
  return defaults;
}
