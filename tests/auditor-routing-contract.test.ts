import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { captureAuditorRoutingContract, assertAuditorRoutingContract, authorizeAuditorClaim, auditorDispatchStarted } from "../extensions/auditor-routing-contract.ts";
import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";
import { readState } from "../extensions/goal-loop-core.ts";
import { runAuditorFallbackWithPolicy, runDetachedGoalCompletionAuditor } from "../extensions/goal-loop-auditor-process.ts";
import { seedGoal, seedState } from "./harness/mock-pi.ts";

async function fixture(check: (f: { cwd: string; ctx: any; settings: (patch: Record<string, unknown>) => void; models: Map<string, any> }) => void | Promise<void>): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-contract-"));
  const previous = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const hash = process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(cwd, "global.json");
  const models = new Map(["primary", "fallback", "session"].map((id) => [`test/${id}`, { provider: "test", id, name: `alias-${id}` }]));
  const settings = (patch: Record<string, unknown>) => fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({ auditorModel: "test/primary", auditorModelFallbacks: ["test/fallback"], auditorAllowedExtensions: [], ...patch }));
  const ctx: any = { cwd, model: models.get("test/session"), thinkingLevel: "high", ui: { notify() {} }, modelRegistry: {
    find: (provider: string, id: string) => models.get(`${provider}/${id}`), getAvailable: () => [...models.values()], hasConfiguredAuth: () => true,
  } };
  try { settings({}); await check({ cwd, ctx, settings, models }); }
  finally {
    if (previous === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH; else process.env.GLLA_GLOBAL_SETTINGS_PATH = previous;
    if (hash === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_SHA256; else process.env.GLLA_GLOBAL_SETTINGS_SHA256 = hash;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("contract survives real pending-completion codec and unchanged resume", () => fixture(({ cwd, ctx }) => {
  const contract = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  seedState(cwd, { goal: seedGoal({ pendingCompletion: { phase: "retry-waiting", completionSummary: "nonempty evidence", auditorRoutingContract: contract, auditorCandidateRef: "test/primary", auditorRetryCandidateRef: "test/primary", auditorFailureCount: 1 } }) });
  const claim = readState(cwd).goal!.pendingCompletion!;
  assert.deepEqual(claim.auditorRoutingContract, contract);
  assert.doesNotThrow(() => authorizeAuditorClaim(claim, captureAuditorRoutingContract(ctx, resolveAuditorModel), false));
  assert.equal(claim.auditorFailureCount, 1);
}));

for (const patch of [
  { auditorModel: "test/fallback" }, { auditorModelFallbacks: [] }, { forbiddenModels: ["test/fallback"] },
  { auditorThinkingLevel: "low" }, { auditorSameSessionSwap: false },
]) {
  test(`changed ${Object.keys(patch)[0]} blocks without mutating spent cursor`, () => fixture(({ ctx, settings }) => {
    const claim: any = { auditorRoutingContract: captureAuditorRoutingContract(ctx, resolveAuditorModel), auditorAttemptedRefs: ["test/primary"], auditorRetryCandidateRef: "test/fallback", auditorFailureCount: 1 };
    const before = JSON.stringify(claim);
    settings(patch);
    assert.throws(() => authorizeAuditorClaim(claim, captureAuditorRoutingContract(ctx, resolveAuditorModel), false), /policy/i);
    assert.equal(JSON.stringify(claim), before);
  }));
}

test("legacy and malformed identity stay blocked after real state reload", () => fixture(({ cwd, ctx }) => {
  for (const value of [undefined, {}, { version: 2, fingerprint: "fake", routes: ["test/primary"], extensions: [] }]) {
    seedState(cwd, { goal: seedGoal({ pendingCompletion: { completionSummary: "retained claim", auditorRoutingContract: value, auditorFailureCount: 1 } }) });
    const claim = readState(cwd).goal!.pendingCompletion!;
    assert.throws(() => authorizeAuditorClaim(claim, captureAuditorRoutingContract(ctx, resolveAuditorModel), false), /legacy identity unknown/);
    assert.equal(claim.auditorFailureCount, 1);
  }
}));

for (const attempt of [1, 2] as const) {
  test(`started attempt ${attempt} remains unknown after reload, never authorizes duplicate`, () => fixture(({ cwd, ctx }) => {
    const contract = captureAuditorRoutingContract(ctx, resolveAuditorModel);
    const started = auditorDispatchStarted("test/primary", attempt);
    seedState(cwd, { goal: seedGoal({ pendingCompletion: { phase: "running", auditorRoutingContract: contract, auditorDispatchStarted: started, auditorFailureCount: attempt - 1 } }) });
    const claim = readState(cwd).goal!.pendingCompletion!;
    assert.deepEqual(claim.auditorDispatchStarted, started);
    assert.throws(() => authorizeAuditorClaim(claim, contract, false), /outcome unknown/);
    assert.equal(claim.auditorFailureCount, attempt - 1);
  }));
}

test("qualified alias identity and duplicate routes are pinned", () => fixture(({ ctx, settings }) => {
  settings({ auditorModel: "alias-primary", auditorModelFallbacks: ["primary", "test/fallback", "alias-fallback"] });
  const contract = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  assert.deepEqual(contract.routes, ["test/primary", "test/fallback"]);
  const resolved = resolveAuditorModel(ctx, "alias-primary", ["alias-fallback"], true);
  assert.equal(resolved.fallbackModels![0]!.ref, "test/fallback");
}));

test("registry alias retarget cannot silently change dispatch identity", () => fixture(({ ctx, settings, models }) => {
  settings({ auditorModel: "alias-primary" });
  const previous = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  models.get("test/primary").name = "retired";
  models.get("test/fallback").name = "alias-primary";
  assert.throws(() => assertAuditorRoutingContract(previous, captureAuditorRoutingContract(ctx, resolveAuditorModel)), /policy/);
}));

test("missing required extension blocks; symlink resolution drift changes identity", () => fixture(({ cwd, ctx, settings }) => {
  settings({ auditorAllowedExtensions: [path.join(cwd, "missing.ts")] });
  assert.throws(() => captureAuditorRoutingContract(ctx, resolveAuditorModel), /required extension/);
  const a = path.join(cwd, "a.ts"), b = path.join(cwd, "b.ts"), link = path.join(cwd, "active.ts");
  fs.writeFileSync(a, "export default function() {}\n"); fs.writeFileSync(b, "export default function() {}\n");
  fs.symlinkSync(a, link);
  settings({ auditorAllowedExtensions: [link] });
  const before = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  assert.deepEqual(before.extensions, [fs.realpathSync(a)]);
  fs.unlinkSync(link); fs.symlinkSync(b, link);
  assert.throws(() => assertAuditorRoutingContract(before, captureAuditorRoutingContract(ctx, resolveAuditorModel)), /policy/);
}));

test("late asynchronous setup policy change prevents actual detached spawn", () => fixture(async ({ cwd, ctx, settings }) => {
  const contract = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  let spawns = 0;
  const result = await runDetachedGoalCompletionAuditor({
    cwd, goal: seedGoal() as any, model: "test/primary",
    onProgress: () => settings({ auditorModel: "test/fallback" }),
    validateDispatch: () => assertAuditorRoutingContract(contract, captureAuditorRoutingContract(ctx, resolveAuditorModel)),
    runtime: { spawn: (() => { spawns++; throw new Error("must not spawn"); }) as any },
  });
  assert.equal(spawns, 0);
  assert.equal(result.approved, false);
  assert.equal(result.disapproved, false);
  assert.equal(result.fallbackExhausted, true);
  assert.match(result.error!, /policy/);
}));

for (const error of ["402 Insufficient Balance", "401 invalid API key"]) {
  test(`terminal exhaustion ${error} persists before returning and never becomes verdict`, async () => {
    const events: string[] = [];
    const outcome = await runAuditorFallbackWithPolicy([{ ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" }], async () => {
      events.push("effect"); return { approved: false, disapproved: false, output: "", model: "test/primary", error };
    }, {
      onAttempt: () => { events.push("started"); }, onCandidateExhausted: (_c, _e, info) => { events.push("exhausted"); assert.equal(info.delayMs, 0); },
      sleep: async () => { assert.fail("permanent failure must not wait"); },
    });
    assert.deepEqual(events, ["started", "effect", "exhausted"]);
    assert.equal(outcome.result.fallbackExhausted, true);
    assert.equal(outcome.result.approved, false); assert.equal(outcome.result.disapproved, false);
  });
}

test("terminal exhaustion persistence refusal stops before next authorized effect", async () => {
  let calls = 0;
  const outcome = await runAuditorFallbackWithPolicy(["one", "two"].map((id) => ({ ref: `test/${id}`, model: { provider: "test", id }, via: "setting" })), async () => {
    calls++; return { approved: false, disapproved: false, output: "", model: "test/one", error: "402 Insufficient Balance" };
  }, { onCandidateExhausted: () => false });
  assert.equal(calls, 1); assert.match(outcome.result.error!, /cursor persistence failed/);
});

test("cancelled walker starts no effect and no persistence callback", async () => {
  await runAuditorFallbackWithPolicy([{ ref: "test/one", model: { provider: "test", id: "one" }, via: "setting" }], async () => { assert.fail("cancelled effect"); }, {
    shouldRetry: () => false, onAttempt: () => assert.fail("cancelled cursor mutation"),
  });
});

test("request pins captured extension path and rejects raw alias drift after setup", () => fixture(async ({ cwd, ctx, settings }) => {
  const a = path.join(cwd, "one.ts"), b = path.join(cwd, "two.ts"), alias = path.join(cwd, "alias.ts");
  fs.writeFileSync(a, "export default function() {}\n"); fs.writeFileSync(b, "export default function() {}\n");
  fs.symlinkSync(a, alias);
  settings({ auditorAllowedExtensions: [alias] });
  const contract = captureAuditorRoutingContract(ctx, resolveAuditorModel);
  let launches = 0;
  const result = await runDetachedGoalCompletionAuditor({
    cwd, goal: seedGoal() as any, model: "test/primary", allowedExtensions: contract.extensions,
    onProgress: () => { fs.unlinkSync(alias); fs.symlinkSync(b, alias); },
    validateDispatch: () => assertAuditorRoutingContract(contract, captureAuditorRoutingContract(ctx, resolveAuditorModel)),
    runtime: { spawn: (() => { launches++; throw new Error("unexpected spawn"); }) as any },
  });
  assert.deepEqual(contract.extensions, [fs.realpathSync(a)]);
  assert.equal(launches, 0); assert.match(result.error!, /policy/);
  assert.equal(result.fallbackExhausted, true);
}));

for (const kind of ["missing", "ambiguous"]) {
  test(`transport blocks ${kind} required npm extension without any spawn`, () => fixture(async ({ cwd }) => {
    const home = path.join(cwd, "home");
    if (kind === "ambiguous") {
      fs.mkdirSync(path.join(home, ".pi", "agent", "npm", "node_modules", "required-plugin"), { recursive: true });
      fs.mkdirSync(path.join(cwd, ".pi", "npm", "node_modules", "required-plugin"), { recursive: true });
    }
    let launches = 0;
    const result = await runDetachedGoalCompletionAuditor({
      cwd, goal: seedGoal() as any, model: "test/primary", allowedExtensions: ["npm:required-plugin"],
      runtime: { homeDir: home, spawn: (() => { launches++; throw new Error("unexpected spawn"); }) as any },
    });
    assert.equal(launches, 0); assert.match(result.error!, /missing or ambiguous/);
    assert.equal(result.approved, false); assert.equal(result.disapproved, false);
    assert.equal(result.fallbackExhausted, true);
  }));
}

test("unconfigured local mode retains session default but does not bypass forbidden policy", () => fixture(({ ctx, settings }) => {
  settings({ auditorModel: undefined, auditorModelFallbacks: [] });
  assert.equal(resolveAuditorModel(ctx).model, ctx.model);
  settings({ auditorModel: undefined, auditorModelFallbacks: [], forbiddenModels: ["test/session"] });
  assert.equal(resolveAuditorModel(ctx).model, undefined);
}));

for (const error of ["429 rate limit", "503 upstream unavailable", "Auditor stalled — timeout", "401 ambiguous gateway"]) {
  test(`nonterminal ${error} retains one retry and finite exhaustion`, async () => {
    const calls: string[] = [], waits: number[] = [];
    const outcome = await runAuditorFallbackWithPolicy([{ ref: "test/route", model: { provider: "test", id: "route" }, via: "setting" }], async (candidate) => {
      calls.push(candidate.ref!); return { approved: false, disapproved: false, output: "", model: "test/route", error };
    }, { sleep: async (ms) => { waits.push(ms); } });
    assert.deepEqual(calls, ["test/route", "test/route"]);
    assert.deepEqual(waits, [5000]); assert.equal(outcome.result.fallbackExhausted, true);
  });
}

test("cancellation during transient delay consumes no second effect", async () => {
  let live = true, calls = 0;
  const result = await runAuditorFallbackWithPolicy([{ model: { provider: "test", id: "route" }, via: "setting" }], async () => {
    calls++; return { approved: false, disapproved: false, output: "", model: "test/route", error: "503 unavailable" };
  }, { shouldRetry: () => live, sleep: async () => { live = false; } });
  assert.equal(calls, 1); assert.equal(result.retriedOnce, false);
});
