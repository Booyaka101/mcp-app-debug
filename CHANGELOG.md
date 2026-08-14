# Changelog

## 0.5.0 — 2026-08-14

**Host-conformance mode: `mcp-app-debug host` grades the other end of the
wire.**

Until now this tool graded servers. The mirror-image failure is a host or
agent framework that silently drops MCP Apps fields, so the app never renders
and nobody gets an error.
[pydantic-ai#6613](https://github.com/pydantic/pydantic-ai/issues/6613)
(opened 2026-07-20, still open at release time) enumerates it precisely:
tool-result `_meta` is discarded by `_map_mcp_tool_result`; `read_resource()`
loses the `text/html;profile=mcp-app` mimeType and the resource `_meta`
carrying sandbox security policies; and the hand-copied server-capability
field list drops `extensions` entirely, so `io.modelcontextprotocol/ui`
support can never be advertised. That reporter had to derive all of this by
hand; `mcp-app-debug host` prints the same verdict in one run.

The official ext-apps `debug-server` example covers adjacent ground but is a
manual dashboard (event log, callback-status table, action buttons) with no
PASS/FAIL verdict and no CI mode. MCPJam Inspector ships an MCP Apps
Conformance SDK, but — like this tool's scan mode until today — it grades
servers; its own docs say "This currently validates the server-side MCP Apps
surface only. It does not prove full host-side SEP-1865 behavior such as
`ui/initialize`, sandbox-proxy forwarding, or host notification ordering."
`host` mode is what covers that other end, from the outside: it observes what
the host does on the wire plus what the app can self-report from inside the
sandbox.

### Added

- **`mcp-app-debug host [--port 3111] [--stdio] [--window 120] [--json]`** —
  mcp-app-debug becomes a conformant MCP Apps *server* (both the 2025-11-25
  `initialize` handshake and the stateless 2026-07-28 `server/discover` path,
  advertising `io.modelcontextprotocol/ui` in `capabilities.extensions` on
  both) and grades whoever connects. One model-visible tool `probe` whose
  result carries `structuredContent` plus a planted `_meta.ui.probeToken`
  (random per run), one `ui://` resource with `_meta.ui` (csp + domain), one
  app-only `report` tool the probe app calls with what it saw — plus a direct
  HTTP beacon side channel, so a broken app→server relay is itself observable
  instead of blinding every other check.
- **7 host checks**, each PASS / FAIL / INCONCLUSIVE and never a guess:
  `client-advertises-ui` (FAIL is the pydantic-ai#6613 capabilities defect
  verbatim), `ui-resource-read`, `app-mounted`, `ui-initialize-answered`,
  `tool-result-meta-preserved` (FAIL is the `_map_mcp_tool_result` defect),
  `app-call-relayed` (a precondition of the two before it — when it fails
  without side-channel data they report INCONCLUSIVE, not FAIL), and
  `sandbox-origin-and-csp`.
- Exit codes: `0` no check failed (a host that never calls `probe` gets
  INCONCLUSIVEs, not fake FAILs), `1` one or more checks failed, `2`
  operational (no client connected within `--window`, port in use).
- Test fixtures: `test/fake-host.mjs`, a minimal conformant host (Playwright +
  the same double-iframe sandbox files the package ships) with `--drop`
  (omits `capabilities.extensions`, strips tool-result `_meta`) and
  `--list-only` modes. Five new suite scenarios, including a dogfood case
  where scan mode grades the fixture while the fixture grades scan mode —
  both directions must go 7/7 in one run.

### Unchanged by design

- `mcp-app-debug <server-url>` (scan mode) is byte-identical to 0.4.1 —
  verified by diffing `--json` output against a 0.4.1 baseline (only timing
  numbers differ). All 20 existing scenarios still pass.

## 0.4.1 — 2026-08-09

Security-only patch. No behaviour change, no API change — the CLI, its flags
and its output are byte-identical to 0.4.0.

Clears six advisories that reached us through
`@modelcontextprotocol/sdk@1.30.0`'s transitive tree. All are in-range patch
bumps of transitive packages; no direct dependency was moved:

| Package | Bump | Advisory |
| --- | --- | --- |
| `fast-uri` | 3.1.4 → 3.1.5 | [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) (high) — host confusion via a backslash authority introducer |
| `ip-address` | 10.2.0 → 10.4.0 | [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) (high) — leading-zero octets decoded as decimal, plus two SSRF / trust-boundary bypasses |
| `hono` | 4.12.31 → 4.13.0 | [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239) — ReDoS in the CORS middleware |
| `@hono/node-server` | 1.19.14 → 2.1.0 | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) — path traversal in `serve-static` on Windows via an encoded `%5C` |

The `@hono/node-server` major is **sanctioned upstream, not forced**: the SDK
declares `^1.19.9 || ^2.0.5`, so 2.x is a range it already supports, and 2.0.5
is where the traversal fix landed.

`npm audit` now reports **0 vulnerabilities**, and all 18 scenarios pass on
Ubuntu and Windows.

### Note on the delay

