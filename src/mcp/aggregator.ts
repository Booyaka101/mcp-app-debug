/**
 * Namespacing-aggregator simulation (`--aggregator`).
 *
 * A gateway that fronts several MCP servers prefixes every tool name so that
 * `get-time` on upstream `alpha` reaches the model as `alpha__get-time`. An app
 * that hardcodes the bare name then calls a tool no upstream owns:
 *
 *   -> {"method":"tools/call","params":{"name":"get-time"}}
 *   <- {"error":{"code":-32043,"message":"unknown name \"get-time\": no upstream owns this namespace"}}
 *
 * while the model's call with `alpha__get-time` succeeds
 * (ext-apps#745, and the fifteen example apps counted in ext-apps#753).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConn } from "./connect.js";

export const DEFAULT_AGGREGATOR_PREFIX = "alpha__";
/** The code the gateway in ext-apps#745 answers an unowned name with. */
export const UNKNOWN_NAMESPACE_CODE = -32043;

/** A JSON-RPC error the harness answers instead of fulfilling a call. */
export class UnknownNamespaceError extends Error {
  readonly code = UNKNOWN_NAMESPACE_CODE;
  constructor(name: string) {
    super(`unknown name "${name}": no upstream owns this namespace`);
    this.name = "UnknownNamespaceError";
  }
}

export function isUnknownNamespaceError(e: unknown): e is UnknownNamespaceError {
  return e instanceof UnknownNamespaceError;
}

export interface Aggregator {
  prefix: string;
  /** the separator the prefix ends with — `__` for `alpha__` */
  separator: string;
  /** the name the harness advertises for an upstream tool */
  advertise(name: string): string;
  /** true when this name is one the harness advertises */
  isAdvertised(name: string): boolean;
  /** the upstream name behind an advertised one, or undefined when no upstream owns it */
  upstream(name: string): string | undefined;
}

/**
 * Build the name map for one connection. A tool whose own name already carries
 * the separator is left alone — a real gateway namespaces once, and a
 * double-prefixed `alpha__alpha__get-time` is nobody's tool.
 */
export function createAggregator(prefix: string, upstreamNames: string[]): Aggregator {
  const separator = /[^A-Za-z0-9]+$/.exec(prefix)?.[0] ?? prefix;
  const advertise = (name: string): string =>
    name.includes(separator) ? name : prefix + name;
  const byAdvertised = new Map<string, string>();
  for (const name of upstreamNames) byAdvertised.set(advertise(name), name);
  return {
    prefix,
    separator,
    advertise,
    isAdvertised: (name) => byAdvertised.has(name),
    upstream: (name) => byAdvertised.get(name),
  };
}

/**
 * Wrap a connection so the harness speaks the aggregator's names: `tools/list`
 * answers with the rewritten names, a call carrying one is fulfilled upstream,
 * and any other name — a bare name most of all — is refused with -32043
 * before it reaches the server, which is what the gateway does.
 */
export function aggregatorConn(conn: McpConn, aggregator: Aggregator): McpConn {
  return {
    ...conn,
    listTools: async () => {
      const { tools } = await conn.listTools();
      return { tools: tools.map((t: Tool) => ({ ...t, name: aggregator.advertise(t.name) })) };
    },
    callTool: (params) => {
      const upstream = aggregator.upstream(params.name);
      if (upstream === undefined) return Promise.reject(new UnknownNamespaceError(params.name));
      return conn.callTool({ ...params, name: upstream });
    },
  };
}
