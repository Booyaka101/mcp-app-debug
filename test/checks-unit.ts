/**
 * Unit tests for the checks 8-11 decision logic (src/checks.ts) and the
 * aggregator name mapping (src/mcp/aggregator.ts).
 *
 * The scenario suite drives these through a real browser, which covers the
 * paths a real server can produce — but several branches cannot be forced
 * from outside reliably (a browser-level popup block as opposed to a
 * sandbox-level one, a mounted-but-never-handshaking second instance). Those
 * are exactly the branches whose message a user acts on, so they are asserted
 * here against synthetic state instead of being left unexecuted.
 *
 * Run: npx tsx test/checks-unit.ts   (also runs as part of `npm test`)
 */
import {
  evaluateAggregatorCheck,
  evaluateChecks,
  evaluateProfileChecks,
  statusOf,
} from "../src/checks.js";
import {
  createAggregator,
  DEFAULT_AGGREGATOR_PREFIX,
  UnknownNamespaceError,
} from "../src/mcp/aggregator.js";
import type { ProfileDescriptor } from "../src/profiles/index.js";
import type { CheckResult, HarnessState } from "../src/types.js";

const PROFILE: ProfileDescriptor = {
  name: "unit",
  description: "synthetic descriptor for unit tests",
  sandboxTokens: ["allow-scripts", "allow-same-origin", "allow-forms"],
  csp: {
    frameAncestors: "'self'",
    scriptSrc: "'self'",
    defaultSrc: "'self'",
    objectSrc: "'self'",
  },
  popupsAllowed: false,
  redeliversToolResult: true,
  maxConcurrentInstances: 2,
  honoursUiDomain: true,
  sources: ["https://example.invalid/unit"],
};

const baseState = (): HarnessState => ({
  mode: "trusted",
  resourceUriValid: true,
  resourceOk: true,
  cspViolations: [],
  appToolCalls: [],
  appToolCallAttempts: 0,
});

let failures = 0;

function assertCheck(
  name: string,
  results: CheckResult[],
  id: CheckResult["id"],
  expectStatus: string,
  expectSubstring: string,
): void {
  const result = results.find((c) => c.id === id);
  const problems: string[] = [];
  if (!result) {
    problems.push(`no check "${id}" produced`);
  } else {
    const status = statusOf(result);
    if (status !== expectStatus) problems.push(`expected ${expectStatus.toUpperCase()}, got ${status.toUpperCase()}`);
    if (!result.detail.includes(expectSubstring)) {
      problems.push(`expected detail to contain ${JSON.stringify(expectSubstring)}, got: ${result.detail}`);
    }
    // A non-fail status must never count as a failure upstream.
    if (result.pass !== (status !== "fail")) problems.push(`pass flag ${result.pass} disagrees with status ${status}`);
  }
  if (problems.length) {
    failures++;
    console.error(`FAIL unit: ${name}`);
    for (const p of problems) console.error(`   - ${p}`);
  } else {
    console.log(`ok   unit: ${name}`);
  }
}

/** Assert on checks 8-10, which need a profile descriptor and a window. */
function check(
  name: string,
  state: Partial<HarnessState>,
  id: CheckResult["id"],
  expectStatus: string,
  expectSubstring: string,
  profile: ProfileDescriptor = PROFILE,
): void {
  const merged = { ...baseState(), ...state } as HarnessState;
  assertCheck(name, evaluateProfileChecks(merged, profile, 10), id, expectStatus, expectSubstring);
}

/** Assert on the seven core checks, which run on every target. */
function coreCheck(
  name: string,
  state: Partial<HarnessState>,
  id: CheckResult["id"],
  expectStatus: string,
  expectSubstring: string,
): void {
  const merged = { ...baseState(), ...state } as HarnessState;
  assertCheck(name, evaluateChecks(merged), id, expectStatus, expectSubstring);
}

/* ----------------------------------------------- d ui/initialize handshake */

// ext-apps#671: a view that fires ui/notifications/initialized without awaiting
// the reply sails through a rejection, so every later check still looks healthy.
// The reply arriving is not the same as the handshake succeeding.
coreCheck("d fail when the host rejected ui/initialize",
  {
    htmlInjectedAt: 100, uiInitializeAt: 150, uiInitializeRespondedAt: 200,
    uiInitializeError: "-32603: invalid_type at params.appInfo",
  },
  "ui-initialize", "fail", "REJECTED the app's ui/initialize (-32603: invalid_type at params.appInfo)");

coreCheck("d pass on a clean handshake inside the deadline",
  { htmlInjectedAt: 100, uiInitializeAt: 150, uiInitializeRespondedAt: 200 },
  "ui-initialize", "pass", "handshake completed in 100 ms");

/* ------------------------------------------- 8 tool-result redelivery */

check("8 skip when no second call was attempted", {}, "tool-result-redelivery",
  "skip", "never attempted");

check("8 skip when the tool is not argument-sensitive",
  { secondCall: { skipped: "tool is not argument-sensitive — it has no input property to vary between calls" } },
  "tool-result-redelivery", "skip", "not argument-sensitive");

