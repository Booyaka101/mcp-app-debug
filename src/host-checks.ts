/**
 * The 7 host-conformance chips, evaluated over what the fixture server
 * observed on the wire plus what the probe app self-reported from inside the
 * sandbox. Each chip is PASS / FAIL / INCONCLUSIVE — a verdict is only ever
 * issued on an actual observation, never inferred.
 *
 * With `final: false` (live text mode / early-exit polling) a chip whose
 * verdict could still change is returned with `resolved: false`; absence-based
 * FAILs and INCONCLUSIVEs are only issued once the window has closed.
 */
import type { HostCheckResult, HostObservations, HostReport, ProbeBeacon } from "./types.js";

export const PROBE_RESOURCE_URI = "ui://mcp-app-debug/probe.html";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

/** How long the probe app waits for the ui/initialize answer / tool-result
 * before reporting anyway (mirrored inside probe.html). */
export const APP_INIT_WAIT_MS = 6000;
export const APP_TOOL_RESULT_WAIT_MS = 8000;

const NEVER_CALLED = "the host never called the tool — ask it to run `probe`";

const tokenPrefix = (token: string) => `${token.slice(0, 4)}…`;

type ChipBase = Pick<HostCheckResult, "id" | "title">;

function pendingOrInconclusive(base: ChipBase, final: boolean, finalDetail: string): HostCheckResult {
  return {
    ...base,
    verdict: "inconclusive",
    pass: false,
    detail: final ? finalDetail : "pending…",
    resolved: final,
  };
}

/** Callers spread the returned object and override `detail`. */
function make(base: ChipBase, verdict: "pass" | "fail"): HostCheckResult {
  return { ...base, verdict, pass: verdict === "pass", detail: "", resolved: true };
}

/** Latest beacon carrying a given field (the app sends "mounted" then "final"). */
function latestBeaconWith<K extends keyof ProbeBeacon>(
  beacons: ProbeBeacon[],
  key: K,
): ProbeBeacon | undefined {
  for (let i = beacons.length - 1; i >= 0; i--) {
    if (beacons[i][key] !== undefined) return beacons[i];
  }
  return undefined;
}

