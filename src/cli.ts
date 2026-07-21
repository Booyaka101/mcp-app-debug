/**
 * mcp-app-debug — local debug host for MCP Apps.
 *
 * Renders an MCP server's app in a Playwright browser via the official
 * @modelcontextprotocol/ext-apps App Bridge (same double-iframe sandbox path
 * as spec-conformant clients), with a live protocol side panel and 5
 * automated PASS/FAIL diagnostics.
 */
import { Command, InvalidArgumentError } from "commander";
import { runDebugHost } from "./host.js";

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
  3. ui/initialize handshake   app's ui/initialize answered within 3 s of HTML injection
  4. ui/ready notification     ui/notifications/initialized within 5 s
  5. app-initiated tools/call  at least one tools/call FROM the app returned non-error

Exit codes:
  0  all checks passed
  1  one or more checks failed (or the server exposes no MCP App at all)
  2  operational error (bad arguments, could not connect, browser failed)

Notes:
  '3p' is accepted for compatibility but deploymentMode does not exist in the MCP
  Apps SDK (verified against ext-apps 1.7.4); it maps to --mode strict, a host that
  advertises no optional capabilities — reproducing restrictive-host failures.

Examples:
  npx mcp-app-debug http://localhost:3001/mcp
  npx mcp-app-debug http://localhost:3001/mcp --tool get-time --click "Get Server Time"
  npx mcp-app-debug http://localhost:3001/mcp --json | jq .
  npx mcp-app-debug http://localhost:3001/mcp --mode 3p
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

    const exitCode = await runDebugHost({
      connect,
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
    });
    process.exitCode = exitCode;
    // Flush stdout before hard exit — on Windows, process.exit() truncates
    // pending pipe writes, silently eating the --json output under npx.
    process.stdout.write("", () => process.exit(exitCode));
  });

program.parseAsync().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : e}\n`);
  process.exit(2);
});
