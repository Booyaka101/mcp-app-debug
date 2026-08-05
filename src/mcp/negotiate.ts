/**
 * Protocol-revision negotiation: decide whether a server speaks the
 * 2026-07-28 stateless revision or the 2025-11-25 initialize handshake, and
 * return the matching McpConn.
 *
 * auto (default): probe server/discover first — the spec sanctions this
 * ("Clients MAY call it before any other request … or use it as a
 * backward-compatibility probe on STDIO"). A definitive answer selects the
 * stateless path; -32601 / legacy-shaped signals fall back to initialize.
 * A server that rejects BOTH initialize and server/discover but answers
 * stateless 2026-07-28 requests is a half-migrated server: we connect via a
 * synthetic prior-era verdict (ConnectOptions.prior — never a substitute for
 * the probe, only the recovery after it) so the remaining checks can run,
 * and the protocol-revision check FAILs on the missing MUST.
 */
import type { DiscoverResult } from "@modelcontextprotocol/client";
import {
  DISCOVER_PROBE_TIMEOUT_MS,
  IMPLEMENTATION,
  legacyConnect,
  REVISION_LEGACY,
  REVISION_STATELESS,
  statelessClientConnect,
  statelessConn,
  UI_EXTENSION_ID,
  withTimeout,
  type ConnectTarget,
  type McpConn,
  type NegotiatedProtocol,
} from "./connect.js";

export type ProtocolChoice = "auto" | typeof REVISION_STATELESS | typeof REVISION_LEGACY;

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** -32601 shaped: the peer rejected the method itself (not the transport). */
function isMethodNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return code === -32601 || /method not found/i.test(errText(e));
}

/** A synthetic era verdict for the recovery path: claims 2026-07-28 with
 * generous capabilities (the v2 client gates list calls on them; a server
 * that never answered server/discover left us nothing better to go on). */
const syntheticDiscover = (): DiscoverResult =>
  ({
    resultType: "complete",
    supportedVersions: [REVISION_STATELESS],
    capabilities: { tools: {}, resources: {}, prompts: {} },
    ttlMs: 0,
    cacheScope: "private",
  }) as DiscoverResult;

/**
 * One raw server/discover POST (HTTP targets only), outside the v2 client's
 * schema normalization — the only way to see whether the server actually sent
 * the spec-required ttlMs/cacheScope fields (the client defaults them
 * silently) and to capture the exact error a non-implementing server returns.
 */
async function rawDiscover(target: ConnectTarget): Promise<
  { result?: Record<string, unknown>; error?: { code?: number; message?: string } } | undefined
> {
  if (target.kind !== "http") return undefined;
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": REVISION_STATELESS,
        "mcp-method": "server/discover",
        ...target.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mcp-app-debug/discover-fieldcheck",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": REVISION_STATELESS,
            "io.modelcontextprotocol/clientInfo": IMPLEMENTATION,
          },
        },
      }),
      signal: AbortSignal.timeout(DISCOVER_PROBE_TIMEOUT_MS),
    });
    if (!res.headers.get("content-type")?.includes("json")) return undefined;
    const json = (await res.json()) as {
      result?: Record<string, unknown>;
      error?: { code?: number; message?: string };
    };
    return { result: json.result, error: json.error };
  } catch {
    return undefined;
  }
}

/** Negotiated details for a connection the v2 client established as "modern". */
async function describeModern(
  client: { getDiscoverResult(): DiscoverResult | undefined },
  target: ConnectTarget,
): Promise<NegotiatedProtocol> {
  const discover = client.getDiscoverResult();
  const extensions =
    (discover?.capabilities as { extensions?: Record<string, unknown> } | undefined)
      ?.extensions ?? {};
  const negotiated: NegotiatedProtocol = {
    revision: REVISION_STATELESS,
    via: "server/discover",
    discoverImplemented: true,
    uiExtensionAdvertised: UI_EXTENSION_ID in extensions,
    notes: [],
  };
  const versions = discover?.supportedVersions ?? [];
  if (versions.length > 1) {
    negotiated.notes.push(
      `server offers ${versions.join(", ")} — preferring ${REVISION_STATELESS}`,
    );
  }
  // The v2 client silently defaults missing ttlMs/cacheScope — re-probe raw
  // to surface the spec violation without failing the connection.
  const raw = await rawDiscover(target);
  if (raw?.result) {
    const missing = ["ttlMs", "cacheScope"].filter((k) => !(k in raw.result!));
    if (missing.length > 0) {
      negotiated.notes.push(
        `discover result omits required field(s) ${missing.join(", ")} (spec requires both)`,
      );
    }
  }
  return negotiated;
}