export function evaluateHostChecks(obs: HostObservations, final: boolean): HostCheckResult[] {
  const checks: HostCheckResult[] = [];
  const sinceContact = (at: number) => Math.round(at - (obs.firstContactAt ?? 0));
  const finalBeacon = obs.beacons.find((b) => b.phase === "final")
    ? obs.beacons.filter((b) => b.phase === "final").at(-1)
    : undefined;

  // 1. client-advertises-ui — did the connecting client ever advertise the
  // io.modelcontextprotocol/ui extension? (2025-11-25: initialize
  // params.capabilities.extensions; 2026-07-28: the clientCapabilities _meta
  // envelope). FAIL here is the pydantic-ai#6613 defect verbatim.
  {
    const base = { id: "client-advertises-ui" as const, title: "client advertises ui extension" };
    // A host speaks one revision, but evaluate both sources so a mixed client
    // is judged on its best evidence.
    const env = obs.envelopeCapabilities;
    const init = obs.initCapabilities;
    const envExt = env?.extensions as Record<string, unknown> | undefined;
    const initExt = init?.extensions as Record<string, unknown> | undefined;
    if (envExt && UI_EXTENSION in envExt) {
      checks.push({
        ...make(base, "pass"),
        detail:
          "io.modelcontextprotocol/ui advertised in the io.modelcontextprotocol/clientCapabilities _meta envelope (2026-07-28 path)",
      });
    } else if (initExt && UI_EXTENSION in initExt) {
      checks.push({
        ...make(base, "pass"),
        detail:
          "io.modelcontextprotocol/ui advertised in initialize params.capabilities.extensions (2025-11-25 path)",
      });
    } else if (env !== undefined || init !== undefined) {
      const ext = envExt ?? initExt;
      checks.push({
        ...make(base, "fail"),
        detail: ext
          ? `capabilities.extensions is present but io.modelcontextprotocol/ui is missing (keys: ${Object.keys(ext).join(", ") || "none"})`
          : "client capabilities carried no extensions map; io.modelcontextprotocol/ui was never advertised (pydantic-ai#6613 shape)",
      });
    } else if (obs.discoverAt !== undefined && final) {
      // Modern client (it called server/discover) whose requests never carried
      // the capabilities envelope — the extension was definitively never
      // advertised on this connection.
      checks.push({
        ...make(base, "fail"),
        detail:
          "client called server/discover but no request carried the io.modelcontextprotocol/clientCapabilities _meta envelope — the ui extension was never advertised",
      });
    } else {
      checks.push(
        pendingOrInconclusive(
          base,
          final,
          "no initialize request or capability-bearing _meta envelope was observed",
        ),
      );
    }
  }

  // 2. ui-resource-read — resources/read for the declared ui:// URI arrived.
  {
    const base = { id: "ui-resource-read" as const, title: "ui:// resource read" };
    if (obs.resourceReadAt !== undefined) {
      const prefetched =
        obs.probeCalledAt !== undefined && obs.resourceReadAt < obs.probeCalledAt
          ? " (prefetched before the tool call)"
          : "";
      checks.push({
        ...make(base, "pass"),
        detail: `resources/read ${PROBE_RESOURCE_URI} at +${sinceContact(obs.resourceReadAt)} ms${prefetched}`,
        ms: sinceContact(obs.resourceReadAt),
      });
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else {
      const others = obs.otherReads.length
        ? ` (it did read ${obs.otherReads.length} other URI(s), first: ${obs.otherReads[0]})`
        : "";
      checks.push({
        ...make(base, "fail"),
        detail: `the host called probe but never issued resources/read for ${PROBE_RESOURCE_URI} — the app HTML was never fetched${others}`,
      });
    }
  }

  // 3. app-mounted — any beacon at all proves the app's script ran.
  {
    const base = { id: "app-mounted" as const, title: "app mounted" };
    const first = obs.beacons[0];
    if (first) {
      checks.push({
        ...make(base, "pass"),
        detail: `beacon received at +${sinceContact(first.at)} ms (via ${first.via === "report-call" ? "app tools/call" : "direct beacon"})`,
        ms: sinceContact(first.at),
      });
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else if (obs.resourceReadAt !== undefined) {
      checks.push({
        ...make(base, "fail"),
        detail:
          "the resource was read but the app never initialized — the host most likely dropped the text/html;profile=mcp-app mimeType or refused to mount the iframe",
      });
    } else {
      checks.push({
        ...make(base, "fail"),
        detail: "no beacon arrived and the ui:// resource was never read — the app was never mounted",
      });
    }
  }

  // 4. ui-initialize-answered — self-reported by the app.
  {
    const base = { id: "ui-initialize-answered" as const, title: "ui/initialize answered" };
    const b = latestBeaconWith(obs.beacons, "uiInitializeAnswered");
    if (b?.uiInitializeAnswered === true) {
      const ms = typeof b.uiInitializeLatencyMs === "number" ? b.uiInitializeLatencyMs : undefined;
      checks.push({
        ...make(base, "pass"),
        detail: ms !== undefined ? `answered in ${ms} ms` : "answered",
        ms,
      });
    } else if (b?.uiInitializeAnswered === false && (final || b.phase === "final")) {
      checks.push({
        ...make(base, "fail"),
        detail: `the app sent ui/initialize but no response arrived within ${APP_INIT_WAIT_MS / 1000} s`,
      });
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else {
      checks.push(
        pendingOrInconclusive(
          base,
          true,
          "no app beacon carried handshake data — see app-mounted / app-call-relayed",
        ),
      );
    }
  }

  // 5. tool-result-meta-preserved — the planted _meta.ui.probeToken reached
  // the app inside the tool-result payload. FAIL is the _map_mcp_tool_result
  // defect (pydantic-ai#6613).
  {
    const base = {
      id: "tool-result-meta-preserved" as const,
      title: "tool-result _meta preserved",
    };
    const tok = tokenPrefix(obs.probeToken);
    if (finalBeacon?.sawToolResult === true) {
      const scNote =
        finalBeacon.toolResultHadStructuredContent === false
          ? "; note: structuredContent did NOT survive"
          : "";
      if (finalBeacon.probeToken === obs.probeToken) {
        checks.push({
          ...make(base, "pass"),
          detail: `planted _meta.ui.probeToken ${tok} arrived intact in the tool-result the app received${scNote}`,
        });
      } else {
        const keys = finalBeacon.toolResultMetaKeys ?? [];
        checks.push({
          ...make(base, "fail"),
          detail:
            `planted _meta.ui.probeToken ${tok} did not reach the app; the host dropped tool-result _meta` +
            (keys.length ? ` (the result _meta the app saw carried only: ${keys.join(", ")})` : "") +
            scNote,
        });
      }
    } else if (finalBeacon?.sawToolResult === false) {
      checks.push(
        pendingOrInconclusive(
          base,
          true,
          `the host never delivered ui/notifications/tool-result to the app (waited ${APP_TOOL_RESULT_WAIT_MS / 1000} s) — _meta preservation could not be observed`,
        ),
      );
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else {
      checks.push(
        pendingOrInconclusive(
          base,
          true,
          "no final app beacon arrived — the tool-result payload the app saw is unobservable",
        ),
      );
    }
  }

  // 6. app-call-relayed — the report tools/call arriving at the server IS the
  // proof. When this fails, chips 4/5 above stay INCONCLUSIVE unless the
  // direct beacon delivered the same observations.
  {
    const base = { id: "app-call-relayed" as const, title: "app→server tools/call relayed" };
    if (obs.reportCalls > 0) {
      checks.push({
        ...make(base, "pass"),
        detail: `${obs.reportCalls} app-initiated tools/call`,
      });
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.beacons.some((b) => b.via === "direct" && b.phase === "final")) {
      checks.push({
        ...make(base, "fail"),
        detail:
          "the app called tools/call `report` but it never reached the server — the host does not relay app-initiated calls (the direct beacon confirms the app tried)",
      });
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else if (obs.beacons.length > 0) {
      checks.push(
        pendingOrInconclusive(
          base,
          true,
          "the app mounted but no final report arrived before the window closed — widen --window or check the host's console",
        ),
      );
    } else {
      checks.push(
        pendingOrInconclusive(base, true, "no beacon arrived at all — see app-mounted"),
      );
    }
  }

  // 7. sandbox-origin-and-csp — self-reported origin isolation + any
  // securitypolicyviolation. Only the final beacon closes the violation
  // window, so a clean early beacon alone stays unresolved.
  {
    const base = { id: "sandbox-origin-and-csp" as const, title: "sandbox origin & CSP" };
    const b = obs.beacons.at(-1);
    const violations = b?.cspViolations ?? [];
    if (b?.topAccessible === true) {
      checks.push({
        ...make(base, "fail"),
        detail:
          "the app can reach window.top — it is running in the host's own browsing context with no sandbox isolation",
      });
    } else if (b && violations.length > 0) {
      const v = violations[0];
      checks.push({
        ...make(base, "fail"),
        detail: `${violations.length} CSP violation(s) inside the sandbox — first: ${v.violatedDirective} blocked ${v.blockedURI}`,
      });
    } else if (finalBeacon && finalBeacon.topAccessible === false) {
      const origin =
        finalBeacon.origin === "null" ? "opaque (null)" : (finalBeacon.origin ?? "(unknown)");
      checks.push({
        ...make(base, "pass"),
        detail: `origin ${origin}; no violations`,
      });
    } else if (!final) {
      checks.push(pendingOrInconclusive(base, false, ""));
    } else if (obs.probeCalledAt === undefined) {
      checks.push(pendingOrInconclusive(base, true, NEVER_CALLED));
    } else if (b) {
      checks.push(
        pendingOrInconclusive(
          base,
          true,
          "only an early beacon arrived — origin/CSP observation is incomplete",
        ),
      );
    } else {
      checks.push(pendingOrInconclusive(base, true, "no beacon arrived — nothing self-reported"));
    }
  }

  return checks;
}

export function buildHostReport(obs: HostObservations, fixture: string): HostReport {
  const checks = evaluateHostChecks(obs, true).map(({ resolved: _resolved, ...c }) => c);
  return {
    mode: "host",
    fixture,
    passed: checks.filter((c) => c.verdict === "pass").length,
    failed: checks.filter((c) => c.verdict === "fail").length,
    inconclusive: checks.filter((c) => c.verdict === "inconclusive").length,
    checks,
  };
}
