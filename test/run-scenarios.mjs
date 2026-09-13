/**
 * Scenario test runner: for each broken-server scenario, assert that
 * mcp-app-debug --json flags exactly the right checks — on BOTH protocol
 * revisions (2025-11-25 legacy fixtures and 2026-07-28 stateless fixtures).
 *
 * Usage: node test/run-scenarios.mjs
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
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
  // The point of this one is the mustPass list: ready and tools/call still look
  // healthy, which is exactly why a rejected handshake used to slip through.
  "bad-init-params": {
    mustFail: ["ui-initialize"],
    mustPass: ["resource-uri", "csp", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "ui-initialize": "REJECTED the app's ui/initialize" },
  },
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

// A fixture must not outlive the runner, or the next run cannot bind its port.
// `finally { server.kill() }` does not run on Ctrl-C; this does.
const children = new Set();

function spawnFixture(args, options = { stdio: "ignore" }) {
  const proc = spawn(process.execPath, args, options);
  children.add(proc);
  proc.once("exit", () => children.delete(proc));
  return proc;
}

process.once("exit", () => {
  for (const proc of children) proc.kill();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.once(signal, () => process.exit(130));
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
  for (const id of expect.mustBeAbsent ?? []) {
    if (report.checks.some((c) => c.id === id)) problems.push(`expected no check "${id}" in the report`);
  }
  if (expect.tool !== undefined && report.tool !== expect.tool) {
    problems.push(`expected the report's tool to be "${expect.tool}", got "${report.tool}"`);
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
    const server = spawnFixture(serverArgs);
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
async function extraCase(name, cliArgs, { spawnServer, ...expect }) {
  const server = spawnServer?.();
  try {
    if (server) await waitForServer(`http://localhost:${server.port}/mcp`);
    const { code, stdout } = await runCli(cliArgs);
    assertReport(name, code, stdout, expect);
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
      proc: spawnFixture(["test/broken-server.mjs", "ok", "3097"]),
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
      proc: spawnFixture(["test/broken-server.mjs", "ok", "3098", "--stateless"]),
    }),
  },
);

// forced revision the server does not support → operational error (exit 2)
// with a message naming what the server actually offers, and no JSON report.
{
  const proc = spawnFixture(["test/broken-server.mjs", "ok", "3099"]);
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

/**
 * Host-conformance scenarios (`mcp-app-debug host`):
 *   host-conformant   fake-host (advertises ui ext, relays everything) → 7/7
 *                     PASS, exit 0
 *   host-drop         fake-host --drop (no capabilities.extensions, tool-result
 *                     _meta stripped) → client-advertises-ui and
 *                     tool-result-meta-preserved FAIL, exit 1
 *   host-reject-init  fake-host --reject-init (ui/initialize answered with a
 *                     JSON-RPC error) → ui-initialize-answered FAIL, exit 1
 *   host-no-client    nothing connects → exit 2, "no client connected", no JSON
 *   host-list-only    fake-host --list-only (never calls probe) → chip 1 PASS,
 *                     chips 2-7 INCONCLUSIVE, exit 0
 *   host-scan-dogfood scan mode IS a conformant 2026-07-28 host — both
 *                     directions must go 7/7 at once
 *   host-protocol-version-split  header and initialize body name different
 *                     revisions → the fixture says so on stderr
 */
function spawnCollect(nodeArgs) {
  const proc = spawnFixture(nodeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) => {
    proc.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
  return { proc, done };
}

function assertHostReport(name, code, stdout, expect) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    failures++;
    console.error(`FAIL ${name}: host CLI produced no JSON (exit ${code}): ${stdout.slice(0, 300)}`);
    return;
  }
  const problems = [];
  for (const [id, verdict] of Object.entries(expect.verdicts)) {
    const check = report.checks.find((c) => c.id === id);
    if (!check) problems.push(`no check "${id}" in report`);
    else if (check.verdict !== verdict) {
      problems.push(`expected "${id}" to be ${verdict.toUpperCase()}, got ${check.verdict.toUpperCase()}: ${check.detail}`);
    }
  }
  for (const [id, substring] of Object.entries(expect.detailContains ?? {})) {
    const check = report.checks.find((c) => c.id === id);
    if (check && !check.detail.includes(substring)) {
      problems.push(`expected "${id}" detail to contain ${JSON.stringify(substring)}, got: ${check.detail}`);
    }
  }
  const counts = expect.counts;
  if (counts && (report.passed !== counts[0] || report.failed !== counts[1] || report.inconclusive !== counts[2])) {
    problems.push(`expected passed/failed/inconclusive ${counts.join("/")}, got ${report.passed}/${report.failed}/${report.inconclusive}`);
  }
  if (report.mode !== "host") problems.push(`expected mode "host", got ${report.mode}`);
  if (code !== expect.exit) problems.push(`expected exit ${expect.exit}, got ${code}`);
  if (problems.length) {
    failures++;
    console.error(`FAIL ${name}:`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error(`   report: ${JSON.stringify(report.checks.map((c) => ({ id: c.id, verdict: c.verdict, detail: c.detail })))}`);
  } else {
    const fails = report.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
    console.log(`ok   ${name} (failed checks: ${fails.join(", ") || "none"})`);
  }
}

