/**
 * Sandbox proxy — port of the official ext-apps basic-host sandbox
 * (examples/basic-host/src/sandbox.ts) with one addition: CSP violations
 * (from both the proxy document and the inner app document) are relayed to
 * the host page as `__mcpAppDebug` messages for check (b).
 *
 * Double-iframe architecture: this file runs in the OUTER iframe on its own
 * origin; it creates the INNER iframe holding the untrusted app HTML and
 * relays postMessages between host and app.
 */
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";

const ALLOWED_REFERRER_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/;

if (window.self === window.top) {
  throw new Error("This file is only to be used in an iframe sandbox.");
}
if (!document.referrer) {
  throw new Error("No referrer, cannot validate embedding site.");
}
if (!document.referrer.match(ALLOWED_REFERRER_PATTERN)) {
  throw new Error(`Embedding domain not allowed in referrer ${document.referrer}.`);
}

const EXPECTED_HOST_ORIGIN = new URL(document.referrer).origin;
const OWN_ORIGIN = new URL(window.location.href).origin;

// Security self-test: window.top MUST be inaccessible (different origin).
try {
  (window.top as Window & { alert: (m: string) => void }).alert(
    "If you see this, the sandbox is not setup securely.",
  );
  throw "FAIL";
} catch (e) {
  if (e === "FAIL") throw new Error("The sandbox is not setup securely.");
  // Expected: SecurityError confirms proper sandboxing.
}

function relayDebugEvent(event: string, data: Record<string, unknown>): void {
  window.parent.postMessage({ __mcpAppDebug: event, ...data }, EXPECTED_HOST_ORIGIN);
}

function violationListener(where: string) {
  return (e: SecurityPolicyViolationEvent) =>
    relayDebugEvent("csp-violation", {
      where,
      violatedDirective: e.violatedDirective,
      blockedURI: e.blockedURI,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
    });
}

window.addEventListener("securitypolicyviolation", violationListener("sandbox"));

const inner = document.createElement("iframe");
inner.style.cssText = "width:100%; height:100%; border:none;";
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
document.body.appendChild(inner);

// Method names per the MCP Apps spec (McpUiSandbox*Notification types)
const RESOURCE_READY_NOTIFICATION = "ui/notifications/sandbox-resource-ready";
const PROXY_READY_NOTIFICATION = "ui/notifications/sandbox-proxy-ready";

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source === window.parent) {
    if (event.origin !== EXPECTED_HOST_ORIGIN) return;

    if (event.data && event.data.method === RESOURCE_READY_NOTIFICATION) {
      const { html, sandbox, permissions } = event.data.params ?? {};
      if (typeof sandbox === "string") inner.setAttribute("sandbox", sandbox);
      const allowAttribute = buildAllowAttribute(permissions);
      if (allowAttribute) inner.setAttribute("allow", allowAttribute);
      if (typeof html === "string") {
        // document.write (not srcdoc) so the inner doc inherits this page's
        // origin and header-delivered CSP — same as the official sandbox.
        const doc = inner.contentDocument ?? inner.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
          // document.open() wipes listeners on the inner window, so attach
          // after close(). Parse-time inline violations are also covered:
          // they fire on this (sandbox) document's policy via the header.
          inner.contentWindow?.addEventListener(
            "securitypolicyviolation",
            violationListener("app"),
          );
        } else {
          inner.srcdoc = html;
        }
        relayDebugEvent("app-html-written", { bytes: html.length });
      }
    } else if (inner.contentWindow) {
      inner.contentWindow.postMessage(event.data, "*");
    }
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) return;
    window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
  }
});

window.parent.postMessage(
  { jsonrpc: "2.0", method: PROXY_READY_NOTIFICATION, params: {} },
  EXPECTED_HOST_ORIGIN,
);