/** The recovery path: server rejected initialize AND server/discover, but may
 * still answer stateless 2026-07-28 requests. Verified with a real
 * tools/list before we commit to the verdict. */
async function connectStatelessWithoutDiscover(
  target: ConnectTarget,
  log: (message: string) => void,
): Promise<McpConn> {
  const sc = await statelessClientConnect(target, {
    prior: { kind: "modern", discover: syntheticDiscover() },
  });
  try {
    await withTimeout(sc.client.listTools(), "stateless tools/list probe", 10_000);
  } catch (e) {
    await sc.client.close().catch(() => {});
    throw new Error(`stateless 2026-07-28 requests not answered either: ${errText(e)}`);
  }
  const raw = await rawDiscover(target);
  const discoverDetail = raw?.error
    ? `server/discover returned ${raw.error.code} ${raw.error.message ?? ""}`.trim()
    : "server/discover not answered";
  log(
    `stateless 2026-07-28 requests succeed but ${discoverDetail} — ` +
      "half-migrated server (server/discover is a MUST on 2026-07-28)",
  );
  const negotiated: NegotiatedProtocol = {
    revision: REVISION_STATELESS,
    via: "stateless probe",
    discoverImplemented: false,
    uiExtensionAdvertised: undefined,
    notes: [
      discoverDetail,
      "capabilities assumed (tools, resources, prompts) — nothing advertised them",
    ],
  };
  return statelessConn(sc, negotiated);
}

function legacyNegotiated(
  via: NegotiatedProtocol["via"],
  discoverProbed: boolean,
  notes: string[] = [],
): NegotiatedProtocol {
  return {
    revision: REVISION_LEGACY,
    via,
    discoverImplemented: false,
    uiExtensionAdvertised: undefined,
    notes: discoverProbed ? notes : ["server/discover not probed (forced by --protocol)", ...notes],
  };
}

export async function negotiateConnection(
  target: ConnectTarget,
  protocol: ProtocolChoice,
  log: (message: string) => void,
): Promise<McpConn> {
  if (protocol === REVISION_LEGACY) return connectForcedLegacy(target, log);
  if (protocol === REVISION_STATELESS) return connectForcedStateless(target, log);
  return connectAuto(target, log);
}

/* --------------------------------------------------------------- forced */

async function connectForcedLegacy(
  target: ConnectTarget,
  log: (message: string) => void,
): Promise<McpConn> {
  log(`--protocol ${REVISION_LEGACY}: using the initialize handshake (server/discover not probed)`);
  try {
    return await legacyConnect(target, legacyNegotiated("initialize", false));
  } catch (e) {
    // Name what the server actually offers before giving up.
    let offers = "";
    try {
      const sc = await statelessClientConnect(target, { pin: true });
      const versions = sc.client.getDiscoverResult()?.supportedVersions?.join(", ");
      await sc.client.close().catch(() => {});
      offers =
        `\n  The server DOES implement server/discover and offers ${versions ?? REVISION_STATELESS} — ` +
        `rerun with --protocol ${REVISION_STATELESS} (or drop --protocol for auto-negotiation).`;
    } catch {
      // nothing better to report
    }
    throw new Error(
      `--protocol ${REVISION_LEGACY}: the server did not complete the initialize handshake.\n  ${errText(e)}${offers}`,
    );
  }
}