async function hostCase(name, { port, windowSec, clientArgs, expect }) {
  const host = spawnCollect([
    "dist/cli.js", "host", "--port", String(port), "--json", "--window", String(windowSec),
  ]);
  try {
    await waitForServer(`http://localhost:${port}/mcp`);
    let clientRes;
    if (clientArgs) {
      clientRes = await new Promise((resolve) => {
        execFile(process.execPath, clientArgs, { timeout: 120_000 }, (err, stdout, stderr) =>
          resolve({ code: err?.code ?? 0, stdout, stderr }),
        );
      });
    }
    const { code, stdout, stderr } = await host.done;
    if (expect.noClient) {
      const problems = [];
      if (code !== 2) problems.push(`expected exit 2, got ${code}`);
      if (stdout.trim() !== "") problems.push(`expected no JSON on stdout, got: ${stdout.slice(0, 200)}`);
      if (!/no client connected/.test(stderr)) problems.push(`expected stderr to say "no client connected"; got: ${stderr.slice(-300)}`);
      if (problems.length) {
        failures++;
        console.error(`FAIL ${name}:`);
        for (const p of problems) console.error(`   - ${p}`);
      } else {
        console.log(`ok   ${name} (exit 2, no client connected)`);
      }
      return { clientRes };
    }
    assertHostReport(name, code, stdout, expect);
    return { clientRes };
  } finally {
    host.proc.kill();
  }
}

const ALL_PASS = Object.fromEntries(
  [
    "client-advertises-ui", "ui-resource-read", "app-mounted", "ui-initialize-answered",
    "tool-result-meta-preserved", "app-call-relayed", "sandbox-origin-and-csp",
  ].map((id) => [id, "pass"]),
);

await hostCase("host-conformant", {
  port: 3311,
  windowSec: 60,
  clientArgs: ["test/fake-host.mjs", "http://localhost:3311/mcp"],
  expect: { exit: 0, verdicts: ALL_PASS, counts: [7, 0, 0] },
});

await hostCase("host-drop", {
  port: 3312,
  windowSec: 60,
  clientArgs: ["test/fake-host.mjs", "http://localhost:3312/mcp", "--drop"],
  expect: {
    exit: 1,
    verdicts: {
      ...ALL_PASS,
      "client-advertises-ui": "fail",
      "tool-result-meta-preserved": "fail",
    },
    counts: [5, 2, 0],
    detailContains: {
      "client-advertises-ui": "pydantic-ai#6613 shape",
      "tool-result-meta-preserved": "the host dropped tool-result _meta",
    },
  },
});

// ext-apps#671: an error reply is a reply. Everything else here is conformant,
// so only check 4 may move.
await hostCase("host-reject-init", {
  port: 3315,
  windowSec: 60,
  clientArgs: ["test/fake-host.mjs", "http://localhost:3315/mcp", "--reject-init"],
  expect: {
    exit: 1,
    verdicts: { ...ALL_PASS, "ui-initialize-answered": "fail" },
    counts: [6, 1, 0],
    detailContains: { "ui-initialize-answered": "REJECTED the app's ui/initialize (-32603: app rejected by this host)" },
  },
});

