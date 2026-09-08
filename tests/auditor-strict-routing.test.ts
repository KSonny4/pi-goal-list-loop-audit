import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadSettings, projectSettingsPath } from "../extensions/goal-settings.ts";
import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";
import { runAuditorFallbackWithPolicy } from "../extensions/goal-loop-auditor-process.ts";

// Only the host registry is fake: settings precedence and candidate selection
// execute the production loader/resolver against private, nonempty files.
function withSettings(project: Record<string, unknown>, check: (ctx: ExtensionContext) => void): void {
  const cwd = mkdtempSync(path.join(tmpdir(), "glla-strict-routing-"));
  const previous = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const models = ["approved", "stale", "session"].map((id) => ({ provider: "test", id }));
  try {
    const globalFile = path.join(cwd, "global.json");
    writeFileSync(globalFile, JSON.stringify({
      stateRoot: "workingDir",
      auditorModelFallbacks: ["test/stale"],
    }));
    process.env.GLLA_GLOBAL_SETTINGS_PATH = globalFile;
    const projectFile = projectSettingsPath(cwd);
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify(project));
    const ctx = {
      cwd,
      model: models[2],
      modelRegistry: {
        find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => models,
        hasConfiguredAuth: () => true,
      },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;
    check(ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("strict routing: explicit project empty fallbacks replace stale global routes", () => {
  withSettings({ auditorModel: "test/approved", auditorModelFallbacks: [] }, (ctx) => {
    const effective = loadSettings(ctx.cwd);
    assert.equal(effective.auditorModel, "test/approved");
    assert.deepEqual(effective.auditorModelFallbacks, []);
  });
});

test("strict routing: absent project fallbacks still inherit the global list", () => {
  withSettings({ auditorModel: "test/approved" }, (ctx) => {
    assert.deepEqual(loadSettings(ctx.cwd).auditorModelFallbacks, ["test/stale"]);
  });
});

test("strict routing: explicit primary and empty list never append the distinct session route", () => {
  withSettings({ auditorModel: "test/approved", auditorModelFallbacks: [] }, (ctx) => {
    // Pass the explicit list directly to isolate resolver closure from the
    // separately asserted settings precedence defect.
    const resolved = resolveAuditorModel(ctx, "test/approved", [], true);
    const refs = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate) => candidate.model)]
      .map((model) => `${model.provider}/${model.id}`);
    assert.deepEqual(refs, ["test/approved"]);
  });
});

for (const error of ["402 Insufficient Balance", "401 invalid API key"]) {
  test(`strict routing: terminal ${error} calls the route once and advances without cooldown`, async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const candidates = ["primary", "approved-fallback"].map((id) => ({
      ref: `test/${id}`, model: { provider: "test", id }, via: "setting",
    }));
    const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
      calls.push(candidate.ref!);
      return {
        approved: candidate.ref === "test/approved-fallback",
        disapproved: false,
        output: "",
        model: candidate.ref!,
        ...(candidate.ref === "test/primary" ? { error } : {}),
      };
    }, {
      shouldRetry: () => true,
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepEqual({ calls, waits }, {
      calls: ["test/primary", "test/approved-fallback"], waits: [],
    });
    assert.equal(outcome.result.approved, true);
    assert.equal(outcome.retriedOnce, false);
    assert.equal(outcome.fallbackUsed, true);
  });
}
