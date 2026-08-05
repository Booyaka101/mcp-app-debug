/**
 * Scenario test runner: for each broken-server scenario, assert that
 * mcp-app-debug --json flags exactly the right checks — on BOTH protocol
 * revisions (2025-11-25 legacy fixtures and 2026-07-28 stateless fixtures).
 *
 * Usage: node test/run-scenarios.mjs
 */
import { spawn, execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// scenario → { mustFail: [...check ids], mustPass: [...check ids],
//              detailContains?: { checkId: substring } }
const EXPECTATIONS = {
  ok: {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "negotiated 2025-11-25 via initialize" },
  },
  "bad-uri": { mustFail: ["resource-uri"], mustPass: ["protocol-revision"] },
  "bad-mime": { mustFail: ["resource-uri"], mustPass: ["protocol-revision"] },
  "no-ready": { mustFail: ["ui-initialize", "ui-ready", "tool-call"], mustPass: ["resource-uri", "protocol-revision"] },
  "slow-init": { mustFail: ["ui-initialize"], mustPass: ["ui-ready", "resource-uri", "protocol-revision"] },
  "tool-error": { mustFail: ["tool-call"], mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "protocol-revision"] },
  "csp-meta": { mustFail: ["csp"], mustPass: ["resource-uri", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"] },
  "ext-img": { mustFail: ["csp"], mustPass: ["resource-uri", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"] },
  "bad-domain": { mustFail: ["ui-domain"], mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"] },
};

// The same broken-server scenarios under the stateless 2026-07-28 revision
// must trip exactly the same check ids — plus the two revision-specific ones.
const STATELESS_EXPECTATIONS = {
  ok: {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "negotiated 2026-07-28 via server/discover" },
  },
  "bad-uri": { mustFail: ["resource-uri"], mustPass: ["protocol-revision"] },
  "no-ready": { mustFail: ["ui-initialize", "ui-ready", "tool-call"], mustPass: ["resource-uri", "protocol-revision"] },
  "tool-error": { mustFail: ["tool-call"], mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "protocol-revision"] },
  "discover-missing": {
    mustFail: ["protocol-revision"],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call"],
    detailContains: { "protocol-revision": "server/discover" },
  },
  "no-ui-extension": {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "does NOT advertise io.modelcontextprotocol/ui" },
  },
};

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`server at ${url} did not come up`);
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["dist/cli.js", ...args],
      { timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

let failures = 0;

function assertReport(name, code, stdout, expect) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    failures++;
    console.error(`FAIL ${name}: CLI produced no JSON (exit ${code}): ${stdout.slice(0, 300)}`);
    return;
  }
  const failedIds = report.checks.filter((c) => !c.pass).map((c) => c.id);
  const passedIds = report.checks.filter((c) => c.pass).map((c) => c.id);
  const problems = [];
  for (const id of expect.mustFail) {
    if (!failedIds.includes(id)) problems.push(`expected check "${id}" to FAIL, it passed`);
  }
  for (const id of expect.mustPass) {
    if (!passedIds.includes(id)) problems.push(`expected check "${id}" to PASS, it failed`);
  }
  for (const [id, substring] of Object.entries(expect.detailContains ?? {})) {
    const check = report.checks.find((c) => c.id === id);
    if (!check) problems.push(`no check "${id}" in report`);
    else if (!check.detail.includes(substring)) {
      problems.push(`expected "${id}" detail to contain ${JSON.stringify(substring)}, got: ${check.detail}`);
    }
  }
  const expectedExit = expect.mustFail.length > 0 ? 1 : 0;
  if (code !== expectedExit) problems.push(`expected exit ${expectedExit}, got ${code}`);
  if (problems.length) {
    failures++;
    console.error(`FAIL ${name}:`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error(`   report: ${JSON.stringify(report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })))}`);
  } else {
    console.log(`ok   ${name} (failed checks: ${failedIds.join(", ") || "none"})`);
  }
}

