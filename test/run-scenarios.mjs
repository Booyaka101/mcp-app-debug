/**
 * Scenario test runner: for each broken-server scenario, assert that
 * mcp-app-debug --json flags exactly the right checks.
 *
 * Usage: node test/run-scenarios.mjs
 */
import { spawn, execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// scenario → { mustFail: [...check ids], mustPass: [...check ids] }
const EXPECTATIONS = {
  ok: { mustFail: [], mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready", "tool-call"] },
  "bad-uri": { mustFail: ["resource-uri"], mustPass: [] },
  "bad-mime": { mustFail: ["resource-uri"], mustPass: [] },
  "no-ready": { mustFail: ["ui-initialize", "ui-ready", "tool-call"], mustPass: ["resource-uri"] },
  "slow-init": { mustFail: ["ui-initialize"], mustPass: ["ui-ready", "resource-uri"] },
  "tool-error": { mustFail: ["tool-call"], mustPass: ["resource-uri", "csp", "ui-initialize", "ui-ready"] },
  "csp-meta": { mustFail: ["csp"], mustPass: ["resource-uri", "ui-initialize", "ui-ready", "tool-call"] },
  "ext-img": { mustFail: ["csp"], mustPass: ["resource-uri", "ui-initialize", "ui-ready", "tool-call"] },
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
let port = 3100;
for (const [scenario, expect] of Object.entries(EXPECTATIONS)) {
  port++;
  const server = spawn(process.execPath, ["test/broken-server.mjs", scenario, String(port)], {
    stdio: "ignore",
  });
  try {
    await waitForServer(`http://localhost:${port}/mcp`);
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      "--json",
      "--timeout",
      scenario === "slow-init" ? "12" : "10",
    ]);
    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      console.error(`FAIL ${scenario}: CLI produced no JSON (exit ${code}): ${stdout.slice(0, 300)}`);
      failures++;
      continue;
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
    const expectedExit = expect.mustFail.length > 0 ? 1 : 0;
    if (code !== expectedExit) problems.push(`expected exit ${expectedExit}, got ${code}`);
    if (problems.length) {
      failures++;
      console.error(`FAIL ${scenario}:`);
      for (const p of problems) console.error(`   - ${p}`);
      console.error(`   report: ${JSON.stringify(report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })))}`);
    } else {
      console.log(`ok   ${scenario} (failed checks: ${failedIds.join(", ") || "none"})`);
    }
  } finally {
    server.kill();
  }
}

console.log(failures ? `\n${failures} scenario(s) FAILED` : "\nall scenarios behaved as expected");
process.exit(failures ? 1 : 0);
