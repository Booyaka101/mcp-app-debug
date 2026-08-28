/**
 * The 7 automated diagnostics, evaluated over the harness state collected
 * during the observation window.
 */
import { checkAppDomain } from "./domain.js";
import type { ProfileDescriptor } from "./profiles/index.js";
import type { CheckReport, CheckResult, CheckStatus, HarnessState } from "./types.js";

export const UI_INITIALIZE_DEADLINE_MS = 3000;
export const UI_READY_DEADLINE_MS = 5000;

export function statusOf(check: CheckResult): CheckStatus {
  return check.status ?? (check.pass ? "pass" : "fail");
}

export function evaluateChecks(state: HarnessState, profile?: ProfileDescriptor): CheckResult[] {
  const checks: CheckResult[] = [];

  // (a) _meta.ui.resourceUri is a valid ui:// path that serves an MCP App resource
  {
    let pass = false;
    let detail: string;
    if (!state.resourceUri && !state.resourceError) {
      detail = "tool declares no _meta.ui.resourceUri";
    } else if (!state.resourceUriValid) {
      detail = state.resourceError ?? `invalid resource URI "${state.resourceUri}"`;
    } else if (!state.resourceOk) {
      detail = `${state.resourceUri}: ${state.resourceError ?? "fetch failed"}`;
    } else {
      pass = true;
      detail = `${state.resourceUri} (${state.resourceMime}, ${state.resourceBytes} bytes)`;
    }
    checks.push({ id: "resource-uri", title: "ui:// resource resolves", pass, detail });
  }

  // (b) CSP allows the app to render inside the host sandbox
  {
    let pass = false;
    let detail: string;
    if (!state.resourceOk) {
      detail = "skipped evaluation — no UI resource was fetched (see resource-uri)";
    } else if (state.metaCspIssue) {
      detail = state.metaCspIssue;
    } else if (state.cspViolations.length > 0) {
      const first = state.cspViolations[0];
      detail =
        `${state.cspViolations.length} CSP violation(s) under the host policy — ` +
        `first: ${first.violatedDirective} blocked ${first.blockedURI}` +
        (state.resourceCsp
          ? ""
          : " (resource declares no _meta.ui.csp; external origins must be listed there)");
    } else {
      pass = true;
      detail = state.resourceCsp
        ? `no violations; _meta.ui.csp honored: ${JSON.stringify(state.resourceCsp)}`
        : "no violations under the default host policy; no frame-ancestors restrictions";
    }
    checks.push({ id: "csp", title: "CSP permits embedding & assets", pass, detail });
  }

  // (c) _meta.ui.domain, when declared, matches the origin Claude derives
  {
    const verdict = checkAppDomain(state.resourceDomain, state.serverEndpoint);
    let pass = true;
    let status: CheckStatus | undefined;
    let detail: string;
    switch (verdict.state) {
      case "absent":
        detail =
          "no _meta.ui.domain — the app still renders, but hosts mint a fresh " +
          "sandbox origin per render, so an API server cannot allowlist it";
        break;
      case "match":
        detail = `matches the origin derived from this endpoint (${verdict.expected})`;
        break;
      case "no-endpoint":
        detail = `declared "${verdict.got}"; stdio target has no endpoint URL to derive the expected value from`;
        break;
      case "mismatch":
        if (profile && !profile.honoursUiDomain) {
          // This host is not reported to derive/enforce the Claude-scheme
          // domain, so a mismatch is informational under this profile.
          status = "info";
          detail =
            `declared "${verdict.got}" does not match the Claude-derived "${verdict.expected}", ` +
            `but the ${profile.name} profile does not model _meta.ui.domain enforcement ` +
            "(the format is host-specific; only Claude hosts are reported to derive this value)";
        } else {
          pass = false;
          detail =
            `declared "${verdict.got}" but this endpoint derives "${verdict.expected}" — ` +
            (verdict.nearMiss
              ? `that value is the hash of the same URL ${verdict.nearMiss}; recompute it from the exact URL the connector was added with. `
              : "") +
            "Claude refuses to mount the iframe on any mismatch (silently, beyond a generic error). " +
            "Other hosts use their own format — this check is Claude-specific.";
        }
        break;
    }
    checks.push({ id: "ui-domain", title: "_meta.ui.domain origin", pass, detail, ...(status ? { status } : {}) });
  }

  // (d) ui/initialize handshake completed within 3s of HTML injection
  {
    let pass = false;
    let detail: string;
    let ms: number | undefined;
    if (state.htmlInjectedAt === undefined) {
      detail = "app HTML was never injected into the sandbox (earlier failure)";
    } else if (state.uiInitializeRespondedAt === undefined) {
      detail =
        state.uiInitializeAt !== undefined
          ? "ui/initialize request seen but no response completed"
          : `no ui/initialize request from the app within ${UI_INITIALIZE_DEADLINE_MS} ms — ` +
            "the app never connected (check for JS errors in the log; is the App Bridge bundled?)";
    } else if (state.uiInitializeError !== undefined) {
      ms = state.uiInitializeRespondedAt - state.htmlInjectedAt;
      detail =
        `the host REJECTED the app's ui/initialize (${state.uiInitializeError}) — ` +
        "appInfo and appCapabilities are both required in the params. An app that sends " +
        "ui/notifications/initialized without awaiting this reply runs on regardless, so " +
        "the later checks can still look healthy while a real client has no connected app.";
    } else {
      ms = state.uiInitializeRespondedAt - state.htmlInjectedAt;
      pass = ms <= UI_INITIALIZE_DEADLINE_MS;
      detail = pass
        ? `handshake completed in ${ms} ms`
        : `handshake took ${ms} ms (deadline ${UI_INITIALIZE_DEADLINE_MS} ms)`;
    }
    checks.push({ id: "ui-initialize", title: "ui/initialize handshake", pass, detail, ms });
  }

  // (e) ui/ready (ui/notifications/initialized) within 5s of HTML injection
  {
    let pass = false;
    let detail: string;
    let ms: number | undefined;
    if (state.htmlInjectedAt === undefined) {
      detail = "app HTML was never injected into the sandbox (earlier failure)";
    } else if (state.uiReadyAt === undefined) {
      detail =
        `no ui/notifications/initialized within ${UI_READY_DEADLINE_MS} ms — ` +
        "the app initialized but never signaled ready (App.connect() not completing?)";
    } else {
      ms = state.uiReadyAt - state.htmlInjectedAt;
      pass = ms <= UI_READY_DEADLINE_MS;
      detail = pass
        ? `app signaled ready in ${ms} ms`
        : `app signaled ready after ${ms} ms (deadline ${UI_READY_DEADLINE_MS} ms)`;
    }
    checks.push({ id: "ui-ready", title: "ui/ready notification", pass, detail, ms });
  }

  // (f) at least one app-initiated tools/call returned a non-error result
  {
    const okCall = state.appToolCalls.find((c) => !c.isError);
    const failCalls = state.appToolCalls.filter((c) => c.isError);
    let pass = false;
    let detail: string;
    if (okCall) {
      pass = true;
      detail = `app called "${okCall.name}" → non-error result (${state.appToolCalls.length} app call(s) total)`;
    } else if (failCalls.length > 0) {
      detail = `app made ${failCalls.length} tools/call(s), all returned errors (first: "${failCalls[0].name}")`;
    } else if (state.appToolCallAttempts > 0) {
      detail =
        `app sent ${state.appToolCallAttempts} tools/call request(s) but the host REJECTED them ` +
        `(no serverTools capability/handler — see "Method not found" in the log)` +
        (state.mode === "strict" ? "; this is the strict/3p-mode silent failure" : "");
    } else {
      detail =
        "no app-initiated tools/call observed" +
        (state.interactNote ? ` — ${state.interactNote}` : "") +
        (state.mode === "strict"
          ? " (strict mode: host advertises no serverTools capability)"
          : " (use --click <text> to press a specific control in the app)");
    }
    checks.push({ id: "tool-call", title: "app-initiated tools/call", pass, detail });
  }

  // (g) protocol revision — negotiated cleanly, and 2026-07-28 servers honor
  // the server/discover MUST
  {
    const n = state.negotiated;
    let pass = true;
    let detail: string;
    if (!n) {
      pass = false;
      detail = "no negotiation outcome recorded (connection failed earlier)";
    } else if (n.revision === "2026-07-28" && !n.discoverImplemented) {
      pass = false;
      detail =
        `server claims 2026-07-28 (stateless requests succeed) but ` +
        `${n.notes[0] ?? "server/discover is not implemented"} — ` +
        "the 2026-07-28 revision makes server/discover a MUST";
    } else if (n.revision === "2026-07-28") {
      const uiPart = n.uiExtensionAdvertised
        ? "server advertises io.modelcontextprotocol/ui"
        : "server does NOT advertise io.modelcontextprotocol/ui in capabilities.extensions — " +
          "hosts that gate on the extension will not offer this app";
      const extras = n.notes.length > 0 ? `; ${n.notes.join("; ")}` : "";
      detail = `negotiated 2026-07-28 via server/discover; ${uiPart}${extras}`;
    } else {
      const discoverPart = n.notes[0] ?? "server/discover not implemented";
      detail =
        `negotiated 2025-11-25 via initialize (legacy path); ${discoverPart} ` +
        "(legitimate during the 12-month deprecation window)";
    }
    checks.push({ id: "protocol-revision", title: "protocol revision", pass, detail });
  }

  return checks;
}