This fix sat merged-ready for three days because its CI run was caught in the
2026-08-06 GitHub Actions incident — the run sat *queued* and never started
(`Failed to resolve action download info: Service Unavailable`), so the PR
looked half-checked rather than blocked. Re-running it was all that was needed.

## 0.4.0 — 2026-08-05

**Dual-protocol: debug MCP Apps on both the 2025-11-25 and the 2026-07-28
spec revisions.**

The [2026-07-28 MCP revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
made the protocol stateless: the `initialize`/`notifications/initialized`
handshake is gone (every request carries its protocol version and client
capabilities in `_meta`), servers MUST implement the new `server/discover`
RPC, protocol-level sessions and the `Mcp-Session-Id` header are removed,
`Mcp-Method`/`Mcp-Name` headers are required on Streamable HTTP POSTs, and
every result carries a `resultType` field. mcp-app-debug ≤0.3.x pinned SDK v1
and failed at connect against migrated servers with a generic exit-2 message —
exactly the silent-failure class this tool exists to abolish.

### Added

- **2026-07-28 stateless support** via `@modelcontextprotocol/client@^2.0.0`
  alongside (not replacing) `@modelcontextprotocol/sdk` v1. On the stateless
  path every request carries the documented `_meta` envelope
  (`io.modelcontextprotocol/protocolVersion` / `clientCapabilities` with the
  `io.modelcontextprotocol/ui` extension / `clientInfo`), Streamable HTTP
  POSTs carry `Mcp-Method`/`Mcp-Name`, and results missing `resultType` are
  treated as `"complete"` per spec.
- **Auto-negotiation** (default): `server/discover` is probed first — the spec
  sanctions using it as a backward-compatibility probe — falling back to the
  v1 `initialize` handshake on `-32601`/legacy-shaped signals. On stdio the
  probe is time-boxed (5 s) so a server that crashes on unknown
  pre-initialize requests is treated as legacy. A server that rejects *both*
  `initialize` and `server/discover` but answers stateless requests (a
  half-migrated server) is still connected — via a synthetic prior-era
  verdict — so the remaining diagnostics can run.
- **`--protocol <auto|2026-07-28|2025-11-25>`**: force a revision; forcing one
  the server does not support exits 2 with a message naming what the server
  actually offers.
- **Check 7, "protocol revision"**: reports the negotiated revision, whether
  `server/discover` answered, and whether the server advertises
  `io.modelcontextprotocol/ui` in `capabilities.extensions`. FAILs when a
  server speaks 2026-07-28 but does not implement `server/discover` (a MUST).
  A 2025-11-25 server PASSes with a note (legitimate during the 12-month
  deprecation window). A `server/discover` result missing the required
  `ttlMs`/`cacheScope` fields is surfaced in the detail (the v2 client
  silently defaults them; a raw re-probe sees the wire truth).
- Test fixtures: `test/broken-server.mjs --stateless` serves a hand-rolled
  2026-07-28 stateless server (the official v2 *server* package is currently
  uninstallable — it depends on `@modelcontextprotocol/core-internal` which is
  not on the registry) implementing `server/discover`, rejecting `initialize`,
  stamping `resultType`/`ttlMs`/`cacheScope`, and enforcing the `Mcp-Method`
  header. New scenarios `discover-missing` and `no-ui-extension`. The suite
  now runs 20 cases: `ok`/`bad-uri`/`no-ready`/`tool-error` trip identical
  check ids under both revisions.

### Unchanged by design

- `@modelcontextprotocol/ext-apps` stays at `^1.7.4` (1.7.5 is the latest;
  there is no 2.x): AppBridge, PostMessageTransport, the double-iframe
  sandbox, and CSP policy construction are untouched by the spec revision.
- The 6 existing checks keep identical ids, titles and semantics on both
  paths, and `--json` keeps its exact shape (`passed`, `failed`, `checks[]`
  with `id`/`title`/`pass`/`detail`/`ms`) with one extra entry appended.
- The legacy path still runs on SDK v1, byte-identical to 0.3.x behaviour.

## 0.3.0 — 2026-07-31

- New check: **`_meta.ui.domain` origin** — verifies a declared domain against
  the origin derived from the endpoint
  (`sha256(<endpoint URL>)[:32] + ".claudemcpcontent.com"`), based on measured
  claude.ai behaviour (36-render A/B): a wrong value is fatal (0/8 mounts),
  an absent one is not (10/10 mounts, rotating sandbox origin). On mismatch,
  common endpoint misspellings (trailing slash, missing `/mcp`, wrong scheme)
  are re-hashed to name the likely culprit.

## 0.2.0 — 2026-07-27

- CI hardening: GitHub Actions on latest majors, Dependabot with grouped
  minors/patches, mcp-vet run against our own fixtures, allowlist drift gate.

## 0.1.0 — 2026-07-22

- Initial release: local debug host for MCP Apps — Playwright-rendered
  App Bridge + double-iframe sandbox, live postMessage protocol log,
  automated diagnostics, `--stdio`, `--header`, `--json` CI mode, `--video`,
  `--log-file`, Chromium auto-install.
