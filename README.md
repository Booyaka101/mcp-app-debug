# mcp-app-debug

**A local debug host for [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview).**
When your MCP App fails to render in Claude Desktop, you get *nothing* — no
error, no log, the iframe just never appears
([ext-apps #671](https://github.com/modelcontextprotocol/ext-apps/issues/671)).
`mcp-app-debug` renders your server's app in a local Playwright browser using
the **same App Bridge + double-iframe sandbox path** as spec-conformant
clients, shows **every postMessage exchange live in a side panel**, and gives
you **5 automated PASS/FAIL diagnostics** that tell you exactly where the flow
broke.

![all checks passing](https://raw.githubusercontent.com/Booyaka101/mcp-app-debug/main/demo/first-run.png)

A handshake failure that would be invisible in a real client looks like this —
green up to `app-html-written`, then silence, and three red chips telling you
what never happened:

![handshake timeout diagnosed](https://raw.githubusercontent.com/Booyaka101/mcp-app-debug/main/demo/handshake-timeout.png)

## Run it

```bash
npx mcp-app-debug http://localhost:3001/mcp
```

That's the whole setup — point it at your MCP server's Streamable HTTP
endpoint. On the very first run it downloads Chromium automatically
(one-time, ~150 MB, via Playwright's installer).

The browser window opens with your app on the left, the protocol log on the
right, and the check chips on top; it stays open for interactive debugging.
After the observation window (default 10 s) the checks print:

```
Results — server http://localhost:3001/mcp, tool get-time, mode trusted
  PASS  ui:// resource resolves        ui://get-time/mcp-app.html (text/html;profile=mcp-app, 530170 bytes)
  PASS  CSP permits embedding & assets no violations under the default host policy; no frame-ancestors restrictions
  PASS  ui/initialize handshake        handshake completed in 46 ms
  PASS  ui/ready notification          app signaled ready in 51 ms
  PASS  app-initiated tools/call       app called "get-time" → non-error result (1 app call(s) total)
  5/5 checks passed OK
```

## The 5 checks

1. **ui:// resource resolves** — the tool's `_meta.ui.resourceUri` is a valid
   `ui://` URI and `resources/read` returns exactly one
   `text/html;profile=mcp-app` content item.
2. **CSP permits embedding & assets** — the sandbox is served with the real
   HTTP `Content-Security-Policy` header a conformant host builds from your
   `_meta.ui.csp` (same policy construction as the official basic-host); any
   `securitypolicyviolation` fired while your app renders fails this check, as
   does a `frame-ancestors` directive in your HTML that would block embedding.
3. **ui/initialize handshake** — your app's `ui/initialize` request is answered
   within 3 s of HTML injection.
4. **ui/ready notification** — `ui/notifications/initialized` (the "ui/ready"
   signal) arrives within 5 s.
5. **app-initiated tools/call** — at least one `tools/call` *initiated by your
   app* returned a non-error result. After the handshake the harness simulates
   the LLM flow (`tool-input` → server call → `tool-result`) and then clicks
   the first button in your app (or the one you name with `--click <text>`) to
   provoke real app activity.

Beyond the checks, the log surfaces the evidence silent failures hide: app
`console.error`s, uncaught exceptions, failed network requests, CSP violation
details, and every JSON-RPC frame with direction and timing.

## CI usage

```bash
npx mcp-app-debug http://localhost:3001/mcp --json | jq .
```

Prints one compact JSON object (`passed`, `failed`, `checks[]` with `id`,
`title`, `pass`, `detail`, `ms`) on stdout and exits `1` if any check failed.
`--json` implies headless.

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
--tool <name>        tool to render (default: first tool with _meta.ui.resourceUri)
--args <json>        tool arguments (default: inputSchema defaults)
--mode <mode>        trusted | strict | 3p            (default: trusted)
--timeout <seconds>  observation window                (default: 10)
--json               CI mode: JSON on stdout, exit 1 on failure
--headless           headless browser; --headed forces a window
--click <text>       button text to click inside the app
--no-interact        don't auto-click anything
--screenshot <path>  save a PNG of the debug window
```

## Test fixtures

`test/broken-server.mjs` ships 8 scenarios (`ok`, `bad-uri`, `bad-mime`,
`no-ready`, `slow-init`, `tool-error`, `csp-meta`, `ext-img`) reproducing the
common silent-failure modes; `node test/run-scenarios.mjs` asserts each one
trips exactly the right checks (all 8 pass).

## Architecture

- Node CLI (`src/cli.ts`, commander) → `src/host.ts` Playwright harness.
- The MCP client (Streamable HTTP with SSE fallback,
  `@modelcontextprotocol/sdk`) lives in **Node**, so server CORS never causes
  false negatives; the page reaches it through a Playwright binding.
- The page (`src/web/host-page.ts`) runs the official
  `@modelcontextprotocol/ext-apps` **AppBridge** in manual-handler mode with a
  logging transport wrapped around `PostMessageTransport`.
- The sandbox (`src/web/sandbox-page.ts`) is a port of the official basic-host
  double-iframe sandbox, served on a separate origin with the CSP header built
  by the official policy logic, plus CSP-violation relay.

## Development

```bash
npm install
npm run build        # esbuild: node CLI bundle + 2 browser bundles
npm run typecheck    # tsc, types only
node dist/cli.js <server-url>
node test/run-scenarios.mjs   # 8 failure-mode scenarios, all must pass
```

A handy live target is the official example server:
`npx @modelcontextprotocol/server-basic-react` (serves on port 3001), then
`node dist/cli.js http://localhost:3001/mcp`.

Note for Windows tarball testing: give npx a **relative** path
(`npx ./mcp-app-debug-0.1.0.tgz`) — npx silently no-ops on absolute tarball
paths.

## License

MIT
