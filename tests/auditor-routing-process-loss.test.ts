import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { readState } from "../extensions/goal-loop-core.ts";
import { cancelDetachedGoalCompletionAuditor, runDetachedGoalCompletionAuditor } from "../extensions/goal-loop-auditor-process.ts";
import { readAuditorReplay } from "../extensions/auditor-replay.ts";

const host = path.resolve("tests/fixtures/auditor-policy-host.ts");
async function until(predicate: () => boolean, limit = 20000): Promise<void> {
  const end = Date.now() + limit;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("fixture event deadline exhausted");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

const malformedResults: Record<string, Record<string, unknown>> = {
  "ok-string": { ok: "false" }, "ok-number": { ok: 1 }, "ok-null": { ok: null }, "ok-missing": { ok: undefined },
  "thinking-number": { thinkingLevel: 1 }, "output-number": { output: 1 }, "tools-object": { toolCalls: {} },
  "tool-null": { toolCalls: [null] },
  "tool-name-number": { toolCalls: [{ name: 1, argsPrefix: "", finishedAt: 1 }] },
  "tool-args-number": { toolCalls: [{ name: "read", argsPrefix: 1, finishedAt: 1 }] },
  "tool-finished-string": { toolCalls: [{ name: "read", argsPrefix: "", finishedAt: "1" }] },
};
for (const { attempt, retained } of [
  { attempt: 1, retained: "none" }, { attempt: 2, retained: "none" },
  { attempt: 1, retained: "approved" }, { attempt: 1, retained: "corrupt" },
  { attempt: 1, retained: "deleted-after-preflight" },
  ...Object.keys(malformedResults).map((retained) => ({ attempt: 1, retained })),
]) {
  test(`real complete_goal process loss (attempt ${attempt}, retained ${retained}) reconciles without duplicate`, { timeout: 40000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-process-loss-"));
    const settingsPath = path.join(cwd, "settings.json");
    const callsPath = path.join(cwd, "calls.jsonl");
    const ready = path.join(cwd, "effect-observed");
    const fakePi = path.join(cwd, "peer.mjs");
    fs.writeFileSync(settingsPath, JSON.stringify({ aggressiveMode: false, auditorModel: "test/approved", auditorModelFallbacks: [], auditorAllowedExtensions: [] }));
    fs.writeFileSync(fakePi, `#!/usr/bin/env node
import fs from 'node:fs';
let buffer = '', handled = false;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (handled || !buffer.includes('\\n')) return;
  handled = true;
  const file = ${JSON.stringify(callsPath)};
  const count = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').length : 0;
  fs.appendFileSync(file, JSON.stringify({ argv: process.argv.slice(2), prompt: JSON.parse(buffer.split('\\n')[0]) }) + '\\n');
  const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  if (count + 1 < ${attempt}) {
    out({ type: 'error', errorMessage: '503 upstream unavailable' });
    out({ type: 'agent_settled' });
  } else {
    // The external denial happened, but the peer withholds settlement. Kill
    // the real host in this uncertainty window, not an exception simulation.
    if (${JSON.stringify(retained)} === 'none') out({ type: 'error', errorMessage: '402 Insufficient Balance' });
    fs.writeFileSync(${JSON.stringify(ready)}, 'terminal effect observed');
    if (${JSON.stringify(retained)} !== 'none') {
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(path.join(cwd, "release-report"))})) return;
        clearInterval(timer);
        out({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'artifact' } });
        out({ type: 'tool_execution_end', toolCallId: 'read-1' });
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '<evidence>\\nartifact exists\\n</evidence>\\n<approved/>' } });
        out({ type: 'agent_settled' });
      }, 10);
    }
  }
});
`, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: settingsPath, GLLA_PI_BINARY: fakePi };
    delete env.GLLA_GLOBAL_SETTINGS_SHA256;
    let child: ChildProcess | undefined;
    let logicalAttempt: string | undefined;
    const previous = process.env.GLLA_GLOBAL_SETTINGS_PATH;
    const previousHash = process.env.GLLA_GLOBAL_SETTINGS_SHA256;
    process.env.GLLA_GLOBAL_SETTINGS_PATH = settingsPath;
    delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
    const output: string[] = [];
    const start = (mode: string) => {
      const process = spawn(globalThis.process.execPath, [host, cwd, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
      process.stdout!.on("data", (data) => output.push(String(data)));
      process.stderr!.on("data", (data) => output.push(String(data)));
      return process;
    };
    try {
      child = start("start");
      await until(() => fs.existsSync(ready));
      const claim = readState(cwd).goal!.pendingCompletion!;
      logicalAttempt = claim.attemptId;
      assert.ok(claim.auditorRoutingContract?.fingerprint);
      assert.equal(claim.auditorDispatchStarted?.attempt, attempt);
      assert.equal(claim.auditorDispatchStarted?.ref, "test/approved");
      const receipt = JSON.stringify(claim.auditorDispatchStarted);
      const before = fs.readFileSync(callsPath, "utf8");
      assert.equal(before.trim().split("\n").length, attempt);
      if (retained !== "none") {
        child.kill("SIGSTOP");
        fs.writeFileSync(path.join(cwd, "release-report"), "ready");
        const resultFile = path.join(cwd, ".pi-glla", "audit-jobs", claim.auditorDispatchStarted!.id, "result.json");
        await until(() => fs.existsSync(resultFile));
        if (retained === "corrupt" || malformedResults[retained]) {
          const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          Object.assign(result, retained === "corrupt" ? { requestHash: "mismatched" } : malformedResults[retained]);
          fs.writeFileSync(resultFile, JSON.stringify(result));
        }
      }
      child.kill("SIGKILL"); await stopped(child);
      // Reap only the owned detached claim; the next host has no conversation
      // or inherited JS module state and cannot mistake cleanup for approval.
      assert.ok(logicalAttempt);
      cancelDetachedGoalCompletionAuditor(cwd, logicalAttempt);
      if (retained === "deleted-after-preflight") {
        const goal = readState(cwd).goal!;
        const jobDir = path.join(cwd, ".pi-glla", "audit-jobs", claim.auditorDispatchStarted!.id);
        fs.rmSync(path.join(jobDir, "progress.json"), { force: true });
        const request = readAuditorReplay(cwd, goal, claim)!;
        assert.ok(request, "intact result-only job passes real preflight");
        let spawns = 0;
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 1000);
        try {
          const completion = runDetachedGoalCompletionAuditor({
            cwd, goal, model: request.model, thinkingLevel: request.thinkingLevel,
            allowedExtensions: request.allowedExtensions, signal: controller.signal,
            runtime: { replay: true, attemptId: () => request.attemptId, pollIntervalMs: 10,
              spawn: (() => { spawns++; throw new Error("unexpected replay spawn"); }) as any },
          });
          // Replay preflight is synchronous up to its first await (progress
          // read). Remove the result before that read settles and polling consumes it.
          fs.unlinkSync(path.join(jobDir, "result.json"));
          const result = await completion;
          assert.equal(controller.signal.aborted, false, "replay must terminate without the safety deadline");
          assert.match(result.error ?? "", /outcome unknown/);
          assert.equal(result.approved, false); assert.equal(result.disapproved, false);
          assert.equal(result.fallbackExhausted, true);
          assert.equal(spawns, 0);
          assert.equal(JSON.stringify(readState(cwd).goal!.pendingCompletion!.auditorDispatchStarted), receipt);
        } finally { clearTimeout(deadline); controller.abort(); }
      }
      child = start("resume");
      await until(() => fs.existsSync(path.join(cwd, "resume-receipt.json")));
      await stopped(child);
      assert.equal(child.exitCode, 0, output.join(""));
      const after = JSON.parse(fs.readFileSync(path.join(cwd, "resume-receipt.json"), "utf8"));
      assert.equal(fs.readFileSync(callsPath, "utf8"), before, "no second terminal effect or third call");
      if (retained === "approved") {
        assert.equal(after.state.goal, null, "retained approval settles through normal archive/shield path");
        assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).filter((name) => name.endsWith(".md")).length, 1);
      } else {
        assert.ok(after.state.goal, "unknown or malformed retained evidence must never archive the goal");
        assert.equal(JSON.stringify(after.state.goal.pendingCompletion.auditorDispatchStarted), receipt);
        assert.equal(after.state.goal.pendingCompletion.auditorFailureCount, claim.auditorFailureCount);
        assert.match(JSON.stringify(after), /outcome unknown/);
      }
      fs.unlinkSync(path.join(cwd, "resume-receipt.json"));
      child = start("resume");
      await until(() => fs.existsSync(path.join(cwd, "resume-receipt.json")));
      await stopped(child);
      assert.equal(fs.readFileSync(callsPath, "utf8"), before, "replay remains effect-free");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await stopped(child); }
      if (logicalAttempt) cancelDetachedGoalCompletionAuditor(cwd, logicalAttempt);
      if (previous === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH; else process.env.GLLA_GLOBAL_SETTINGS_PATH = previous;
      if (previousHash === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_SHA256; else process.env.GLLA_GLOBAL_SETTINGS_SHA256 = previousHash;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