check("8 skip when tool-result #1 never arrived",
  { secondCall: { sentAt: 100 } },
  "tool-result-redelivery", "skip", "redelivery unobservable");

check("8 fail when the profile withholds redelivery",
  { firstToolResultDeliveredAt: 50, secondCall: { sentAt: 100, withheld: true } },
  "tool-result-redelivery", "fail", "ext-apps#750 symptom 1");

check("8 fail when the second call errors",
  { firstToolResultDeliveredAt: 50, secondCall: { sentAt: 100, resultIsError: true, resultErrorMsg: "boom" } },
  "tool-result-redelivery", "fail", "threw (boom)");

check("8 fail when nothing is redelivered inside the window",
  { firstToolResultDeliveredAt: 50, secondCall: { sentAt: 100 } },
  "tool-result-redelivery", "fail", "no tool-result after the second tools/call (10.0s)");

check("8 pass reports the measured latency and the varied argument",
  { firstToolResultDeliveredAt: 50, secondCall: { label: 'city: "Osaka"', sentAt: 100, deliveredAt: 512 } },
  "tool-result-redelivery", "pass", 'second tool-result observed after 412ms (city: "Osaka")');

/* --------------------------------------- 9 multi-instance isolation */

check("9 skip when a second instance was never attempted", {}, "multi-instance-isolation",
  "skip", "never attempted");

