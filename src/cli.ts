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

program
  .name("mcp-app-debug")
  .description(
    "Debug host for MCP Apps: renders a server's app locally with full postMessage protocol visibility and automated diagnostics.",
  )
  .version("0.1.0")
  .argument("<server-url>", "MCP server URL (Streamable HTTP, e.g. http://localhost:3001/mcp)")
  .option("--tool <name>", "tool to render (default: first tool declaring _meta.ui.resourceUri)")
  .option("--args <json>", "tool arguments as JSON (default: inputSchema defaults)")
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
  .option("--json", "print check results as compact JSON on stdout, exit 1 on failure (implies --headless)")
  .option("--headless", "run the browser headless")
  .option("--headed", "force a visible browser window (overrides the --json default)")
  .option("--no-interact", "do not auto-click a button in the app to provoke an app-initiated tools/call")
  .option("--click <text>", "button text to click inside the app after the handshake")
  .option("--screenshot <path>", "save a PNG of the debug window when checks complete")
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

Notes:
  '3p' is accepted for compatibility but deploymentMode does not exist in the MCP
  Apps SDK (verified against ext-apps 1.7.4); it maps to --mode strict, a host that
  advertises no optional capabilities — reproducing restrictive-host failures.

Examples:
  npx mcp-app-debug http://localhost:3001/mcp
  npx mcp-app-debug http://localhost:3001/mcp --tool get-time --click "Get Server Time"
  npx mcp-app-debug http://localhost:3001/mcp --json | jq .
  npx mcp-app-debug http://localhost:3001/mcp --mode 3p
`,
  )
  .action(async (serverUrl: string, options) => {
    const rawMode: string = options.mode;
    const mode = rawMode === "3p" ? "strict" : (rawMode as "trusted" | "strict");
    const modeNote =
      rawMode === "3p"
        ? "'3p' deploymentMode is not part of the MCP Apps spec/SDK — mapped to strict capability mode"
        : undefined;

    const exitCode = await runDebugHost({
      serverUrl,
      tool: options.tool,
      args: options.args,
      mode,
      modeNote,
      timeoutSec: options.timeout,
      json: Boolean(options.json),
      headless: options.headed ? false : Boolean(options.headless || options.json),
      interact: options.interact !== false,
      click: options.click,
      screenshot: options.screenshot,
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
