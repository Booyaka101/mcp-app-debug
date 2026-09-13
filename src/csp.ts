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

/** Base directives from an active profile descriptor (src/profiles/). */
export interface CspBase {
  frameAncestors: string;
  scriptSrc: string;
  defaultSrc: string;
  objectSrc: string;
}

/**
 * Without `base` this is the 0.5.0 header verbatim. With a profile's `base`,
 * the varied directives (default-src, script-src, object-src, frame-ancestors)
 * come from the descriptor; the rest is unchanged. A descriptor's
 * `frameAncestors: "'self'"` means "the host's own origin" — in this harness
 * that is the host page's origin (`hostOrigin`), not the sandbox's.
 *
 * `appliesResourceCsp: false` models a sandbox proxy that never reads the
 * resource's `_meta.ui.csp` (ext-apps#761): the declared resource/connect
 * origins are dropped and the sandbox gets the host's own policy only.
 */
export function buildCspHeader(
  csp?: ResourceCsp,
  base?: CspBase,
  hostOrigin?: string,
  appliesResourceCsp = true,
): string {
  const declared = appliesResourceCsp ? csp : undefined;
  const resourceDomains = sanitizeCspDomains(declared?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(declared?.connectDomains).join(" ");
  // #761 is specific to the resource/connect tails; frame-src and base-uri are
  // out of its scope and stay applied whatever the knob says.
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

  const directives = [
    base ? `default-src ${base.defaultSrc}` : "default-src 'self' 'unsafe-inline'",
    (base
      ? `script-src ${base.scriptSrc} ${resourceDomains}`
      : `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`
    ).trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    base ? `object-src ${base.objectSrc}` : "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ];
  if (base) {
    directives.push(
      `frame-ancestors ${base.frameAncestors === "'self'" && hostOrigin ? hostOrigin : base.frameAncestors}`,
    );
  }

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

/* ------------------------------------------------------ check 12 probing */

/** What every check-12 probe requests, under the declared path prefix if the
 * entry has one. Answered locally, never on the wire. */
export const CSP_PROBE_PATH = "/__mcp-app-debug-probe";

/** The one test for "this request came from check 12, not from the app". */
export function isCspProbeUrl(u: string | URL): boolean {
  try {
    return (typeof u === "string" ? new URL(u) : u).pathname.endsWith(CSP_PROBE_PATH);
  } catch {
    return false;
  }
}

/** Subdomain substituted for the `*` in a wildcard entry so it can be fetched. */
const WILDCARD_LABEL = "mcp-app-debug-probe";

/** More origins than this in one list is a configuration smell, not a thing
 * worth firing hundreds of requests at. */
const MAX_PROBES_PER_LIST = 20;

export interface CspProbeTarget {
  /** `resourceDomains` entries load an image; `connectDomains` entries fetch */
  kind: "resource" | "connect";
  /** the entry exactly as the server declared it */
  declared: string;
  /** the origin actually requested — a synthetic subdomain for a wildcard */
  origin: string;
  /** the exact URL requested: `origin` plus the entry's path prefix, if any */
  url: string;
  wildcard: boolean;
}

export interface CspProbePlan {
  targets: CspProbeTarget[];
  /** entries no interceptable request can be derived from */
  invalid: string[];
  /** entries dropped because the list was longer than MAX_PROBES_PER_LIST */
  capped: number;
  /** set when `targets` is empty: why there was nothing to send a request to */
  nothing?: string;
}

/**
 * Turn a `_meta.ui.csp` list into requestable origins. A CSP source list may
 * legitimately hold things no browser would ever resolve (`'self'`, `data:`,
 * a bare host with no scheme), and the official sanitizer drops anything that
 * could break out into a new directive — all of those are reported rather
 * than probed.
 */
export function planCspProbes(csp?: ResourceCsp): CspProbePlan {
  const targets: CspProbeTarget[] = [];
  const invalid: string[] = [];
  let capped = 0;
  const lists: Array<[CspProbeTarget["kind"], string[] | undefined]> = [
    ["resource", csp?.resourceDomains],
    ["connect", csp?.connectDomains],
  ];
  for (const [kind, list] of lists) {
    const seen = new Set<string>();
    for (const entry of list ?? []) {
      if (typeof entry !== "string" || entry === "") continue;
      const parsed = parseProbeOrigin(entry);
      if (!parsed) {
        if (!invalid.includes(entry)) invalid.push(entry);
        continue;
      }
      if (seen.has(parsed.url)) continue;
      seen.add(parsed.url);
      if (seen.size > MAX_PROBES_PER_LIST) {
        capped++;
        continue;
      }
      targets.push({ kind, ...parsed });
    }
  }
  return {
    targets,
    invalid,
    capped,
    ...(targets.length === 0 ? { nothing: nothingToProbe(csp, invalid) } : {}),
  };
}

/**
 * Why a plan came out empty. A declaration can be present and still carry no
 * origin to request — `frameDomains` alone, both lists declared empty (the
 * self-contained widget), or entries CSP accepts that are not origins — so the
 * three cases have to read differently.
 */
function nothingToProbe(csp: ResourceCsp | undefined, invalid: string[]): string {
  if (!csp) return "server declares no _meta.ui.csp; nothing to probe";
  if (invalid.length > 0) {
    return (
      `_meta.ui.csp declares no origin a request can be sent to; nothing to probe ` +
      `(${invalid.length} entry/entries are not a probeable origin: ${invalid.join(", ")})`
    );
  }
  return "_meta.ui.csp declares no resourceDomains or connectDomains; nothing to probe";
}

function parseProbeOrigin(entry: string): Omit<CspProbeTarget, "kind"> | null {
  // The same rejection buildCspHeader applies, so an entry that never made it
  // into the header is never probed either.
  if (sanitizeCspDomains([entry]).length === 0) return null;
  const wildcard = entry.includes("*");
  let url: URL;
  try {
    url = new URL(wildcard ? entry.replace("*.", `${WILDCARD_LABEL}.`) : entry);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.host === "" || url.host.includes("*")) return null;
  if (url.search !== "" || url.hash !== "") return null;
  // A source expression's path is part of the match: one ending in "/" is a
  // prefix the probe can go under, one naming a file matches only that file,
  // and requesting that file would mean a real request to a real origin.
  if (url.pathname !== "/" && !url.pathname.endsWith("/")) return null;
  return {
    declared: entry,
    origin: url.origin,
    url: url.origin + url.pathname.replace(/\/$/, "") + CSP_PROBE_PATH,
    wildcard,
  };
}