// ext-apps#671: Claude sends MCP-Protocol-Version as a header while its
// initialize body asks for a different revision. A fixture that reads only one
// of the two misreports what was negotiated, so it has to say when they split.
{
  const port = 3316;
  const host = spawnCollect(["dist/cli.js", "host", "--port", String(port), "--json", "--window", "6"]);
  try {
    await waitForServer(`http://localhost:${port}/mcp`);
    await new Promise((resolve) => {
      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "split", version: "1" } },
      });
      const req = httpRequest(
        { host: "localhost", port, path: "/mcp", method: "POST",
          headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28",
            "Content-Length": Buffer.byteLength(body) } },
        (res) => { res.resume(); res.on("end", resolve); },
      );
      req.on("error", resolve);
      req.end(body);
    });
    const { stderr } = await host.done;
    const expected = "header says 2026-07-28 but the initialize body asks for 2025-11-25";
    if (!stderr.includes(expected)) {
      failures++;
      console.error(`FAIL host-protocol-version-split:\n   - expected stderr to contain ${JSON.stringify(expected)}\n   - got: ${stderr.slice(-400)}`);
    } else {
      console.log("ok   host-protocol-version-split (header/body disagreement reported)");
    }
  } finally {
    host.proc.kill();
  }
}

await hostCase("host-no-client", {
  port: 3313,
  windowSec: 5,
  clientArgs: null,
  expect: { noClient: true },
});

await hostCase("host-list-only", {
  port: 3314,
  windowSec: 8,
  clientArgs: ["test/fake-host.mjs", "http://localhost:3314/mcp", "--list-only"],
  expect: {
    exit: 0,
    verdicts: Object.fromEntries(
      Object.keys(ALL_PASS).map((id) => [id, id === "client-advertises-ui" ? "pass" : "inconclusive"]),
    ),
    counts: [1, 0, 6],
    detailContains: { "ui-resource-read": "ask it to run `probe`" },
  },
});

{
  const { clientRes } = await hostCase("host-scan-dogfood", {
    port: 3315,
    windowSec: 60,
    clientArgs: ["dist/cli.js", "http://localhost:3315/mcp", "--json"],
    expect: { exit: 0, verdicts: ALL_PASS, counts: [7, 0, 0] },
  });
  // The scan side of the dogfood run must be 7/7 too.
  assertReport("host-scan-dogfood [scan side]", clientRes?.code ?? -1, clientRes?.stdout ?? "", {
    mustFail: [],
    mustPass: ["resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call", "protocol-revision"],
    detailContains: { "protocol-revision": "negotiated 2026-07-28 via server/discover" },
  });
}

/**
 * --profile scenarios (checks 8-10, verdict, matrix). Fixtures live in
 * test/profile-server.mjs; descriptor fixtures in test/profiles/.
 */
function fail(name, problems) {
  failures++;
  console.error(`FAIL ${name}:`);
  for (const p of problems) console.error(`   - ${p}`);
}

