/**
 * Node-side MCP connection front door: negotiate the protocol revision
 * (src/mcp/negotiate.ts), discover UI-declaring tools, fetch ui:// resources.
 * All server traffic goes through the era-agnostic McpConn interface
 * (src/mcp/connect.ts).
 */
import {
  getToolUiResourceUri,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { targetLabel, type ConnectTarget, type McpConn } from "./mcp/connect.js";
import { negotiateConnection, type ProtocolChoice } from "./mcp/negotiate.js";

export { targetLabel, type ConnectTarget, type McpConn } from "./mcp/connect.js";
export type { ProtocolChoice } from "./mcp/negotiate.js";

export interface ServerConnection {
  mcp: McpConn;
  serverName: string;
  transportKind: McpConn["transportKind"];
  tools: Tool[];
  resources: Map<string, Resource>;
}

export async function connectToServer(
  target: ConnectTarget,
  protocol: ProtocolChoice,
  log: (message: string) => void,
): Promise<ServerConnection> {
  const mcp = await negotiateConnection(target, protocol, log);

  const serverName = mcp.getServerVersion()?.name ?? targetLabel(target);
  const toolsList = await mcp.listTools();

  // resources/list is optional server-side; UI metadata may live at listing level
  let resources = new Map<string, Resource>();
  try {
    const resourcesList = (await mcp.listResources()) as { resources?: Resource[] };
    resources = new Map((resourcesList.resources ?? []).map((r) => [r.uri, r]));
  } catch {
    // server has no resources capability — resource read will surface errors
  }

  return { mcp, serverName, transportKind: mcp.transportKind, tools: toolsList.tools, resources };
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
    resource = await conn.mcp.readResource({ uri });
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