/**
 * Checks 8-10 — only evaluated under --profile. Statuses: pass/fail/info/skip;
 * info and skip never count as failures.
 */
export function evaluateProfileChecks(
  state: HarnessState,
  profile: ProfileDescriptor,
  windowSec: number,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const push = (
    id: CheckResult["id"],
    title: string,
    status: CheckStatus,
    detail: string,
    ms?: number,
  ) => checks.push({ id, title, pass: status !== "fail", status, detail, ms });

  // (8) tool-result redelivery — ext-apps#750 symptom 1
  {
    const sc = state.secondCall;
    if (!sc || sc.skipped) {
      push("tool-result-redelivery", "tool-result redelivery", "skip",
        sc?.skipped ?? "second tools/call was never attempted (earlier failure)");
    } else if (state.firstToolResultDeliveredAt === undefined) {
      push("tool-result-redelivery", "tool-result redelivery", "skip",
        "tool-result #1 never reached the app (see earlier checks) — redelivery unobservable");
    } else if (sc.withheld) {
      push("tool-result-redelivery", "tool-result redelivery", "fail",
        `app received tool-result #1 but the ${profile.name} profile models a host that does ` +
        "not redeliver tool-result after further tools/call (ext-apps#750 symptom 1) — " +
        "the app is left showing stale state");
    } else if (sc.resultIsError) {
      push("tool-result-redelivery", "tool-result redelivery", "fail",
        `second tools/call ${sc.resultErrorMsg ? `threw (${sc.resultErrorMsg})` : "returned isError"} — ` +
        "the server emits a usable tool-result only on the first call" +
        (sc.deliveredAt !== undefined ? " (the error result was still delivered to the app)" : ""));
    } else if (sc.deliveredAt !== undefined) {
      const ms = sc.sentAt !== undefined ? sc.deliveredAt - sc.sentAt : undefined;
      push("tool-result-redelivery", "tool-result redelivery", "pass",
        `second tool-result observed after ${ms ?? "?"}ms (${sc.label ?? "varied arguments"})`, ms);
    } else {
      push("tool-result-redelivery", "tool-result redelivery", "fail",
        "app mounted and received tool-result #1 but no tool-result after the second " +
        `tools/call (${windowSec.toFixed(1)}s) — this is symptom 1 in ext-apps#750`);
    }
  }

  // (9) multi-instance isolation — ext-apps#750 symptom 3
  {
    const i2 = state.instance2;
    if (!i2 || i2.skipped) {
      push("multi-instance-isolation", "multi-instance isolation", "skip",
        i2?.skipped ?? "second instance was never attempted (earlier failure)");
    } else if (i2.uiInitializeRespondedAt === undefined) {
      push("multi-instance-isolation", "multi-instance isolation",
        i2.mountedAt === undefined ? "skip" : "fail",
        i2.mountedAt === undefined
          ? "instance #2 was never injected into a sandbox (earlier failure)"
          : `instance #2 never completed the ui/initialize handshake (${windowSec.toFixed(1)}s) — ` +
            "the view cannot be mounted twice in one page");
    } else if (i2.uiInitializeError !== undefined) {
      push("multi-instance-isolation", "multi-instance isolation", "fail",
        `instance #2's ui/initialize was REJECTED (${i2.uiInitializeError}) — ` +
        "isolation cannot be judged because the second instance never connected");
    } else if (i2.leaksOn1 + i2.leaksOn2 > 0) {
      const parts: string[] = [];
      if (i2.leaksOn2 > 0) parts.push(`instance #2 received ${i2.leaksOn2} message(s) addressed to instance #1`);
      if (i2.leaksOn1 > 0) parts.push(`instance #1 received ${i2.leaksOn1} message(s) addressed to instance #2`);
      push("multi-instance-isolation", "multi-instance isolation", "fail",
        parts.join("; ") + " — cross-instance state is shared (ext-apps#750 symptom 3)");
    } else {
      const ms = i2.mountedAt !== undefined ? i2.uiInitializeRespondedAt - i2.mountedAt : undefined;
      push("multi-instance-isolation", "multi-instance isolation", "pass",
        "two distinct ui/initialize handshakes completed; no cross-instance postMessage observed", ms);
    }
  }

  // (10) external navigation — informational under spec, FAIL only when the
  // profile grants popups and navigation is nonetheless blocked
  {
    const np = state.navProbe;
    if (!np) {
      push("external-navigation", "external navigation", "skip",
        "navigation probe did not run (app frame never became available)");
    } else if (np.error) {
      push("external-navigation", "external navigation", "skip", np.error);
    } else {
      const outcome = `window.open ${np.windowOpen ?? "not attempted"}, target=_blank ${np.anchor ?? "not attempted"}`;
      const opened = np.windowOpen === "opened" || np.anchor === "opened";
      if (!np.popupsAllowed) {
        if (opened) {
          push("external-navigation", "external navigation", "fail",
            `navigation was NOT blocked although this profile grants no allow-popups (${outcome})`);
        } else {
          push("external-navigation", "external navigation", "info",
            `blocked by sandbox (no allow-popups) — ${outcome}`);
        }
      } else if (opened) {
        push("external-navigation", "external navigation", "pass",
          `${outcome} (allow-popups granted by this profile)`);
      } else if (np.sandboxConsoleSeen) {
        push("external-navigation", "external navigation", "fail",
          `blocked at the sandbox level although popupsAllowed=true — the profile's sandbox ` +
          `tokens do not grant allow-popups (${outcome})`);
      } else {
        push("external-navigation", "external navigation", "fail",
          `blocked, but not by the sandbox — a browser-level popup block (no sandbox console ` +
          `message seen), so the sandbox attribute is not the cause (${outcome})`);
      }
    }
  }

  return checks;
}

export function buildReport(
  state: HarnessState,
  meta: { server: string; tool: string; mode: string },
  profileCtx?: { profile: ProfileDescriptor; windowSec: number },
): CheckReport {
  const checks = profileCtx
    ? [
        ...evaluateChecks(state, profileCtx.profile),
        ...evaluateProfileChecks(state, profileCtx.profile, profileCtx.windowSec),
      ]
    : evaluateChecks(state);
  return {
    ...meta,
    passed: checks.filter((c) => statusOf(c) === "pass").length,
    failed: checks.filter((c) => statusOf(c) === "fail").length,
    checks,
    ...(profileCtx ? { profile: profileCtx.profile.name } : {}),
  };
}