async function profileCase(name, { scenario, port, profile, extraArgs = [], expect }) {
  const server = spawnFixture(["test/profile-server.mjs", scenario, String(port)]);
  try {
    await waitForServer(`http://localhost:${port}/mcp`);
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`, "--json", "--profile", profile, "--timeout", "12", ...extraArgs,
    ]);
    let out;
    try {
      out = JSON.parse(stdout);
    } catch {
      fail(name, [`no JSON on stdout (exit ${code}): ${stdout.slice(0, 300)}`]);
      return;
    }
    const problems = [];
    if (out.verdict !== expect.verdict) problems.push(`expected verdict ${expect.verdict}, got ${out.verdict}`);
    if (code !== expect.exit) problems.push(`expected exit ${expect.exit}, got ${code}`);
    for (const [checkId, wanted] of Object.entries(expect.cells ?? {})) {
      // an array when one check is asserted in more than one column
      for (const want of Array.isArray(wanted) ? wanted : [wanted]) {
        const row = out.matrix.checks.indexOf(checkId);
        const col = out.matrix.profiles.indexOf(want.profile);
        const got = row >= 0 && col >= 0 ? out.matrix.cells[row][col] : "(missing)";
        if (got !== want.cell) problems.push(`expected ${checkId}@${want.profile} = ${want.cell}, got ${got}`);
      }
    }
    // observationContains reads the check's own detail line; rawContains reads
    // the protocol log the evidence block carries for it.
    const EVIDENCE_TEXT = {
      observationContains: (es) => es.map((e) => e.observation).join(" || "),
      rawContains: (es) => es.flatMap((e) => e.rawMessages).join(" || "),
    };
    for (const [key, extract] of Object.entries(EVIDENCE_TEXT)) {
      for (const [checkId, substring] of Object.entries(expect[key] ?? {})) {
        const text = extract(out.evidence.filter((e) => e.check === checkId));
        if (!text.includes(substring)) problems.push(`expected ${checkId} ${key} to contain ${JSON.stringify(substring)}, got: ${text.slice(0, 300)}`);
      }
    }
    // the machine-readable reason an APP-OK-HOST-SUSPECT run still exits 1
    for (const [checkId, want] of Object.entries(expect.blocking ?? {})) {
      const got = out.evidence.some((e) => e.check === checkId && e.profile === want.profile && e.blocking === true);
      if (got !== want.blocking) problems.push(`expected ${checkId}@${want.profile} blocking=${want.blocking}, got ${got}`);
    }
    if (expect.matrixSnapshot) {
      const got = JSON.stringify(out.matrix);
      const want = JSON.stringify(expect.matrixSnapshot);
      if (got !== want) problems.push(`matrix snapshot mismatch\n     want ${want}\n     got  ${got}`);
    }
    if (problems.length) fail(name, problems);
    else console.log(`ok   ${name} (${out.verdict})`);
  } finally {
    server.kill();
  }
}

// unknown profile name → exit 2, valid names listed, no JSON
{
  const { code, stdout, stderr } = await runCli(["http://localhost:9/mcp", "--profile", "nosuch"]);
  const problems = [];
  if (code !== 2) problems.push(`expected exit 2, got ${code}`);
  if (stdout.trim() !== "") problems.push(`expected no stdout, got: ${stdout.slice(0, 120)}`);
  if (!/spec, claude-desktop, claude-web, chatgpt, grok/.test(stderr)) problems.push(`expected stderr to list valid profile names; got: ${stderr.slice(-300)}`);
  problems.length ? fail("profile-unknown-name", problems) : console.log("ok   profile-unknown-name (exit 2, names listed)");
}

// descriptor with sources: [] → rejected at load, exit 2
{
  const { code, stdout, stderr } = await runCli(["http://localhost:9/mcp", "--profile", "test/profiles/empty-sources.json"]);
  const problems = [];
  if (code !== 2) problems.push(`expected exit 2, got ${code}`);
  if (stdout.trim() !== "") problems.push(`expected no stdout, got: ${stdout.slice(0, 120)}`);
  if (!/sources/.test(stderr)) problems.push(`expected stderr to name the sources rule; got: ${stderr.slice(-300)}`);
  problems.length ? fail("profile-empty-sources", problems) : console.log("ok   profile-empty-sources (rejected at load)");
}

await profileCase("profile-spec-ok", {
  scenario: "weather", port: 3411, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: {
      "tool-result-redelivery": { profile: "spec", cell: "PASS" },
      "multi-instance-isolation": { profile: "spec", cell: "PASS" },
      "external-navigation": { profile: "spec", cell: "INFO" },
    },
    observationContains: { "external-navigation": "blocked by sandbox (no allow-popups)" },
  },
});

await profileCase("profile-grok-host-suspect", {
  scenario: "weather", port: 3412, profile: "grok",
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 0,
    cells: {
      "tool-result-redelivery": [
        { profile: "spec", cell: "PASS" },
        { profile: "grok", cell: "FAIL" },
      ],
    },
    observationContains: { "tool-result-redelivery": "ext-apps#750" },
    // withheld by descriptor for every app, so it says nothing about this one
    blocking: { "tool-result-redelivery": { profile: "grok", blocking: false } },
  },
});

await profileCase("profile-first-only-app-fault", {
  scenario: "first-only", port: 3413, profile: "spec",
  expect: {
    verdict: "APP-FAULT", exit: 1,
    cells: { "tool-result-redelivery": { profile: "spec", cell: "FAIL" } },
    observationContains: { "tool-result-redelivery": "isError" },
  },
});

await profileCase("profile-leak-app-fault", {
  scenario: "leak", port: 3414, profile: "spec",
  expect: {
    verdict: "APP-FAULT", exit: 1,
    cells: { "multi-instance-isolation": { profile: "spec", cell: "FAIL" } },
    observationContains: { "multi-instance-isolation": "message(s) addressed to instance" },
  },
});

await profileCase("profile-popups-open", {
  scenario: "popup", port: 3415, profile: "test/profiles/popups-open.json",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "external-navigation": { profile: "popups-open", cell: "PASS" } },
  },
});

await profileCase("profile-popups-broken", {
  scenario: "popup", port: 3416, profile: "test/profiles/popups-broken.json",
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 0,
    cells: { "external-navigation": { profile: "popups-broken", cell: "FAIL" } },
    observationContains: { "external-navigation": "sandbox" },
  },
});

// --profile all: 11-row × 5-column matrix snapshot + verdict
// grok fails check 8 by descriptor (redeliversToolResult:false), so a healthy
// app under --profile all is APP-OK-HOST-SUSPECT, not APP-OK.
await profileCase("profile-all-matrix-snapshot", {
  scenario: "weather", port: 3417, profile: "all",
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 0,
    matrixSnapshot: {
      checks: [
        "resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call",
        "protocol-revision", "tool-result-redelivery", "multi-instance-isolation", "external-navigation",
        "resource-csp-effective",
      ],
      profiles: ["spec", "claude-desktop", "claude-web", "chatgpt", "grok"],
      cells: [
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "FAIL"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["INFO", "INFO", "INFO", "INFO", "INFO"],
        ["SKIP", "SKIP", "SKIP", "SKIP", "SKIP"],
      ],
    },
    // no declaration is not a failure — there is simply nothing to probe
    observationContains: {
      "resource-csp-effective": "server declares no _meta.ui.csp; nothing to probe",
    },
  },
});

// Honest SKIPs: the two cases the brief calls out as "skip, do not fail".
await profileCase("profile-noargs-skip8", {
  scenario: "noargs", port: 3418, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "tool-result-redelivery": { profile: "spec", cell: "SKIP" } },
    observationContains: { "tool-result-redelivery": "not argument-sensitive" },
  },
});

await profileCase("profile-singleton-skip9", {
  scenario: "singleton", port: 3419, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "multi-instance-isolation": { profile: "spec", cell: "SKIP" } },
    observationContains: { "multi-instance-isolation": "singleton ui:// resource" },
  },
});

/* --- check 12: are the origins the server declared reachable from inside the
   sandbox? Every probe is answered locally, which "0 escaped" asserts. --- */

await profileCase("profile-csp-origins-spec", {
  scenario: "csp-origins", port: 3430, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "resource-csp-effective": { profile: "spec", cell: "PASS" } },
    observationContains: {
      "resource-csp-effective":
        "2/2 reachable inside the sandbox (resource https://cdn.example.com; connect https://api.example.com)",
    },
    rawContains: {
      "resource-csp-effective":
        "2 probe request(s) attempted, 2 answered locally, 0 stopped by CSP, 0 escaped",
    },
  },
});

// ext-apps#761: claude.ai's sandbox proxy never reads _meta.ui.csp, so the same
// correct app cannot reach its own CDN there. The verdict absolves the app and
// the exit code still fails, because the app does not work on that host.
await profileCase("profile-csp-origins-claude-web", {
  scenario: "csp-origins", port: 3431, profile: "claude-web",
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 1,
    cells: {
      "resource-csp-effective": [
        { profile: "spec", cell: "PASS" },
        { profile: "claude-web", cell: "FAIL" },
      ],
    },
    observationContains: {
      "resource-csp-effective":
        "0/2 reachable; img-src blocked https://cdn.example.com/__mcp-app-debug-probe, " +
        "connect-src blocked https://api.example.com/__mcp-app-debug-probe. " +
        "This host does not apply _meta.ui.csp (ext-apps#761); the app is correct.",
    },
    blocking: { "resource-csp-effective": { profile: "claude-web", blocking: true } },
    // the blocked <img> is reported by Chromium, the blocked fetch() is not;
    // neither opened a socket, so nothing escaped.
    rawContains: {
      "resource-csp-effective":
        "1 probe request(s) attempted, 0 answered locally, 1 stopped by CSP, 0 escaped",
    },
  },
});

// A wildcard is probed at a synthetic subdomain, a repeat is probed once, and a
// bare host CSP accepts but nothing can be requested from is reported not probed.
await profileCase("profile-csp-wildcard", {
  scenario: "csp-wildcard", port: 3433, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "resource-csp-effective": { profile: "spec", cell: "PASS" } },
    observationContains: {
      "resource-csp-effective":
        "2/2 reachable inside the sandbox (resource https://*.example.com; resource https://cdn.example.com); " +
        "wildcard https://*.example.com probed as https://mcp-app-debug-probe.example.com; " +
        "1 invalid entry/entries not probed (not a probeable origin): cdn.example.com",
    },
    rawContains: { "resource-csp-effective": "0 escaped" },
  },
});

// A declared path prefix is probed under itself, because Chromium matches the
// path too: probing the origin root would report a correct declaration broken.
// An entry naming one exact file is reported instead, since the only request
// that could match it is a request for that real file.
await profileCase("profile-csp-paths", {
  scenario: "csp-paths", port: 3434, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: { "resource-csp-effective": { profile: "spec", cell: "PASS" } },
    blocking: { "resource-csp-effective": { profile: "spec", blocking: false } },
    observationContains: {
      "resource-csp-effective":
        "1/1 reachable inside the sandbox (resource https://cdn.example.com/assets/); " +
        "1 invalid entry/entries not probed (not a probeable origin): " +
        "https://exact.example.com/logo.png",
    },
    rawContains: {
      "resource-csp-effective":
        "1 probe request(s) attempted, 1 answered locally, 0 stopped by CSP, 0 escaped",
    },
  },
});

// Check 12 provokes CSP violations on purpose, so it has to be able to tell
// them from the app's own. Here the app really loads an image from the single
// origin it declared, served by the fixture itself: allowed under spec, and
// under claude-web a genuine check-2 failure that the probe must not mask.
await profileCase("profile-csp-self-asset-spec", {
  scenario: "csp-self-asset", port: 3435, profile: "spec",
  expect: {
    verdict: "APP-OK", exit: 0,
    cells: {
      csp: { profile: "spec", cell: "PASS" },
      "resource-csp-effective": { profile: "spec", cell: "PASS" },
    },
  },
});

await profileCase("profile-csp-self-asset-claude-web", {
  scenario: "csp-self-asset", port: 3436, profile: "claude-web",
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 1,
    cells: {
      csp: [
        { profile: "spec", cell: "PASS" },
        { profile: "claude-web", cell: "FAIL" },
      ],
      "resource-csp-effective": [
        { profile: "spec", cell: "PASS" },
        { profile: "claude-web", cell: "FAIL" },
      ],
    },
    observationContains: {
      // the app's own blocked asset, not the probe's
      csp: "img-src blocked http://localhost:3436/asset.png",
      "resource-csp-effective": "img-src blocked http://localhost:3436/__mcp-app-debug-probe",
    },
  },
});

// The other half of check 12: a declaration a host DOES apply and the browser
// still refuses. Userinfo in a source expression parses but matches nothing, so
// this fails under spec, where there is no host knob to blame, and the detail
// line says the app is at fault rather than the host.
await profileCase("profile-csp-unmatchable-spec", {
  scenario: "csp-unmatchable", port: 3437, profile: "spec",
  expect: {
    verdict: "APP-FAULT", exit: 1,
    cells: { "resource-csp-effective": { profile: "spec", cell: "FAIL" } },
    blocking: { "resource-csp-effective": { profile: "spec", blocking: true } },
    observationContains: {
      "resource-csp-effective":
        "0/1 reachable; img-src blocked https://cdn.example.com/__mcp-app-debug-probe. " +
        "This profile does apply _meta.ui.csp, so the block is not the host knob. " +
        "The declared entry does not cover the request that was made.",
    },
    rawContains: {
      "resource-csp-effective":
        "1 probe request(s) attempted, 0 answered locally, 1 stopped by CSP, 0 escaped",
    },
  },
});

// Profile mode over stdio (the transport has no HTTP endpoint to hash, and
// checks 8-10 must still resolve).
{
  const { code, stdout } = await runCli([
    "--json", "--profile", "spec", "--timeout", "14",
    "--stdio", "--", process.execPath, "test/profile-server.mjs", "weather", "--stdio",
  ]);
  const problems = [];
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    problems.push(`no JSON on stdout (exit ${code}): ${stdout.slice(0, 200)}`);
  }
  if (out) {
    if (out.verdict !== "APP-OK") problems.push(`expected APP-OK, got ${out.verdict}`);
    if (out.matrix.checks.length !== 11) problems.push(`expected 11 rows, got ${out.matrix.checks.length}`);
    const row = out.matrix.checks.indexOf("tool-result-redelivery");
    if (out.matrix.cells[row][0] !== "PASS") problems.push(`expected check 8 PASS over stdio, got ${out.matrix.cells[row][0]}`);
  }
  if (code !== 0) problems.push(`expected exit 0, got ${code}`);
  problems.length ? fail("profile-stdio", problems) : console.log("ok   profile-stdio (APP-OK, 11 rows)");
}

// --profile with artifacts: one file per profile, suffixed with its name.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-app-debug-artifacts-"));
  const server = spawnFixture(["test/profile-server.mjs", "weather", "3420"]);
  try {
    await waitForServer("http://localhost:3420/mcp");
    const { code } = await runCli([
      "http://localhost:3420/mcp", "--json", "--profile", "grok", "--timeout", "14",
      "--video", path.join(dir, "sess.webm"),
      "--log-file", path.join(dir, "log.ndjson"),
      "--screenshot", path.join(dir, "shot.png"),
    ]);
    const problems = [];
    if (code !== 0) problems.push(`expected exit 0, got ${code}`);
    for (const name of [
      "sess.spec.webm", "sess.grok.webm",
      "log.spec.ndjson", "log.grok.ndjson",
      "shot.spec.png", "shot.grok.png",
    ]) {
      const file = path.join(dir, name);
      if (!existsSync(file)) problems.push(`missing artifact ${name}`);
      else if (statSync(file).size === 0) problems.push(`artifact ${name} is empty`);
    }
    problems.length
      ? fail("profile-artifacts-per-profile", problems)
      : console.log("ok   profile-artifacts-per-profile (6 files, one video/log/shot per profile)");
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * --aggregator scenarios (check 11). ext-apps#745: behind a namespacing
 * gateway only the rewritten name resolves, and the bare one is answered
 * -32043. #753 counts fifteen example apps that hardcode the bare name.
 */
const aggregatorCase = (name, { scenario, port, args, expect }) =>
  extraCase(name, [`http://localhost:${port}/mcp`, "--json", "--timeout", "10", ...args], {
    ...expect,
    spawnServer: () => ({
      port,
      proc: spawnFixture(["test/profile-server.mjs", scenario, String(port)]),
    }),
  });

