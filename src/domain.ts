/**
 * `_meta.ui.domain` — the dedicated origin a host serves the app sandbox from.
 *
 * The field is optional and host-specific per the spec, and its documented
 * purpose is CORS: it gives the app a stable origin an API server can
 * allowlist ({@link https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md}).
 * Measured behaviour on claude.ai (2026-07-31, 36 renders):
 *
 * - absent      → renders fine, but the sandbox origin is freshly minted per
 *                 render (10 renders, 10 distinct origins), so nothing can
 *                 allowlist it
 * - correct     → renders, and the origin is stable across every render
 * - anything else → the host refuses to create the iframe at all (0/8 renders)
 *
 * So it is not a render gate — but a *wrong* value is fatal, and the easiest
 * way to get one is hashing a slightly different endpoint string than the URL
 * the connector was actually added with.
 */
import { createHash } from "node:crypto";

export const CLAUDE_DOMAIN_SUFFIX = ".claudemcpcontent.com";

/** Stable Claude origin for an MCP endpoint: sha256(url)[:32] + the suffix. */
export function computeAppDomainForClaude(mcpServerUrl: string): string {
  const hash = createHash("sha256").update(mcpServerUrl).digest("hex").slice(0, 32);
  return `${hash}${CLAUDE_DOMAIN_SUFFIX}`;
}

export type DomainVerdict =
  /** no _meta.ui.domain — renders, but the origin rotates every render */
  | { state: "absent" }
  /** matches sha256 of the endpoint we connected to */
  | { state: "match"; expected: string }
  /** present and wrong for this endpoint — Claude will not mount the iframe */
  | { state: "mismatch"; expected: string; got: string; nearMiss?: string }
  /** stdio target: no endpoint URL exists to hash, so nothing to verify */
  | { state: "no-endpoint"; got: string };

/**
 * Endpoint spellings that hash to something different but are easy to reach
 * for by accident. When one of these reproduces the server's value we can say
 * exactly which string it hashed instead of just "wrong".
 */
function endpointVariants(url: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string) => {
    if (value && value !== url && !out.some((v) => v.value === value)) out.push({ label, value });
  };

  add("with a trailing slash", url + "/");
  add("without the trailing slash", url.replace(/\/+$/, ""));
  add("with the scheme swapped", url.startsWith("https://")
    ? url.replace(/^https:/, "http:")
    : url.replace(/^http:/, "https:"));
  add("lowercased", url.toLowerCase());

  try {
    const u = new URL(url);
    add("without the path (origin only)", u.origin);
    add("with /mcp appended", u.origin + "/mcp");
    add("without the query string", u.origin + u.pathname);
  } catch {
    // not a parseable URL — the variants above are still worth reporting
  }
  return out;
}

/**
 * Compare a server's declared domain against the value Claude derives from
 * `endpoint`. `endpoint` is undefined for stdio targets.
 */
export function checkAppDomain(domain: unknown, endpoint: string | undefined): DomainVerdict {
  if (domain === undefined || domain === null || domain === "") return { state: "absent" };

  const got = String(domain);
  if (!endpoint) return { state: "no-endpoint", got };

  const expected = computeAppDomainForClaude(endpoint);
  if (got === expected) return { state: "match", expected };

  const hit = endpointVariants(endpoint).find((v) => computeAppDomainForClaude(v.value) === got);
  return { state: "mismatch", expected, got, nearMiss: hit?.label };
}
