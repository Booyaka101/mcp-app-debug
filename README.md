# mcp-app-debug

**A local debug host for [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview).**
When your MCP App fails to render in Claude Desktop, you get *nothing* — no
error, no log, the iframe just never appears
([ext-apps #671](https://github.com/modelcontextprotocol/ext-apps/issues/671)).
`mcp-app-debug` renders your server's app in a local Playwright browser using
the **same App Bridge + double-iframe sandbox path** as spec-conformant
clients, shows **every postMessage exchange live in a side panel**, and gives
you **7 automated PASS/FAIL diagnostics** that tell you exactly where the flow
broke. When it renders on one host but not another, `--profile` adds three
cross-host checks and tells you **whether the fault is yours or the host's** —
see [Host profiles](#host-profiles-and-the-fault-verdict---profile). It speaks **both current MCP revisions** — the stateless 2026-07-28
protocol (`server/discover`, `_meta` envelopes) and the 2025-11-25
`initialize` handshake — and auto-detects which one your server is on.

It debugs **both ends of the wire**: `mcp-app-debug <server-url>` grades your
*server*, and `mcp-app-debug host` grades the *host* that connects to it —
see [Grade a host](#grade-a-host-host-conformance-mode).

![all checks passing against the official example server](https://raw.githubusercontent.com/Booyaka101/mcp-app-debug/main/demo/demo.gif)

A handshake failure that would be invisible in a real client looks like this —
green up to `app-html-written`, then silence, and three red chips telling you
what never happened:

![handshake timeout diagnosed](https://raw.githubusercontent.com/Booyaka101/mcp-app-debug/main/demo/demo-fail.gif)

## Run it

```bash
# HTTP server (Streamable HTTP, SSE fallback)
npx mcp-app-debug http://localhost:3001/mcp

# stdio server — everything after -- is the server command line
npx mcp-app-debug --stdio -- npx -y @acme/my-mcp-server

# server behind auth
npx mcp-app-debug --header "Authorization: Bearer $TOKEN" https://api.example.com/mcp
```

That's the whole setup. On the very first run it downloads Chromium
automatically (one-time, ~150 MB, via Playwright's installer).

The browser window opens with your app on the left, the protocol log on the
right, and the check chips on top; it stays open for interactive debugging.
Once every check has passed (or at the end of the observation window, default
10 s) the verdict prints:

```
Results — server http://localhost:3001/mcp, tool get-time, mode trusted
  PASS  ui:// resource resolves        ui://get-time/mcp-app.html (text/html;profile=mcp-app, 530170 bytes)
  PASS  CSP permits embedding & assets no violations under the default host policy; no frame-ancestors restrictions
  PASS  _meta.ui.domain origin         matches the origin derived from this endpoint (9cdad008…claudemcpcontent.com)
  PASS  ui/initialize handshake        handshake completed in 46 ms
  PASS  ui/ready notification          app signaled ready in 51 ms
  PASS  app-initiated tools/call       app called "get-time" → non-error result (1 app call(s) total)
  PASS  protocol revision              negotiated 2025-11-25 via initialize (legacy path); server/discover not implemented (legitimate during the 12-month deprecation window)
  7/7 checks passed OK
```

## The 7 checks

1. **ui:// resource resolves** — the tool's `_meta.ui.resourceUri` is a valid
   `ui://` URI and `resources/read` returns exactly one
   `text/html;profile=mcp-app` content item.
2. **CSP permits embedding & assets** — the sandbox is served with the real
   HTTP `Content-Security-Policy` header a conformant host builds from your
   `_meta.ui.csp` (same policy construction as the official basic-host); any
   `securitypolicyviolation` fired while your app renders fails this check, as
   does a `frame-ancestors` directive in your HTML that would block embedding.
3. **`_meta.ui.domain` origin** — if your resource declares a domain, it must
   match the origin the host derives from your endpoint
   (`sha256(<endpoint URL>)[:32] + ".claudemcpcontent.com"` on Claude). Getting
   this *wrong* is fatal — Claude declines to mount the iframe at all — while
   omitting it is harmless for rendering but means the sandbox origin is minted
   fresh on every render, so an API server can't allowlist it. When the value
   you sent is the hash of a near-miss endpoint spelling (a stray trailing
   slash, a missing `/mcp`, the wrong scheme), the check names which one.
4. **ui/initialize handshake** — your app's `ui/initialize` request is answered
   *successfully* within 3 s of HTML injection. A JSON-RPC error reply is a FAIL
   naming the rejected field: `appInfo` and `appCapabilities` are both required
   in the params, and an app that fires `ui/notifications/initialized` without
   awaiting the reply runs on through a rejection, so checks 5 and 6 can still
   look healthy while a real client has no connected app.
5. **ui/ready notification** — `ui/notifications/initialized` (the "ui/ready"
   signal) arrives within 5 s.
6. **app-initiated tools/call** — at least one `tools/call` *initiated by your
   app* returned a non-error result. After the handshake the harness simulates
   the LLM flow (`tool-input` → server call → `tool-result`) and then clicks
   the first button in your app (or the one you name with `--click <text>`) to
   provoke real app activity.
7. **protocol revision** — the protocol negotiation succeeded cleanly. Reports
   which revision was negotiated, whether `server/discover` answered, and
   whether the server advertises `io.modelcontextprotocol/ui` in
   `capabilities.extensions`. FAILs when a server speaks 2026-07-28 but does
   not implement `server/discover` (a MUST in that revision). A 2025-11-25
   server passes with a note — legitimate during the 12-month deprecation
   window.

Beyond the checks, the log surfaces the evidence silent failures hide: app
`console.error`s, uncaught exceptions, failed network requests, CSP violation
details, and every JSON-RPC frame with direction and timing.

## Host profiles and the fault verdict (`--profile`)

When an app renders on one host and breaks on another, the first question is
whether the bug is yours.
[ext-apps #750](https://github.com/modelcontextprotocol/ext-apps/issues/750)
is the shape of it: the same resource renders on ChatGPT and Claude but goes
stale, hangs or duplicates on Grok.
[ext-apps #671](https://github.com/modelcontextprotocol/ext-apps/issues/671)
is the same question from the other side — "the tool runs and returns
normally, but no iframe mounts". The seven checks above are all mount-time and
single-widget, so they cannot tell those apart. `--profile` can.

```bash
npx mcp-app-debug http://localhost:8787/mcp --profile spec      # normative baseline
npx mcp-app-debug http://localhost:8787/mcp --profile grok      # spec, then grok
npx mcp-app-debug http://localhost:8787/mcp --profile all       # the divergence matrix
npx mcp-app-debug http://localhost:8787/mcp --profile all --json
```

A profile is a descriptor of the **observable knobs** a host applies — sandbox
tokens, CSP directives, whether popups are allowed, whether `tool-result` is
redelivered after a state change, how many concurrent instances mount, and
whether `_meta.ui.domain` is enforced. Naming a non-spec profile runs the spec
baseline first, so the verdict is always computable.

> **Only `spec` is normative.** It mirrors the
> [2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
> and ext-apps 1.7.x defaults (strict CSP with no `unsafe-eval`, since
> `AppOptions.allowUnsafeEval` defaults to `false` in
> [v1.7.0](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v1.7.0);
> `object-src` synced with `default-src` per
> [v1.7.5](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v1.7.5)).
> The `claude-desktop`, `claude-web`, `chatgpt` and `grok` profiles are
> **community-observed reports, not vendor documentation**. Nobody from those
> vendors publishes these knobs; each one is derived from a public issue or an
> SDK release, and every descriptor must cite its sources — a descriptor with
> an empty `sources` array is refused at load time. They are a way to
> reproduce a reported symptom locally, not a claim about what any vendor's
> host does today. This tool still does not claim to verify host compliance
> with SEP-1865. Read `src/profiles/*.json`; they are short, and you can pass
> your own descriptor path instead of a built-in name.

### Checks 8-10 (profile mode only)

8. **tool-result redelivery** — a second `tools/call` with *different*
   arguments goes through the same connection to the already-mounted app.
   PASS when a second `tool-result` reaches it. This is #750's symptom 1:
   the widget showing a completed transaction as still pending.
   `SKIP`s honestly when the tool takes no arguments to vary.
9. **multi-instance isolation** — the same view is mounted **twice in one
   page**. PASS needs two distinct `ui/initialize` handshakes *and* zero
   postMessages crossing between them (each instance's `tool-result` carries
   its own `_meta` marker, so leakage is visible on the wire). `SKIP`s when
   the server returns a singleton `ui://` resource that cannot be read twice.
10. **external navigation** — `window.open` and a `target=_blank` click from
    inside the sandbox. `INFO` under spec (the sandbox has no `allow-popups`,
    so blocking is correct and worth *recording*, not failing). It only FAILs
    when the active profile grants popups and navigation is blocked anyway,
    and it distinguishes a sandbox-level block from a browser-level one.

The verdict then attributes fault:

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `APP-FAULT` | a check fails under **spec** — fix your app before blaming a host | 1 |
| `APP-OK-HOST-SUSPECT` | passes under spec, fails under a named profile — the divergence is host-side | 0 |
| `APP-OK` | everything passes everywhere it ran | 0 |

### Real run against a third-party server

Captured output, not hand-written: this is `--profile all` against
[primevalsoup/mcp-apps-claude-demo](https://github.com/primevalsoup/mcp-apps-claude-demo),
the minimal cross-host demo #750 cites as working, cloned and served locally on
port 8787.

```
                                  spec            claude-desktop  claude-web      chatgpt         grok
1 ui:// resource resolves         PASS            PASS            PASS            PASS            PASS
2 CSP permits embedding & assets  PASS            PASS            PASS            PASS            PASS
3 _meta.ui.domain origin          FAIL            FAIL            FAIL            INFO            INFO
4 ui/initialize handshake         PASS            PASS            PASS            PASS            PASS
5 ui/ready notification           PASS            PASS            PASS            PASS            PASS
6 app-initiated tools/call        FAIL            FAIL            FAIL            FAIL            FAIL
7 protocol revision               PASS            PASS            PASS            PASS            PASS
8 tool-result redelivery          SKIP            SKIP            SKIP            SKIP            SKIP
9 multi-instance isolation        PASS            PASS            PASS            PASS            PASS
10 external navigation            INFO            INFO            INFO            INFO            INFO

VERDICT: APP-FAULT — _meta.ui.domain origin, app-initiated tools/call fail(s) under the spec profile; fix the app/server before suspecting any host
```

Row 3 is the whole point of the matrix: the same observation is a FAIL on the
Claude profiles and an INFO on `chatgpt`/`grok`, because only Claude hosts are
reported to derive that value. Read the detail line and the reason is concrete
rather than mysterious:

```
FAIL   3 _meta.ui.domain origin  declared "187f71d263d6cc8b3a92ca14ca4055b2.claudemcpcontent.com" but this
                                 endpoint derives "1e7037d0e74fbc84d7746b9da9adb5bc.claudemcpcontent.com" —
                                 that value is the hash of the same URL with the scheme swapped; recompute it
                                 from the exact URL the connector was added with.
SKIP   8 tool-result redelivery  tool is not argument-sensitive — it has no input property to vary between calls
INFO  10 external navigation     blocked by sandbox (no allow-popups) — window.open blocked, target=_blank blocked
```

Both spec failures are honest and specific to running it *locally*. That demo
computes its domain from `https://<host>/mcp` because it is meant to sit behind
an HTTPS tunnel, while this run reached it over plain `http://localhost:8787`
— so check 3 correctly reports a scheme-swap near miss that would not occur
behind the tunnel. Its `get_stats` widget is a static bar chart with no button,
so nothing provokes an app-initiated `tools/call` (check 6) and there is no
argument to vary (check 8 SKIPs rather than inventing a failure). None of this
is a defect in that demo; it is what running a tunnel-shaped server on
localhost actually looks like, and the tool says so in words you can act on.

Here is the same thing against a fixture where every check resolves — note the
two instances mounted side by side for check 9, the redelivery probe in the
log, and the chips for checks 8-10 along the top:

![profile mode: ten checks, two mounted instances, redelivery probe in the log](https://raw.githubusercontent.com/Booyaka101/mcp-app-debug/main/demo/profile-spec.png)

### `--json` for an issue report

`--profile … --json` emits `{verdict, profile, matrix, evidence[]}`, shaped so
you can paste it straight into an ext-apps issue. `matrix.cells[row][col]`
follows `matrix.checks` × `matrix.profiles`, and each `evidence` entry carries
the observation plus the raw protocol frames behind it:

```json
{"verdict":"APP-OK-HOST-SUSPECT","profile":"grok",
 "matrix":{"checks":["resource-uri","csp","ui-domain","ui-initialize","ui-ready","tool-call",
                     "protocol-revision","tool-result-redelivery","multi-instance-isolation","external-navigation"],
           "profiles":["spec","grok"],
           "cells":[["PASS","PASS"],["PASS","PASS"],["PASS","PASS"],["PASS","PASS"],["PASS","PASS"],
                    ["PASS","PASS"],["PASS","PASS"],["PASS","FAIL"],["PASS","PASS"],["INFO","INFO"]]},
 "evidence":[{"check":"tool-result-redelivery","profile":"spec",
              "observation":"PASS: second tool-result observed after 7ms (city: \"Tokyo-2\")","timestampMs":7,
              "rawMessages":["+946ms server event tools/call (redelivery probe) {\"city\":\"Tokyo-2\"}", "…"]},
             {"check":"tool-result-redelivery","profile":"grok",
              "observation":"FAIL: app received tool-result #1 but the grok profile models a host that does not redeliver tool-result after further tools/call (ext-apps#750 symptom 1) — the app is left showing stale state",
              "timestampMs":null,"rawMessages":["…"]}]}
```

With `--profile all`, `--video`, `--screenshot` and `--log-file` are written
once per profile, suffixed with the profile name
(`session.spec.webm`, `session.grok.webm`, …).

## Grade a host (`host` conformance mode)

The mirror image of a broken server is a **host or agent framework that
silently drops MCP Apps fields** — the app never renders and nobody gets an
error. [pydantic-ai#6613](https://github.com/pydantic/pydantic-ai/issues/6613)
is the canonical case: tool-result `_meta` discarded, `read_resource()` losing
the `text/html;profile=mcp-app` mimeType and the resource `_meta` that carries
sandbox security policies, and the `extensions` capability field dropped so
`io.modelcontextprotocol/ui` support can never be advertised. The reporter had
to derive all of that by hand; this mode prints the verdict in one run.

```bash
npx mcp-app-debug host              # fixture serves http://localhost:3111/mcp
npx mcp-app-debug host --json       # CI verdict as one JSON object
npx mcp-app-debug host --stdio      # for hosts that spawn a server command
```

mcp-app-debug becomes a **conformant MCP Apps server** (both protocol
revisions, `io.modelcontextprotocol/ui` advertised on both) and grades
whoever connects. Point the host you want to test at the printed URL and ask
it to run the `probe` tool. The probe app that renders inside the host
self-reports what it received; the fixture combines that with what it saw on
the wire into 7 checks, each **PASS / FAIL / INCONCLUSIVE — never a guess**:

1. **client-advertises-ui** — the client's capabilities contain
   `io.modelcontextprotocol/ui` (2025-11-25: `initialize`
   `params.capabilities.extensions`; 2026-07-28: the
   `io.modelcontextprotocol/clientCapabilities` `_meta` envelope). FAIL is
   the pydantic-ai#6613 capabilities defect verbatim.
2. **ui-resource-read** — a `resources/read` for the declared `ui://` URI
   arrived.
3. **app-mounted** — the probe app's beacon arrived at all. If check 2 passed
   and this fails, the host most likely dropped the
   `text/html;profile=mcp-app` mimeType or refused to mount the iframe.
4. **ui-initialize-answered** — the host answered the app's `ui/initialize`
   with a result (self-reported, with latency). An error reply is a FAIL naming
   the code and message, not an answer.
5. **tool-result-meta-preserved** — the planted `_meta.ui.probeToken` (a
   random hex string minted per run) reached the app inside the `tool-result`
   payload. FAIL is the `_map_mcp_tool_result` defect.
6. **app-call-relayed** — the `report` call itself proves the host relays
   app→server `tools/call`. It is a precondition of checks 4 and 5, so when
   it fails and the direct beacon brought no data either, those two report
   INCONCLUSIVE, never FAIL.
7. **sandbox-origin-and-csp** — the app runs on a distinct sandbox origin
   (`window.top` unreachable) and no `securitypolicyviolation` fired.

A host that drops `capabilities.extensions` and strips tool-result `_meta`
(reproduce it with `node test/fake-host.mjs <url> --drop`) gets:

```
{"mode":"host","fixture":"http://localhost:3111/mcp","passed":5,"failed":2,"inconclusive":0,"checks":[
 {"id":"client-advertises-ui","verdict":"fail","pass":false,"detail":"client capabilities carried no extensions map; io.modelcontextprotocol/ui was never advertised (pydantic-ai#6613 shape)"},
 {"id":"ui-resource-read","verdict":"pass","pass":true,"detail":"resources/read ui://mcp-app-debug/probe.html at +16 ms"},
 {"id":"app-mounted","verdict":"pass","pass":true,"detail":"beacon received at +168 ms (via direct beacon)"},
 {"id":"ui-initialize-answered","verdict":"pass","pass":true,"detail":"answered in 1 ms"},
 {"id":"tool-result-meta-preserved","verdict":"fail","pass":false,"detail":"planted _meta.ui.probeToken ff90… did not reach the app; the host dropped tool-result _meta"},
 {"id":"app-call-relayed","verdict":"pass","pass":true,"detail":"1 app-initiated tools/call"},
 {"id":"sandbox-origin-and-csp","verdict":"pass","pass":true,"detail":"origin http://127.0.0.1:64822; no violations"}]}
```

and exit code 1 (`title` fields elided here for width). A fully conformant
host goes 7/7 with exit 0 — scan mode itself is one: `mcp-app-debug host` in
one terminal and `mcp-app-debug http://localhost:3111/mcp` in another go 7/7
in *both* directions, and the test suite asserts exactly that.

Behaviour at the edges: if **no client connects** within `--window` (default
120 s in host mode) the run exits 2 with "no client connected" — never a fake
FAIL. A host that connects and lists tools but **never calls `probe`** gets
checks 2-7 INCONCLUSIVE ("the host never called the tool — ask it to run
`probe`") and exit 0. Text mode prints checks as they resolve and keeps
serving until the window ends or Ctrl-C; `--json` prints a single final
object, no interactive output, and ends early once every check resolves. In
`--stdio` mode the verdict prints on stderr (stdout is the transport).

**What this can and cannot see.** Host mode observes only what the host does
on the wire plus what the probe app can self-report from inside the sandbox.
It cannot inspect the host's code, and a failing check means *a field did not
arrive*, not that a specific function is at fault. It does not claim to
verify SEP-1865 host compliance — it claims exactly the seven observations
above. A host that reads the resource over a transport the fixture cannot see
(native or in-process, without touching the fixture's endpoint) is out of
scope. For context: the official ext-apps `debug-server` example is a manual
dashboard with no verdict, and MCPJam Inspector's Apps Conformance SDK —
per its own docs — "currently validates the server-side MCP Apps surface
only. It does not prove full host-side SEP-1865 behavior such as
`ui/initialize`, sandbox-proxy forwarding, or host notification ordering."
Host mode exists to cover that other end.

Host-mode options:

```
--port <n>           fixture port, Streamable HTTP at /mcp   (default: 3111)
--stdio              serve the fixture over stdio (verdict on stderr)
--window <seconds>   how long to wait for the host           (default: 120)
--json               CI mode: one JSON report on stdout, ends early
```

## CI usage

```bash
npx mcp-app-debug http://localhost:3001/mcp --json | jq .
```

Prints one compact JSON object (`passed`, `failed`, `checks[]` with `id`,
`title`, `pass`, `detail`, `ms`) on stdout and exits `1` if any check failed.
`--json` implies headless. Runs end early once all checks have passed and
stayed passed for 2 s (pass `--full-window` to always wait the whole window).

Exit codes: `0` all checks passed · `1` one or more checks failed ·
`2` operational error (bad arguments, connection failed, browser failed).

For CI artifacts, `--log-file debug.ndjson` writes every protocol log entry
as NDJSON (final line is the check report) and `--video session.webm`
records the debug window — attach either to a bug report.

## Protocol support

The [2026-07-28 MCP revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
removed the `initialize` handshake entirely: servers are stateless, advertise
themselves via the new `server/discover` RPC, and expect every request to
carry its protocol version and client capabilities in `_meta` (plus
`Mcp-Method`/`Mcp-Name` headers on Streamable HTTP POSTs). mcp-app-debug
speaks both this and the 2025-11-25 revision:

- **auto (default)** — `server/discover` is probed first (the spec sanctions
  it as a backward-compatibility probe). A definitive answer selects the
  stateless 2026-07-28 path; `-32601`/legacy-shaped signals fall back to the
  `initialize` handshake. On stdio the probe is time-boxed at 5 s so a server
  that crashes on unknown pre-initialize requests is treated as legacy —
  the log says so when that happens.
- **`--protocol 2026-07-28`** / **`--protocol 2025-11-25`** — force a
  revision. If the server does not support the forced revision, the run exits
  `2` with a message naming what the server actually offers.
- **Half-migrated servers** — a server that rejects both `initialize` *and*
  `server/discover` but answers stateless 2026-07-28 requests still gets
  debugged (the harness connects via a synthetic era verdict); check 7 then
  FAILs, because `server/discover` is a MUST:

  ```
  FAIL  protocol revision  server claims 2026-07-28 (stateless requests succeed) but server/discover returned -32601 Method not found — the 2026-07-28 revision makes server/discover a MUST
  ```

On the stateless path every request carries the documented `_meta` envelope
(`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities` advertising
the `io.modelcontextprotocol/ui` extension with
`mimeTypes: ["text/html;profile=mcp-app"]`, `…/clientInfo`), results missing
`resultType` are treated as `"complete"` per spec, and a `server/discover`
result missing the required `ttlMs`/`cacheScope` fields is surfaced in check
7's detail rather than crashing the run. Everything downstream of the
connection — App Bridge, sandbox, CSP construction — is identical on both
paths (`@modelcontextprotocol/ext-apps` is unchanged by the revision).

## Reproducing restrictive-host failures (`--mode`)

```bash
npx mcp-app-debug http://localhost:3001/mcp --mode strict   # or: --mode 3p
```

`strict` runs the host with **no optional capabilities** (empty
`hostCapabilities` in the `ui/initialize` response, no
tools/resources/openLinks/message handlers). Apps that assume a full-featured
host fail here the same way they fail in restrictive clients — you'll see your
app's `tools/call` rejected with `-32601 Method not found` in the log while
everything else looks healthy.

> Honesty note: the `deploymentMode: '3p'` setting circulating in some issue
> threads **does not exist** in `@modelcontextprotocol/ext-apps` (verified
> against v1.7.4, including the generated protocol schema). `--mode 3p` is
> accepted as an alias of `strict` and says so in the output.

## All options

```
--stdio              target is a stdio server command (write it after --)
--header <n:v>       extra HTTP header, repeatable ("Authorization: Bearer …")
--protocol <rev>     auto | 2026-07-28 | 2025-11-25   (default: auto)
--profile <name>     spec | claude-desktop | claude-web | chatgpt | grok | all
                     (or a path to your own descriptor .json) — adds checks
                     8-10 and the fault verdict; omit for the 7-check run
--tool <name>        tool to render (default: first tool with _meta.ui.resourceUri)
--args <json>        tool arguments (default: inputSchema defaults)
--mode <mode>        trusted | strict | 3p            (default: trusted)
--timeout <seconds>  observation window                (default: 10)
--full-window        wait the whole window even after all checks pass
--json               CI mode: JSON on stdout, exit 1 on failure
--headless           headless browser; --headed forces a window
--click <text>       button text to click inside the app
--no-interact        don't auto-click anything
--screenshot <path>  save a PNG of the debug window
--video <path>       record the session to a .webm file
--log-file <path>    write the protocol log as NDJSON (last line = report)
```

## Test fixtures

`test/broken-server.mjs` ships 9 scenarios (`ok`, `bad-uri`, `bad-mime`,
`no-ready`, `slow-init`, `tool-error`, `csp-meta`, `ext-img`, `bad-domain`)
reproducing the common silent-failure modes, servable over HTTP or stdio
(`--stdio`), with optional auth (`AUTH_TOKEN=x` demands a Bearer token).
With `--stateless` it serves the 2026-07-28 revision instead — a hand-rolled
stateless server implementing `server/discover`, rejecting `initialize` and
stamping `resultType`/`ttlMs`/`cacheScope` — including two revision-specific
scenarios, `discover-missing` and `no-ui-extension`. For host mode,
`test/fake-host.mjs` is a minimal conformant host (Playwright + the same
double-iframe sandbox files the package ships) with `--drop` (the
pydantic-ai#6613 shape: no `capabilities.extensions`, tool-result `_meta`
stripped) and `--list-only` modes.

For profile mode, `test/profile-server.mjs` ships six scenarios (HTTP or
`--stdio`): `weather` (an argument-sensitive tool, so checks 8-10 all
resolve), `first-only` (the varied second call errors — check 8 FAILs),
`leak` (a view that broadcasts its tool-result to sibling instances through a
shared storage key — check 9 FAILs), `popup` (a view that calls `window.open`
on load), `noargs` (nothing to vary — check 8 must SKIP, not fail) and
`singleton` (the `ui://` resource can only be read once — check 9 must SKIP).
`test/profiles/` holds descriptor fixtures, including one with `sources: []`
that must be refused at load and one that claims `popupsAllowed` while
withholding the `allow-popups` token, which check 10 must catch and blame on
the sandbox.

`test/checks-unit.ts` asserts the checks 8-10 decision logic directly, for the
branches a real browser cannot force reliably — a browser-level popup block as
opposed to a sandbox-level one, or a second instance that mounts but never
completes its handshake. Those are exactly the branches whose wording a user
acts on, so they are tested rather than left unexecuted.

`npm test` asserts every scenario trips exactly the right checks on its
revision (the shared scenarios trip identical check ids on both), plus
strict-mode, stdio (both revisions), forced-`--protocol`, five host-mode cases
and thirteen profile cases — a `--profile all` matrix snapshot, both honest
SKIPs, profile-over-stdio, and per-profile artifact suffixing — for 40
assertions, plus 22 unit assertions. All green in CI on Linux and Windows.

## Architecture

- Node CLI (`src/cli.ts`, commander) → `src/host.ts` Playwright harness.
- The MCP client lives in **Node**, so server CORS never causes false
  negatives; the page reaches it through a Playwright binding. Connections
  are negotiated in `src/mcp/negotiate.ts` and served through one
  era-agnostic interface (`McpConn`, `src/mcp/connect.ts`) with two
  implementations: `@modelcontextprotocol/sdk` v1 for 2025-11-25
  (Streamable HTTP with SSE fallback, or stdio) and
  `@modelcontextprotocol/client` v2 for stateless 2026-07-28.
- The page (`src/web/host-page.ts`) runs the official
  `@modelcontextprotocol/ext-apps` **AppBridge** in manual-handler mode with a
  logging transport wrapped around `PostMessageTransport`.
- The sandbox (`src/web/sandbox-page.ts`) is a port of the official basic-host
  double-iframe sandbox, served on a separate origin with the CSP header built
  by the official policy logic, plus CSP-violation relay. A frame's sandbox
  flags are fixed when its browsing context is created, so when a profile
  overrides the tokens the inner iframe is replaced rather than mutated in
  place — `setAttribute("sandbox", …)` on a live frame is silently ignored.
- Profiles (`src/profiles/`) are plain JSON validated with zod at load time and
  shipped in the package; `src/profile-run.ts` runs the scan once per
  descriptor and computes the verdict.

## Development

```bash
npm install
npm run build        # esbuild: node CLI bundle + 2 browser bundles
npm run typecheck    # tsc, types only
node dist/cli.js <server-url>
npm test             # 40 assertions + 22 unit assertions, all must pass
```

A handy live target is the official example server:
`npx @modelcontextprotocol/server-basic-react` (serves on port 3001), then
`node dist/cli.js http://localhost:3001/mcp`.

Note for Windows tarball testing: give npx a **relative** path
(`npx ./mcp-app-debug-0.1.0.tgz`) — npx silently no-ops on absolute tarball
paths.

## License

MIT