const ALL_SEVEN = [
  "resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call", "protocol-revision",
];

await aggregatorCase("aggregator-bare-names", {
  scenario: "bare-names", port: 3421, args: ["--aggregator"],
  expect: {
    mustFail: ["aggregator-safe-tool-names", "tool-call"],
    mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "protocol-revision"],
    tool: "alpha__forecast",
    detailContains: {
      "aggregator-safe-tool-names":
        'app sent tools/call name="forecast" but the host advertised "alpha__forecast" in ' +
        "hostContext.toolInfo.tool.name; a namespacing aggregator answers -32043 for the bare " +
        "name and every interaction after mount fails (ext-apps#745, #753)",
    },
  },
});

await aggregatorCase("aggregator-resolved-names", {
  scenario: "resolved-names", port: 3422, args: ["--aggregator"],
  expect: {
    mustFail: [],
    mustPass: [...ALL_SEVEN, "aggregator-safe-tool-names"],
    tool: "alpha__forecast",
    detailContains: {
      "aggregator-safe-tool-names": 'app resolved "alpha__forecast" from hostContext.toolInfo',
      "tool-call": 'app called "alpha__forecast"',
    },
  },
});

// Aggregation is a deployment shape, not a spec requirement: without the flag
// the check does not exist and neither app is faulted for its name.
await aggregatorCase("aggregator-off-bare-names", {
  scenario: "bare-names", port: 3423, args: [],
  expect: { mustFail: [], mustPass: ALL_SEVEN, mustBeAbsent: ["aggregator-safe-tool-names"], tool: "forecast" },
});