async function scenarioLoop(expectations, { stateless, basePort }) {
  let port = basePort;
  for (const [scenario, expect] of Object.entries(expectations)) {
    port++;
    const serverArgs = ["test/broken-server.mjs", scenario, String(port)];
    if (stateless) serverArgs.push("--stateless");
    const server = spawn(process.execPath, serverArgs, { stdio: "ignore" });
    try {
      await waitForServer(`http://localhost:${port}/mcp`);
      const { code, stdout } = await runCli([
        `http://localhost:${port}/mcp`,
        "--json",
        "--timeout",
        scenario === "slow-init" ? "12" : "10",
      ]);
      assertReport(stateless ? `${scenario} [stateless]` : scenario, code, stdout, expect);
    } finally {
      server.kill();
    }
  }
}

await scenarioLoop(EXPECTATIONS, { stateless: false, basePort: 3100 });
await scenarioLoop(STATELESS_EXPECTATIONS, { stateless: true, basePort: 3150 });

/**
 * Extra cases beyond the per-scenario loops:
 *   strict-mode        ok server, --mode strict → app's tools/call rejected,
 *                      only check (f) fails, exit 1
 *   stdio              ok server over stdio → all 7 pass, exit 0
 *   stdio-stateless    stateless ok server over stdio (server/discover probe
 *                      on stdio) → all 7 pass, exit 0
 *   forced-2026        --protocol 2026-07-28 against the stateless fixture →
 *                      all 7 pass, exit 0
 *   forced-mismatch    --protocol 2026-07-28 against a legacy fixture → exit 2
 *                      naming what the server actually offers
 */
async function extraCase(name, cliArgs, { mustFail, mustPass, detailContains, spawnServer }) {
  const server = spawnServer?.();
  try {
    if (server) await waitForServer(`http://localhost:${server.port}/mcp`);
    const { code, stdout } = await runCli(cliArgs);
    assertReport(name, code, stdout, { mustFail, mustPass, detailContains });
  } finally {
    server?.proc.kill();
  }
}

await extraCase(
  "strict-mode",
  ["http://localhost:3097/mcp", "--json", "--mode", "strict", "--timeout", "10"],
  {
    mustFail: ["tool-call"],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "protocol-revision"],
    spawnServer: () => ({
      port: 3097,
      proc: spawn(process.execPath, ["test/broken-server.mjs", "ok", "3097"], { stdio: "ignore" }),
    }),
  },
);

await extraCase(
  "stdio",
  ["--json", "--timeout", "10", "--stdio", "--", process.execPath, "test/broken-server.mjs", "ok", "--stdio"],
  {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "negotiated 2025-11-25 via initialize" },
  },
);

await extraCase(
  "stdio-stateless",
  ["--json", "--timeout", "10", "--stdio", "--", process.execPath, "test/broken-server.mjs", "ok", "--stdio", "--stateless"],
  {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "negotiated 2026-07-28 via server/discover" },
  },
);

await extraCase(
  "forced-2026",
  ["http://localhost:3098/mcp", "--json", "--protocol", "2026-07-28", "--timeout", "10"],
  {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    spawnServer: () => ({
      port: 3098,
      proc: spawn(process.execPath, ["test/broken-server.mjs", "ok", "3098", "--stateless"], { stdio: "ignore" }),
    }),
  },
);

// forced revision the server does not support → operational error (exit 2)
// with a message naming what the server actually offers, and no JSON report.
{
  const proc = spawn(process.execPath, ["test/broken-server.mjs", "ok", "3099"], { stdio: "ignore" });
  try {
    await waitForServer("http://localhost:3099/mcp");
    const { code, stdout, stderr } = await runCli([
      "http://localhost:3099/mcp", "--json", "--protocol", "2026-07-28", "--timeout", "10",
    ]);
    const problems = [];
    if (code !== 2) problems.push(`expected exit 2, got ${code}`);
    if (stdout.trim() !== "") problems.push(`expected no JSON on stdout, got: ${stdout.slice(0, 200)}`);
    if (!/2025-11-25/.test(stderr)) problems.push(`expected stderr to name the revision the server offers (2025-11-25); got: ${stderr.slice(-400)}`);
    if (problems.length) {
      failures++;
      console.error("FAIL forced-mismatch:");
      for (const p of problems) console.error(`   - ${p}`);
    } else {
      console.log("ok   forced-mismatch (exit 2, names the server's actual revision)");
    }
  } finally {
    proc.kill();
  }
}

console.log(failures ? `\n${failures} scenario(s) FAILED` : "\nall scenarios behaved as expected");
process.exit(failures ? 1 : 0);
