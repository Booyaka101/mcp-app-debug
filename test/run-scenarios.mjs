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
  const proc = spawn(process.execPath, nodeArgs, { stdio: ["ignore", "pipe", "pipe"] });
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

async function profileCase(name, { scenario, port, profile, expect }) {
  const server = spawn(process.execPath, ["test/profile-server.mjs", scenario, String(port)], { stdio: "ignore" });
  try {
    await waitForServer(`http://localhost:${port}/mcp`);
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`, "--json", "--profile", profile, "--timeout", "12",
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
    for (const [checkId, want] of Object.entries(expect.cells ?? {})) {
      const row = out.matrix.checks.indexOf(checkId);
      const col = out.matrix.profiles.indexOf(want.profile);
      const got = row >= 0 && col >= 0 ? out.matrix.cells[row][col] : "(missing)";
      if (got !== want.cell) problems.push(`expected ${checkId}@${want.profile} = ${want.cell}, got ${got}`);
    }
    for (const [checkId, substring] of Object.entries(expect.observationContains ?? {})) {
      const ev = out.evidence.filter((e) => e.check === checkId).map((e) => e.observation).join(" || ");
      if (!ev.includes(substring)) problems.push(`expected ${checkId} evidence to contain ${JSON.stringify(substring)}, got: ${ev.slice(0, 300)}`);
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
      "tool-result-redelivery": { profile: "spec", cell: "PASS" },
      "tool-result-redelivery": { profile: "grok", cell: "FAIL" },
    },
    observationContains: { "tool-result-redelivery": "ext-apps#750" },
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

// --profile all: 10-row × 5-column matrix snapshot + verdict
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
      ],
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
    if (out.matrix.checks.length !== 10) problems.push(`expected 10 rows, got ${out.matrix.checks.length}`);
    const row = out.matrix.checks.indexOf("tool-result-redelivery");
    if (out.matrix.cells[row][0] !== "PASS") problems.push(`expected check 8 PASS over stdio, got ${out.matrix.cells[row][0]}`);
  }
  if (code !== 0) problems.push(`expected exit 0, got ${code}`);
  problems.length ? fail("profile-stdio", problems) : console.log("ok   profile-stdio (APP-OK, 10 rows)");
}

// --profile with artifacts: one file per profile, suffixed with its name.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-app-debug-artifacts-"));
  const server = spawn(process.execPath, ["test/profile-server.mjs", "weather", "3420"], { stdio: "ignore" });
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
 * Unit assertions for the checks 8-10 decision logic. Several branches (a
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