await aggregatorCase("aggregator-off-resolved-names", {
  scenario: "resolved-names", port: 3424, args: [],
  expect: { mustFail: [], mustPass: ALL_SEVEN, mustBeAbsent: ["aggregator-safe-tool-names"], tool: "forecast" },
});

// #745's other correct route: the app lists tools through the bridge, which
// must show the rewritten names.
await aggregatorCase("aggregator-listed-names", {
  scenario: "listed-names", port: 3429, args: ["--aggregator"],
  expect: {
    mustFail: [],
    mustPass: [...ALL_SEVEN, "aggregator-safe-tool-names"],
    detailContains: {
      "aggregator-safe-tool-names": 'app resolved "alpha__forecast" from tools/list through the bridge',
    },
  },
});

// A tool whose own name already carries the separator must not be prefixed twice.
await aggregatorCase("aggregator-already-namespaced", {
  scenario: "namespaced", port: 3425, args: ["--aggregator"],
  expect: {
    mustFail: [],
    mustPass: [...ALL_SEVEN, "aggregator-safe-tool-names"],
    tool: "alpha__forecast",
    detailContains: {
      "aggregator-safe-tool-names": 'tool name "alpha__forecast" already carries the "__" separator',
    },
  },
});

// A custom prefix, and --tool given in either spelling.
await aggregatorCase("aggregator-custom-prefix", {
  scenario: "resolved-names", port: 3426, args: ["--aggregator", "gateway.", "--tool", "forecast"],
  expect: {
    mustFail: [],
    mustPass: [...ALL_SEVEN, "aggregator-safe-tool-names"],
    tool: "gateway.forecast",
    detailContains: { "aggregator-safe-tool-names": 'app resolved "gateway.forecast"' },
  },
});

