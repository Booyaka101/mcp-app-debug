/**
 * mcp-app-debug — local debug host for MCP Apps.
 *
 * Renders an MCP server's app in a Playwright browser via the official
 * @modelcontextprotocol/ext-apps App Bridge (same double-iframe sandbox path
 * as spec-conformant clients), with a live protocol side panel and 7
 * automated PASS/FAIL diagnostics. Speaks both the 2025-11-25 and the
 * stateless 2026-07-28 MCP revisions (auto-negotiated via server/discover).
 */
import { Command, InvalidArgumentError } from "commander";
import { runHostConformance } from "./fixture-server.js";
import { runDebugHost } from "./host.js";
import { runProfiled } from "./profile-run.js";
import { PROFILE_NAMES } from "./profiles/index.js";

const program = new Command();

function collectHeader(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf(":");
  if (idx <= 0) {
    throw new InvalidArgumentError('expected "Name: value" (e.g. --header "Authorization: Bearer …")');
  }
  return { ...previous, [value.slice(0, idx).trim()]: value.slice(idx + 1).trim() };
}

program
  .name("mcp-app-debug")
  .description(
    "Debug host for MCP Apps: renders a server's app locally with full postMessage protocol visibility and automated diagnostics.",
  )
  .version(__APP_VERSION__)
  .argument(
    "[target...]",
    "MCP server URL (Streamable HTTP/SSE, e.g. http://localhost:3001/mcp), or with --stdio the server command line",
  )
  .option("--stdio", "target is a stdio server command (put it after --, e.g. --stdio -- npx -y my-server)")
  .option("--header <name:value>", "extra HTTP header, repeatable (e.g. \"Authorization: Bearer …\")", collectHeader, {})
  .option(
    "--protocol <revision>",
    "MCP protocol revision: auto | 2026-07-28 | 2025-11-25 (auto probes server/discover, falls back to initialize)",
    (value: string) => {
      if (!["auto", "2026-07-28", "2025-11-25"].includes(value)) {
        throw new InvalidArgumentError("must be one of: auto, 2026-07-28, 2025-11-25");
      }
      return value;
    },
    "auto",
  )
  .option(
    "--profile <name>",
    "host profile: spec | claude-desktop | claude-web | chatgpt | grok | all, or a path to a " +
      "descriptor .json — adds checks 8-10 and a fault-attribution verdict (non-spec profiles " +
      "run after a spec baseline)",
  )
  .option("--tool <name>", "tool to render (default: first tool declaring _meta.ui.resourceUri)")
  .option("--args <json>", "tool arguments as JSON object (default: inputSchema defaults)")
  .option(
    "--mode <mode>",
    "host capability mode: trusted | strict (also accepts '3p' as an alias of strict)",
    (value: string) => {
      if (!["trusted", "strict", "3p"].includes(value)) {
        throw new InvalidArgumentError("must be one of: trusted, strict, 3p");
      }
      return value;
    },
    "trusted",
  )
  .option("--timeout <seconds>", "observation window before checks are evaluated", (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 3) throw new InvalidArgumentError("must be a number >= 3");
    return n;
  }, 10)
  .option("--full-window", "always wait the full observation window (default: end 2 s after all checks pass)")
  .option("--json", "CI mode: print check results as compact JSON on stdout, exit 1 on failure (implies --headless)")
  .option("--headless", "run the browser headless")
  .option("--headed", "force a visible browser window (overrides the --json default)")
  .option("--no-interact", "do not auto-click a button in the app to provoke an app-initiated tools/call")
  .option("--click <text>", "button text to click inside the app after the handshake")
  .option("--screenshot <path>", "save a PNG of the debug window when checks complete")
  .option("--video <path>", "record the debug session to a .webm video file")
  .option("--log-file <path>", "write every protocol log entry as NDJSON (last line is the check report)")
  .addHelpText(
    "after",
    `
Checks (evaluated after the observation window):
  1. ui:// resource resolves   _meta.ui.resourceUri is valid and resources/read
                               returns one text/html;profile=mcp-app content
  2. CSP permits embedding     no CSP violations under the host policy built from
                               _meta.ui.csp; no frame-ancestors blocking embedding
  3. _meta.ui.domain origin    declared domain matches the origin derived from
                               this endpoint (mismatch is fatal on Claude)
  4. ui/initialize handshake   app's ui/initialize answered within 3 s of HTML injection
  5. ui/ready notification     ui/notifications/initialized within 5 s
  6. app-initiated tools/call  at least one tools/call FROM the app returned non-error
  7. protocol revision         negotiation succeeded cleanly; a 2026-07-28 server
                               implements server/discover (a MUST); reports whether
                               io.modelcontextprotocol/ui is advertised

Exit codes:
  0  all checks passed
  1  one or more checks failed (or the server exposes no MCP App at all)
  2  operational error (bad arguments, could not connect, browser failed)

Notes:
  --protocol auto (default) probes server/discover first (2026-07-28, stateless)
  and falls back to the 2025-11-25 initialize handshake — both revisions get the
  same 7 diagnostics. Forcing a revision the server does not support exits 2 and
  names what the server actually offers.

  '3p' is accepted for compatibility but deploymentMode does not exist in the MCP
  Apps SDK (verified against ext-apps 1.7.4); it maps to --mode strict, a host that
  advertises no optional capabilities — reproducing restrictive-host failures.

Grading a HOST instead of a server: mcp-app-debug host  (see: mcp-app-debug host --help)

Examples:
  npx mcp-app-debug http://localhost:3001/mcp
  npx mcp-app-debug http://localhost:3001/mcp --tool get-time --click "Get Server Time"
  npx mcp-app-debug http://localhost:3001/mcp --json | jq .
  npx mcp-app-debug http://localhost:3001/mcp --mode 3p
  npx mcp-app-debug http://localhost:3001/mcp --protocol 2026-07-28
  npx mcp-app-debug --header "Authorization: Bearer $TOKEN" https://api.example.com/mcp
  npx mcp-app-debug --stdio -- npx -y @acme/my-mcp-server
`,
  )
  .action(async (target: string[], options) => {
    const rawMode: string = options.mode;
    const mode = rawMode === "3p" ? "strict" : (rawMode as "trusted" | "strict");
    const modeNote =
      rawMode === "3p"
        ? "'3p' deploymentMode is not part of the MCP Apps spec/SDK — mapped to strict capability mode"
        : undefined;

    const fail = (msg: string): never => {
      program.error(msg, { exitCode: 2 });
      throw new Error(msg); // unreachable — program.error exits
    };

    let connect;
    if (options.stdio) {
      if (target.length === 0) {
        fail("error: --stdio requires a server command, e.g. mcp-app-debug --stdio -- npx -y my-server");
      }
      connect = { kind: "stdio" as const, command: target[0], args: target.slice(1) };
    } else {
      if (target.length === 0) fail("error: missing server URL (or use --stdio -- <command>)");
      if (target.length > 1) {
        fail(
          `error: expected one server URL, got ${target.length} arguments ` +
            `(${target.join(" ")}) — did you mean --stdio -- ${target.join(" ")}?`,
        );
      }
      const raw = target[0];
      if (!/^https?:\/\//i.test(raw)) {
        fail(
          `error: server URL must start with http:// or https:// — got "${raw}"` +
            (/^[\w.-]+(:\d+)?(\/|$)/.test(raw) ? `\nDid you mean: http://${raw}` : ""),
        );
      }
      try {
        new URL(raw);
      } catch {
        fail(`error: "${raw}" is not a valid URL`);
      }
      connect = { kind: "http" as const, url: raw, headers: options.header as Record<string, string> };
    }

    if (options.args !== undefined) {
      try {
        const parsed = JSON.parse(options.args);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          fail(`error: --args must be a JSON object, got ${JSON.stringify(parsed)}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) fail(`error: --args is not valid JSON: ${e.message}`);
        else throw e;
      }
    }

    if (options.profile !== undefined) {
      const p: string = options.profile;
      if (!PROFILE_NAMES.includes(p as never) && p !== "all" && !p.endsWith(".json")) {
        fail(
          `error: unknown profile "${p}" — valid names: ${PROFILE_NAMES.join(", ")}, all ` +
            "(or a path to a descriptor .json)",
        );
      }
    }

    const hostOpts = {
      connect,
      protocol: options.protocol,
      tool: options.tool,
      args: options.args,
      mode,
      modeNote,
      timeoutSec: options.timeout,
      fullWindow: Boolean(options.fullWindow),
      json: Boolean(options.json),
      headless: options.headed ? false : Boolean(options.headless || options.json),
      interact: options.interact !== false,
      click: options.click,
      screenshot: options.screenshot,
      video: options.video,
      logFile: options.logFile,
    };
    const exitCode = options.profile
      ? await runProfiled(hostOpts, options.profile)
      : await runDebugHost(hostOpts);
    process.exitCode = exitCode;
    // Flush stdout before hard exit — on Windows, process.exit() truncates
    // pending pipe writes, silently eating the --json output under npx.
    process.stdout.write("", () => process.exit(exitCode));
  });

/**
 * `mcp-app-debug host` — host-conformance mode. A separate Command instance,
 * dispatched by hand below: registering it as a subcommand would let the
 * program-level --json/--stdio options swallow the host flags (commander
 * recognises program options after a subcommand name by default), and the
 * default `mcp-app-debug <url>` command must stay byte-identical.
 */
const hostProgram = new Command();

hostProgram
  .name("mcp-app-debug host")
  .description(
    "Host-conformance mode: serve a conformant MCP Apps fixture server and grade the host that connects (7 PASS/FAIL/INCONCLUSIVE checks)",
  )
  .version(__APP_VERSION__)
  .option(
    "--port <n>",
    "HTTP port for the fixture server (Streamable HTTP at /mcp)",
    (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new InvalidArgumentError("must be a port number (1-65535)");
      }
      return n;
    },
    3111,
  )
  .option("--stdio", "serve the fixture over stdio instead, for hosts that spawn a command (the verdict then prints on stderr — stdout is the transport)")
  .option(
    "--window <seconds>",
    "observation window — how long to wait for the host",
    (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 3) throw new InvalidArgumentError("must be a number >= 3");
      return n;
    },
    120,
  )
  .option("--json", "CI mode: one final JSON report on stdout, no live chip output; ends early once every check resolves")
  .addHelpText(
    "after",
    `
The 7 host checks (each PASS / FAIL / INCONCLUSIVE — never a guess):
  1. client-advertises-ui        the client advertised io.modelcontextprotocol/ui
                                 (initialize capabilities.extensions, or the
                                 2026-07-28 clientCapabilities _meta envelope)
  2. ui-resource-read            resources/read arrived for the declared ui:// URI
  3. app-mounted                 the probe app's beacon arrived at all
  4. ui-initialize-answered      the host answered the app's ui/initialize
  5. tool-result-meta-preserved  the planted _meta.ui.probeToken reached the app
                                 inside the tool-result payload
  6. app-call-relayed            the app's own tools/call reached the server
  7. sandbox-origin-and-csp      distinct sandbox origin, no CSP violations

Exit codes:
  0  no check failed (inconclusive checks do not fail the run)
  1  one or more checks failed
  2  operational error (no client connected within --window, port in use, …)

Examples:
  mcp-app-debug host                      # wait on http://localhost:3111/mcp
  mcp-app-debug host --port 4000 --json   # CI verdict as JSON
  mcp-app-debug host --stdio              # for hosts that spawn a command
`,
  )
  .action(async (options) => {
    const exitCode = await runHostConformance({
      port: options.port,
      stdio: Boolean(options.stdio),
      windowSec: options.window,
      json: Boolean(options.json),
    });
    process.exitCode = exitCode;
    // Same Windows stdout-flush dance as scan mode.
    process.stdout.write("", () => process.exit(exitCode));
  });

const parsing =
  process.argv[2] === "host"
    ? hostProgram.parseAsync(process.argv.slice(3), { from: "user" })
    : program.parseAsync();
parsing.catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : e}\n`);
  process.exit(2);
});