async function connectForcedStateless(
  target: ConnectTarget,
  log: (message: string) => void,
): Promise<McpConn> {
  log(`--protocol ${REVISION_STATELESS}: probing server/discover (pinned; no legacy fallback)`);
  let pinError: unknown;
  try {
    const sc = await statelessClientConnect(target, { pin: true });
    const negotiated = await describeModern(sc.client, target);
    log(`negotiated ${REVISION_STATELESS} via server/discover`);
    return statelessConn(sc, negotiated);
  } catch (e) {
    pinError = e;
  }
  // The server did not answer server/discover with 2026-07-28. It may still
  // be a half-migrated stateless server — try that before failing.
  try {
    return await connectStatelessWithoutDiscover(target, log);
  } catch {
    // fall through to characterize what the server actually offers
  }
  let offers = "";
  try {
    const legacy = await legacyConnect(target, legacyNegotiated("initialize", true));
    const name = legacy.getServerVersion()?.name;
    await legacy.close().catch(() => {});
    offers =
      `\n  The server${name ? ` ("${name}")` : ""} answers the ${REVISION_LEGACY} initialize handshake instead — ` +
      `rerun with --protocol ${REVISION_LEGACY} (or drop --protocol for auto-negotiation).`;
  } catch {
    // server offers neither — the pin error is the whole story
  }
  throw new Error(
    `--protocol ${REVISION_STATELESS}: the server does not speak the 2026-07-28 revision.\n  ${errText(pinError)}${offers}`,
  );
}

/* ------------------------------------------------------------------ auto */

async function connectAuto(
  target: ConnectTarget,
  log: (message: string) => void,
): Promise<McpConn> {
  log(
    `auto-negotiating: probing server/discover (${REVISION_STATELESS}), ` +
      `falling back to initialize (${REVISION_LEGACY})` +
      (target.kind === "stdio" ? ` — probe time-boxed at ${DISCOVER_PROBE_TIMEOUT_MS / 1000} s on stdio` : ""),
  );
  let autoError: unknown;
  try {
    const sc = await statelessClientConnect(target);
    if (sc.client.getProtocolEra() === "modern") {
      const negotiated = await describeModern(sc.client, target);
      log(`negotiated ${REVISION_STATELESS} via server/discover`);
      return statelessConn(sc, negotiated);
    }
    // Definitive legacy verdict: reconnect with SDK v1 so the legacy path is
    // byte-identical to mcp-app-debug ≤0.3.x.
    await sc.client.close().catch(() => {});
    log(
      "server/discover not implemented — legacy server; " +
        `connecting with the ${REVISION_LEGACY} initialize handshake`,
    );
    return await legacyConnect(target, legacyNegotiated("initialize", true));
  } catch (e) {
    autoError = e;
  }

  const attempts: string[] = [`2026-07-28 negotiation: ${errText(autoError)}`];

  if (isMethodNotFound(autoError)) {
    // The server rejected initialize itself (the auto probe's fallback), so it
    // is NOT a legacy server — check for a half-migrated stateless one first.
    log(`server rejected initialize (${errText(autoError)}) — probing ${REVISION_STATELESS} without server/discover`);
    try {
      return await connectStatelessWithoutDiscover(target, log);
    } catch (e) {
      attempts.push(`stateless probe: ${errText(e)}`);
    }
    try {
      return await legacyConnect(target, legacyNegotiated("initialize", true));
    } catch (e) {
      attempts.push(`initialize handshake: ${errText(e)}`);
    }
  } else {
    // Transport-shaped failure (e.g. an SSE-only server the v2 transport can't
    // reach) — the v1 path with its SSE fallback gets first try.
    log(`2026-07-28 negotiation failed — trying the ${REVISION_LEGACY} initialize handshake`);
    try {
      return await legacyConnect(
        target,
        legacyNegotiated("initialize", true, [`server/discover probe errored: ${errText(autoError)}`]),
      );
    } catch (e) {
      attempts.push(`initialize handshake: ${errText(e)}`);
    }
    try {
      return await connectStatelessWithoutDiscover(target, log);
    } catch (e) {
      attempts.push(`stateless probe: ${errText(e)}`);
    }
  }

  throw new Error(
    `Could not connect on either protocol revision.\n  ` + attempts.join("\n  "),
  );
}
