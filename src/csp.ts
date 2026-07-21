/**
 * CSP handling.
 *
 * `buildCspHeader` is ported from the official ext-apps basic-host
 * (examples/basic-host/serve.ts) so the sandbox page is served with the SAME
 * effective Content-Security-Policy header a spec-conformant host applies for
 * a given `_meta.ui.csp` declaration. Violations observed under this policy
 * are what check (b) reports.
 */

export interface ResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** Reject entries that could break out into new directives (official logic). */
function sanitizeCspDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

export function buildCspHeader(csp?: ResourceCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

  const directives = [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ];

  return directives.join("; ");
}

/**
 * Static scan of the app HTML for a `<meta http-equiv="Content-Security-Policy">`
 * whose frame-ancestors directive would prevent the app from being embedded.
 *
 * Browsers ignore frame-ancestors delivered via <meta>, but hosts that serve
 * ui:// HTML over HTTP (or proxy it through a CSP service, as Claude Desktop
 * does) enforce it as a header — making it a classic cause of "iframe never
 * appears". Returns a human-readable issue string, or undefined if fine.
 */
export function scanMetaCspForFrameAncestors(html: string): string | undefined {
  const metaRe =
    /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
  for (const metaTag of html.match(metaRe) ?? []) {
    const contentMatch = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(metaTag);
    const policy = contentMatch?.[2] ?? contentMatch?.[3];
    if (!policy) continue;
    const directive = policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
    if (!directive) continue;
    const sources = directive.split(/\s+/).slice(1).map((s) => s.toLowerCase());
    if (sources.includes("'none'")) {
      return `app HTML declares "${directive}" in a CSP <meta> tag — when enforced as a header this blocks ALL embedding, so the iframe never renders`;
    }
    if (!sources.includes("'self'") && !sources.includes("*")) {
      return `app HTML declares "${directive}" in a CSP <meta> tag — it omits 'self', so hosts enforcing it as a header refuse to embed the app`;
    }
  }
  return undefined;
}