// The descriptor knob (toolNameRewrite) instead of the flag: the rewrite is on
// for that profile only, so the matrix rows are the union — and a bare name is
// APP-FAULT even though the spec baseline never ran the check.
await profileCase("profile-aggregator-descriptor", {
  scenario: "bare-names", port: 3427, profile: "test/profiles/aggregator.json",
  expect: {
    verdict: "APP-FAULT", exit: 1,
    cells: {
      "aggregator-safe-tool-names": [
        { profile: "aggregator", cell: "FAIL" },
        // the spec baseline never ran the check, so its cell is empty
        { profile: "spec", cell: "SKIP" },
      ],
    },
    observationContains: { "aggregator-safe-tool-names": "ext-apps#745, #753" },
  },
});

// --profile all --aggregator: twelve rows, and row 11 in matrix.checks.
await profileCase("profile-all-aggregator-matrix", {
  scenario: "resolved-names", port: 3428, profile: "all", extraArgs: ["--aggregator"],
  expect: {
    verdict: "APP-OK-HOST-SUSPECT", exit: 0,
    matrixSnapshot: {
      checks: [
        "resource-uri", "csp", "ui-domain", "ui-initialize", "ui-ready", "tool-call",
        "protocol-revision", "tool-result-redelivery", "multi-instance-isolation",
        "external-navigation", "aggregator-safe-tool-names", "resource-csp-effective",
      ],
      profiles: ["spec", "claude-desktop", "claude-web", "chatgpt", "grok"],
      cells: [
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["PASS", "PASS", "PASS", "PASS", "FAIL"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["INFO", "INFO", "INFO", "INFO", "INFO"],
        ["PASS", "PASS", "PASS", "PASS", "PASS"],
        ["SKIP", "SKIP", "SKIP", "SKIP", "SKIP"],
      ],
    },
  },
});

/**
 * Unit assertions for the checks 8-11 decision logic. Several branches (a
 * browser-level popup block vs a sandbox-level one, a second instance that
 * mounts but never handshakes) cannot be forced through a real browser
 * reliably, so they are asserted directly against synthetic state.
 */
{
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "test/checks-unit.ts"],
      { timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
  const passed = (stdout.match(/^ok {3}unit:/gm) ?? []).length;
  if (code !== 0 || passed === 0) {
    fail("checks-unit", [
      `unit suite exited ${code} with ${passed} assertion(s) passing`,
      (stdout + stderr).split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("   -")).join("\n     ") ||
        (stderr || stdout).slice(-400),
    ]);
  } else {
    console.log(`ok   checks-unit (${passed} unit assertions)`);
  }
}

console.log(failures ? `\n${failures} scenario(s) FAILED` : "\nall scenarios behaved as expected");
process.exit(failures ? 1 : 0);
