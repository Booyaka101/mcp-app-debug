# Changelog

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