check("9 skip on a singleton ui:// resource",
  { instance2: { skipped: "second resources/read failed (singleton ui:// resource): not found", leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "skip", "singleton ui:// resource");

check("9 skip when the profile mounts only one instance",
  { instance2: { skipped: "profile grok mounts at most 1 concurrent instance", leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "skip", "at most 1 concurrent instance");

check("9 skip when instance #2 was never injected",
  { instance2: { leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "skip", "never injected");

check("9 fail when instance #2 mounts but never completes the handshake",
  { instance2: { mountedAt: 200, leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "fail", "never completed the ui/initialize handshake");

check("9 fail names the direction and count of the leak",
  { instance2: { mountedAt: 200, uiInitializeRespondedAt: 220, leaksOn1: 0, leaksOn2: 3 } },
  "multi-instance-isolation", "fail", "instance #2 received 3 message(s) addressed to instance #1");

check("9 fail also catches the reverse direction",
  { instance2: { mountedAt: 200, uiInitializeRespondedAt: 220, leaksOn1: 2, leaksOn2: 0 } },
  "multi-instance-isolation", "fail", "instance #1 received 2 message(s) addressed to instance #2");

check("9 fail when instance #2's ui/initialize was rejected",
  { instance2: { mountedAt: 200, uiInitializeRespondedAt: 220, uiInitializeError: "-32603: bad params", leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "fail", "instance #2's ui/initialize was REJECTED (-32603: bad params)");

check("9 pass on two clean isolated handshakes",
  { instance2: { mountedAt: 200, uiInitializeRespondedAt: 220, leaksOn1: 0, leaksOn2: 0 } },
  "multi-instance-isolation", "pass", "two distinct ui/initialize handshakes completed");

/* ------------------------------------------- 10 external navigation */

check("10 skip when the probe never ran", {}, "external-navigation",
  "skip", "did not run");

check("10 skip when the app frame was unreachable",
  { navProbe: { popupsAllowed: false, error: "navigation probe skipped: app frame not found" } },
  "external-navigation", "skip", "app frame not found");

check("10 info when the sandbox blocks and no popups were granted",
  { navProbe: { popupsAllowed: false, windowOpen: "blocked", anchor: "blocked", sandboxConsoleSeen: true } },
  "external-navigation", "info", "blocked by sandbox (no allow-popups)");

check("10 fail when navigation escapes a sandbox that grants no popups",
  { navProbe: { popupsAllowed: false, windowOpen: "opened", anchor: "blocked" } },
  "external-navigation", "fail", "was NOT blocked although this profile grants no allow-popups");

const POPUPS_OK: ProfileDescriptor = { ...PROFILE, popupsAllowed: true };

check("10 pass when the profile grants popups and navigation succeeds",
  { navProbe: { popupsAllowed: true, windowOpen: "opened", anchor: "opened" } },
  "external-navigation", "pass", "allow-popups granted by this profile", POPUPS_OK);

check("10 fail blames the SANDBOX when the console named it",
  { navProbe: { popupsAllowed: true, windowOpen: "blocked", anchor: "blocked", sandboxConsoleSeen: true } },
  "external-navigation", "fail", "blocked at the sandbox level although popupsAllowed=true", POPUPS_OK);

// The branch the brief calls out: Playwright/Chromium blocking the popup at
// the browser level must not be reported as a sandbox (host) defect.
check("10 fail blames the BROWSER when no sandbox message was seen",
  { navProbe: { popupsAllowed: true, windowOpen: "blocked", anchor: "blocked", sandboxConsoleSeen: false } },
  "external-navigation", "fail", "not by the sandbox — a browser-level popup block", POPUPS_OK);

/* --------------------------------------- 11 aggregator-safe tool names */

const AGG = {
  prefix: "alpha__",
  separator: "__",
  advertised: "alpha__get-weather",
  upstream: "get-weather",
  listedViaBridge: false,
};

function aggCheck(
  name: string,
  aggregator: HarnessState["aggregator"],
  expectStatus: string,
  expectSubstring: string,
): void {
  const merged = { ...baseState(), aggregator } as HarnessState;
  const result = evaluateAggregatorCheck(merged);
  assertCheck(name, result ? [result] : [], "aggregator-safe-tool-names", expectStatus, expectSubstring);
}

// Without a rewrite the check does not exist at all — aggregation is a
// deployment shape, so it must not appear on a bare spec run.
{
  const absent = evaluateAggregatorCheck(baseState());
  if (absent !== null) {
    failures++;
    console.error("FAIL unit: 11 is not evaluated without --aggregator");
    console.error(`   - expected null, got ${JSON.stringify(absent)}`);
  } else {
    console.log("ok   unit: 11 is not evaluated without --aggregator");
  }
}

// SKIP, not a second failure: check 6 already reports an app that never called.
aggCheck("11 skip when the app never initiated a tools/call",
  { ...AGG, appCalls: [] },
  "skip", "the app never initiated a tools/call");

aggCheck("11 fail names the bare frame and both issues",
  { ...AGG, appCalls: [{ name: "get-weather", bare: true }] },
  "fail",
  'app sent tools/call name="get-weather" but the host advertised "alpha__get-weather" in ' +
    "hostContext.toolInfo.tool.name; a namespacing aggregator answers -32043 for the bare name " +
    "and every interaction after mount fails (ext-apps#745, #753)");

// ext-apps#745's own report is an app calling a SIBLING tool on the same
// server, so the message names what the host advertises for THAT name.
aggCheck("11 fail names the sibling tool the app asked for",
  { ...AGG, appCalls: [{ name: "get-time", bare: true, advertisedFor: "alpha__get-time" }] },
  "fail", 'app sent tools/call name="get-time" but the host advertised "alpha__get-time"');

aggCheck("11 fail even when a later call used the right name",
  {
    ...AGG,
    appCalls: [{ name: "alpha__get-weather", bare: false }, { name: "get-weather", bare: true }],
  },
  "fail", 'app sent tools/call name="get-weather"');

aggCheck("11 pass counts the app's calls",
  {
    ...AGG,
    appCalls: [
      { name: "alpha__get-weather", bare: false },
      { name: "alpha__get-weather", bare: false },
    ],
  },
  "pass", 'app resolved "alpha__get-weather" from hostContext.toolInfo (2 app call(s), 0 bare)');

// ext-apps#745 names tools/list as the other correct route, so say which one
// the app actually took.
aggCheck("11 pass credits tools/list when the app listed through the bridge",
  { ...AGG, listedViaBridge: true, appCalls: [{ name: "alpha__get-weather", bare: false }] },
  "pass", 'app resolved "alpha__get-weather" from tools/list through the bridge');

aggCheck("11 pass when the upstream name already carried the separator",
  {
    ...AGG,
    advertised: "alpha__get-weather",
    upstream: "alpha__get-weather",
    appCalls: [{ name: "alpha__get-weather", bare: false }],
  },
  "pass", 'tool name "alpha__get-weather" already carries the "__" separator');

/* ------------------------------------------- aggregator name mapping */

function assertAggregator(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL unit: ${name}`);
    console.error(`   - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   unit: ${name}`);
  }
}

{
  const agg = createAggregator(DEFAULT_AGGREGATOR_PREFIX, ["get-weather", "alpha__already"]);
  assertAggregator("aggregator prefixes a bare name", agg.advertise("get-weather"), "alpha__get-weather");
  assertAggregator("aggregator does not double-prefix", agg.advertise("alpha__already"), "alpha__already");
  assertAggregator("aggregator derives the separator from the prefix", agg.separator, "__");
  assertAggregator("aggregator resolves an advertised name", agg.upstream("alpha__get-weather"), "get-weather");
  // The #745 failure: the bare name belongs to no namespace the gateway owns.
  assertAggregator("aggregator owns no bare name", agg.upstream("get-weather"), undefined);
  assertAggregator("aggregator rejects an unknown name", agg.upstream("alpha__nope"), undefined);
  assertAggregator("aggregator recognises what it advertises", agg.isAdvertised("alpha__get-weather"), true);

  const dotted = createAggregator("gateway.", ["get-weather"]);
  assertAggregator("a dotted prefix separates on the dot", dotted.advertise("get-weather"), "gateway.get-weather");
  assertAggregator("a dotted prefix keeps its separator", dotted.separator, ".");
}

{
  const err = new UnknownNamespaceError("get-weather");
  assertAggregator("the refusal carries the #745 code", err.code, -32043);
  assertAggregator("the refusal carries the #745 message", err.message,
    'unknown name "get-weather": no upstream owns this namespace');
}

/* ------------------------------------------------------------ totals */

console.log(
  failures ? `\n${failures} unit assertion(s) FAILED` : "\nall unit assertions behaved as expected",
);
process.exit(failures ? 1 : 0);
