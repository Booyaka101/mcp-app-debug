/**
 * The 5 automated diagnostics, evaluated over the harness state collected
 * during the observation window.
 */
import type { CheckReport, CheckResult, HarnessState } from "./types.js";

export const UI_INITIALIZE_DEADLINE_MS = 3000;
export const UI_READY_DEADLINE_MS = 5000;

export function evaluateChecks(state: HarnessState): CheckResult[] {
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

  // (c) ui/initialize handshake completed within 3s of HTML injection
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
    } else {
      ms = state.uiInitializeRespondedAt - state.htmlInjectedAt;
      pass = ms <= UI_INITIALIZE_DEADLINE_MS;
      detail = pass
        ? `handshake completed in ${ms} ms`
        : `handshake took ${ms} ms (deadline ${UI_INITIALIZE_DEADLINE_MS} ms)`;
    }
    checks.push({ id: "ui-initialize", title: "ui/initialize handshake", pass, detail, ms });
  }

  // (d) ui/ready (ui/notifications/initialized) within 5s of HTML injection
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

  // (e) at least one app-initiated tools/call returned a non-error result
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

  return checks;
}

export function buildReport(
  state: HarnessState,
  meta: { server: string; tool: string; mode: string },
): CheckReport {
  const checks = evaluateChecks(state);
  return {
    ...meta,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    checks,
  };
}
