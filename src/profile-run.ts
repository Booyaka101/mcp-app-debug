/**
 * --profile orchestration: run the scan once per profile descriptor, then
 * attribute the fault. A check failing under `spec` is the app's problem
 * (APP-FAULT); passing under spec but failing under a community-observed
 * profile points at the host (APP-OK-HOST-SUSPECT).
 */
import path from "node:path";
import { statusOf } from "./checks.js";
import { runScanOnce, type HostOptions } from "./host.js";
import {
  isBuiltinProfile,
  loadProfile,
  PROFILE_NAMES,
  type ProfileDescriptor,
} from "./profiles/index.js";
import type { CheckReport, CheckResult, LogEntry } from "./types.js";

export type Verdict = "APP-FAULT" | "APP-OK-HOST-SUSPECT" | "APP-OK";

interface ProfileRunResult {
  name: string;
  report: CheckReport;
  entries: LogEntry[];
}

const isTTY = process.stdout.isTTY ?? false;
const color = (code: number, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const STATUS_FMT: Record<string, string> = { PASS: "32", FAIL: "31", INFO: "36", SKIP: "90" };
const mark = (s: string) => color(Number(STATUS_FMT[s] ?? "0"), s);

/** Resolve the --profile argument into the descriptors to run, spec first. */
export async function resolveProfiles(arg: string): Promise<ProfileDescriptor[]> {
  if (arg === "all") {
    return Promise.all(PROFILE_NAMES.map((n) => loadProfile(n)));
  }
  if (isBuiltinProfile(arg)) {
    if (arg === "spec") return [await loadProfile("spec")];
    return [await loadProfile("spec"), await loadProfile(arg)];
  }
  if (arg.endsWith(".json")) {
    const custom = await loadProfile(arg);
    if (custom.name === "spec") return [custom];
    return [await loadProfile("spec"), custom];
  }
  throw new Error(
    `unknown profile "${arg}" — valid names: ${PROFILE_NAMES.join(", ")}, all, or a path to a descriptor .json`,
  );
}

/** One artifact per profile — otherwise every profile overwrites the last. */
function suffixPath(file: string, profileName: string): string {
  const ext = path.extname(file);
  return ext ? `${file.slice(0, -ext.length)}.${profileName}${ext}` : `${file}.${profileName}`;
}

function cellOf(check: CheckResult): string {
  return statusOf(check).toUpperCase();
}

function printProfileReport(result: ProfileRunResult): void {
  const r = result.report;
  process.stdout.write(
    `\nProfile ${result.name} — server ${r.server}, tool ${r.tool}, mode ${r.mode}\n`,
  );
  r.checks.forEach((c, i) => {
    process.stdout.write(
      `  ${mark(cellOf(c))}  ${String(i + 1).padStart(2)} ${c.title.padEnd(28)} ${c.detail}\n`,
    );
  });
}

interface MatrixJson {
  checks: string[];
  profiles: string[];
  /** cells[row][col] — rows follow `checks`, columns follow `profiles` */
  cells: string[][];
}

/** Rows are the union of the profiles' checks, in first-seen order: a
 * descriptor can carry `toolNameRewrite` while the spec baseline does not, so
 * the columns need not agree on the row list. */
function buildMatrix(results: ProfileRunResult[]): MatrixJson {
  const checks: string[] = [];
  for (const r of results) {
    for (const c of r.report.checks) if (!checks.includes(c.id)) checks.push(c.id);
  }
  return {
    checks,
    profiles: results.map((r) => r.name),
    cells: checks.map((id) =>
      results.map((r) => {
        const check = r.report.checks.find((c) => c.id === id);
        return check ? cellOf(check) : "SKIP";
      }),
    ),
  };
}

function printMatrix(results: ProfileRunResult[], matrix: MatrixJson): void {
  const titles = new Map<string, string>();
  for (const r of results) for (const c of r.report.checks) titles.set(c.id, c.title);
  const labels = matrix.checks.map((id, i) => `${i + 1} ${titles.get(id) ?? id}`);
  const labelWidth = Math.max(...labels.map((l) => l.length)) + 2;
  const colWidth = Math.max(...matrix.profiles.map((p) => p.length), 4) + 2;
  process.stdout.write("\n" + " ".repeat(labelWidth));
  for (const p of matrix.profiles) process.stdout.write(p.padEnd(colWidth));
  process.stdout.write("\n");
  matrix.cells.forEach((row, i) => {
    process.stdout.write(labels[i].padEnd(labelWidth));
    for (const cell of row) process.stdout.write(mark(cell) + " ".repeat(colWidth - cell.length));
    process.stdout.write("\n");
  });
}

function computeVerdict(results: ProfileRunResult[]): { verdict: Verdict; line: string } {
  const spec = results.find((r) => r.name === "spec") ?? results[0];
  const specFails = spec.report.checks.filter((c) => statusOf(c) === "fail");
  if (specFails.length > 0) {
    return {
      verdict: "APP-FAULT",
      line:
        `VERDICT: APP-FAULT — ${specFails.map((c) => c.title).join(", ")} fail(s) under the ` +
        "spec profile; fix the app/server before suspecting any host",
    };
  }
  // A bare tool name is the app's defect wherever it surfaces: ext-apps#745 and
  // #753 both put the fix in the app, and the check only runs where a rewrite
  // is active — which the spec profile never is on its own.
  const bareNames = results.filter((r) =>
    r.report.checks.some((c) => c.id === "aggregator-safe-tool-names" && statusOf(c) === "fail"),
  );
  if (bareNames.length > 0) {
    return {
      verdict: "APP-FAULT",
      line:
        `VERDICT: APP-FAULT — aggregator-safe tool names fail(s) under ${bareNames
          .map((r) => r.name)
          .join(", ")}; the app must read the tool name the host advertises ` +
        "(ext-apps#745, #753)",
    };
  }
  const suspect: string[] = [];
  for (const r of results) {
    if (r.name === spec.name) continue;
    for (const c of r.report.checks) {
      if (statusOf(c) === "fail") suspect.push(`${r.name}: ${c.title}`);
    }
  }
  if (suspect.length > 0) {
    return {
      verdict: "APP-OK-HOST-SUSPECT",
      line:
        `VERDICT: APP-OK-HOST-SUSPECT — every check passes under spec, but ${suspect.join("; ")} ` +
        "fail(s) under a community-observed profile; the divergence is on the host side",
    };
  }
  return {
    verdict: "APP-OK",
    line: `VERDICT: APP-OK — every check passes under ${results.map((r) => r.name).join(", ")}`,
  };
}

/** Evidence block shaped for pasting into an ext-apps issue. */
function buildEvidence(results: ProfileRunResult[]): Array<{
  check: string;
  profile: string;
  observation: string;
  timestampMs: number | null;
  rawMessages: string[];
}> {
  const FILTERS: Record<string, (e: LogEntry) => boolean> = {
    "resource-uri": (e) => e.method === "resources/read" || e.method === "tool-selected",
    csp: (e) => e.marker === "csp-violation",
    "ui-domain": (e) => e.method === "resources/read",
    "ui-initialize": (e) => e.marker === "ui-initialize" || e.marker === "ui-initialize-response",
    "ui-ready": (e) => e.marker === "ui-ready",
    "tool-call": (e) => e.method?.startsWith("tools/call") === true,
    "protocol-revision": (e) => e.method === "negotiate" || e.method === "connected",
    "tool-result-redelivery": (e) =>
      e.marker === "second-call-sent" ||
      e.marker === "second-tool-result" ||
      e.marker === "second-tool-result-withheld" ||
      e.marker === "tool-result-delivered" ||
      e.method === "ui/notifications/tool-result" ||
      e.method?.startsWith("tools/call (redelivery") === true,
    "multi-instance-isolation": (e) =>
      e.instance === 2 || e.marker === "cross-instance-leak" || e.marker === "instance2-skipped",
    "external-navigation": (e) => e.method === "external-navigation probe",
    "aggregator-safe-tool-names": (e) =>
      e.method?.startsWith("tools/call") === true ||
      e.method?.startsWith("tools/list") === true ||
      e.method?.startsWith("aggregator refused") === true,
  };
  const evidence: ReturnType<typeof buildEvidence> = [];
  for (const r of results) {
    r.report.checks.forEach((c, i) => {
      const status = statusOf(c);
      if (status === "pass" && i < 7) return; // 1-7 only when notable; 8-10 always
      const filter = FILTERS[c.id];
      const raw = filter
        ? r.entries
            .filter(filter)
            .slice(0, 12)
            .map((e) => `+${Math.round(e.ts)}ms ${e.dir} ${e.kind} ${e.method ?? ""} ${e.payload ?? ""}`.trim())
        : [];
      evidence.push({
        check: c.id,
        profile: r.name,
        observation: `${status.toUpperCase()}: ${c.detail}`,
        timestampMs: c.ms ?? null,
        rawMessages: raw,
      });
    });
  }
  return evidence;
}

export async function runProfiled(base: HostOptions, profileArg: string): Promise<number> {
  let descriptors: ProfileDescriptor[];
  try {
    descriptors = await resolveProfiles(profileArg);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
    return 2;
  }

  const results: ProfileRunResult[] = [];
  for (const descriptor of descriptors) {
    process.stderr.write(`\n${color(36, `── profile: ${descriptor.name} ──`)}\n`);
    const multi = descriptors.length > 1;
    const out = await runScanOnce({
      ...base,
      profile: descriptor,
      // a descriptor that models an aggregating host overrides the flag
      aggregatorPrefix: descriptor.toolNameRewrite ?? base.aggregatorPrefix,
      video: base.video && multi ? suffixPath(base.video, descriptor.name) : base.video,
      screenshot:
        base.screenshot && multi ? suffixPath(base.screenshot, descriptor.name) : base.screenshot,
      logFile: base.logFile && multi ? suffixPath(base.logFile, descriptor.name) : base.logFile,
    });
    if (out.kind === "error") return out.code;
    results.push({ name: descriptor.name, report: out.report, entries: out.entries });
    if (!base.json) printProfileReport(results[results.length - 1]);
  }

  const matrix = buildMatrix(results);
  const { verdict, line } = computeVerdict(results);

  if (base.json) {
    process.stdout.write(
      JSON.stringify({ verdict, profile: profileArg, matrix, evidence: buildEvidence(results) }) + "\n",
    );
  } else {
    if (results.length > 1) printMatrix(results, matrix);
    process.stdout.write(`\n${line}\n`);
  }
  return verdict === "APP-FAULT" ? 1 : 0;
}
