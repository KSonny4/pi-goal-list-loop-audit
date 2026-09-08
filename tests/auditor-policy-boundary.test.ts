import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadSettings, saveSettings, settingsProvenance } from "../extensions/goal-settings.ts";
import { resolveGllaStateDir } from "../extensions/glla-state-root.ts";
import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";

function fixture(check: (cwd: string, snapshot: string, pin: (patch?: Record<string, unknown>) => void) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-policy-boundary-"));
  const oldPath = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  const oldHash = process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  const snapshot = path.join(cwd, "snapshot.json");
  const pin = (patch: Record<string, unknown> = {}) => {
    const raw = JSON.stringify({ stateRoot: "workingDir", auditorModel: "test/approved", auditorModelFallbacks: [], auditorSameSessionSwap: false, auditorAllowedExtensions: [], ...patch });
    fs.writeFileSync(snapshot, raw, { mode: 0o600 });
    process.env.GLLA_GLOBAL_SETTINGS_PATH = snapshot;
    process.env.GLLA_GLOBAL_SETTINGS_SHA256 = createHash("sha256").update(raw).digest("hex");
  };
  try { pin(); check(cwd, snapshot, pin); }
  finally {
    if (oldPath === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH; else process.env.GLLA_GLOBAL_SETTINGS_PATH = oldPath;
    if (oldHash === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_SHA256; else process.env.GLLA_GLOBAL_SETTINGS_SHA256 = oldHash;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function project(cwd: string, value: unknown): void {
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify(value));
}

for (const kind of ["missing", "corrupt", "changed", "invalid-hash", "missing-path"]) {
  test(`snapshot boundary rejects ${kind} before selecting a state root`, () => fixture((cwd, snapshot) => {
    if (kind === "missing") fs.unlinkSync(snapshot);
    if (kind === "corrupt") fs.writeFileSync(snapshot, "{");
    if (kind === "changed") fs.writeFileSync(snapshot, JSON.stringify({ stateRoot: "sessionDir" }));
    if (kind === "invalid-hash") process.env.GLLA_GLOBAL_SETTINGS_SHA256 = "oops";
    if (kind === "missing-path") delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    assert.throws(() => resolveGllaStateDir(cwd), /auditor policy/i);
    assert.throws(() => loadSettings(cwd), /auditor policy/i);
  }));
}

for (const patch of [
  { auditorModel: "test/stale" }, { auditorModelFallbacks: ["test/stale"] },
  { auditorSameSessionSwap: true }, { auditorAllowedExtensions: ["/stale/plugin.ts"] },
  { stateRoot: "sessionDir" }, { auditorThinkingLevel: "low" },
]) {
  test(`snapshot rejects project conflict ${Object.keys(patch)[0]}`, () => fixture((cwd) => {
    project(cwd, patch);
    assert.throws(() => loadSettings(cwd), /auditor policy/i);
  }));
}

test("snapshot accepts consistent project pins and preserves unrelated budgets", () => fixture((cwd, _snapshot, pin) => {
  pin({ tokenLimit: 12345, auditorToolTimeoutMs: 90000 });
  project(cwd, { auditorModel: "test/approved", auditorModelFallbacks: [], auditorSameSessionSwap: false, auditorAllowedExtensions: [], stateRoot: "workingDir" });
  const settings = loadSettings(cwd);
  assert.equal(settings.tokenLimit, 12345);
  assert.equal(settings.auditorToolTimeoutMs, 90000);
  assert.deepEqual(settings.auditorModelFallbacks, []);
  assert.equal(resolveGllaStateDir(cwd), path.join(cwd, ".pi-glla"));
}));

for (const malformed of [null, 42, [], "test/stale"]) {
  test(`snapshot rejects non-object JSON ${JSON.stringify(malformed)}`, () => fixture((cwd, snapshot) => {
    const raw = JSON.stringify(malformed);
    fs.writeFileSync(snapshot, raw);
    process.env.GLLA_GLOBAL_SETTINGS_SHA256 = createHash("sha256").update(raw).digest("hex");
    assert.throws(() => loadSettings(cwd), /auditor policy/i);
  }));
}

for (const value of [null, "test/stale", [42], [""], {}]) {
  test(`ordinary project rejects malformed explicit fallback ${JSON.stringify(value)}`, () => fixture((cwd) => {
    delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
    project(cwd, { auditorModelFallbacks: value });
    assert.throws(() => loadSettings(cwd), /auditor policy/i);
  }));
}

test("project fallback save/provenance preserves [] distinct from inherit", () => fixture((cwd, _snapshot, pin) => {
  pin({ auditorModelFallbacks: ["test/stale"] });
  delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  saveSettings("project", cwd, { auditorModelFallbacks: [] });
  assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, []);
  assert.equal(settingsProvenance(cwd).auditorModelFallbacks.source, "project");
  saveSettings("project", cwd, { auditorModelFallbacks: undefined });
  assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, ["test/stale"]);
}));

test("legacy singular migrates but explicit plural empty wins", () => fixture((cwd) => {
  delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  project(cwd, { auditorModelFallback: "test/legacy" });
  assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, ["test/legacy"]);
  project(cwd, { auditorModelFallback: "test/legacy", auditorModelFallbacks: [] });
  assert.deepEqual(loadSettings(cwd).auditorModelFallbacks, []);
}));

for (const reason of ["missing", "auth", "forbidden", "no-registry"]) {
  test(`explicit unavailable primary ${reason} never authorizes session`, () => fixture((cwd) => {
    delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
    project(cwd, { forbiddenModels: reason === "forbidden" ? ["test/approved"] : [] });
    const model = { provider: "test", id: "approved" };
    const ctx = { cwd, model: { provider: "test", id: "session" }, ui: { notify() {} }, modelRegistry: reason === "no-registry" ? undefined : {
      find: () => reason === "missing" ? undefined : model,
      hasConfiguredAuth: () => reason !== "auth", getAvailable: () => [model],
    } } as any;
    const result = resolveAuditorModel(ctx, "test/approved", [], true);
    assert.equal(result.model, undefined);
    assert.ok(result.error);
  }));
}

test("enforced snapshot rejects exact host self-audit despite swap=false", () => fixture((cwd) => {
  const model = { provider: "test", id: "approved" };
  const ctx = { cwd, model, ui: { notify() {} }, modelRegistry: { find: () => model, hasConfiguredAuth: () => true, getAvailable: () => [model] } } as any;
  const result = resolveAuditorModel(ctx, "test/approved", [], false);
  assert.equal(result.model, undefined);
  assert.ok(result.error);
}));

for (const [primary, fallbacks, expected] of [
  ["test/session", [], []],
  ["test/session", ["test/approved"], ["test/approved"]],
  ["test/approved", ["test/session"], ["test/approved"]],
] as Array<[string, string[], string[]]>) {
  test(`local explicit independence ${primary} -> ${fallbacks.join(',')} with swap=false`, () => fixture((cwd) => {
    delete process.env.GLLA_GLOBAL_SETTINGS_SHA256;
    const models = ["approved", "session"].map((id) => ({ provider: "test", id }));
    const ctx = { cwd, model: models[1], ui: { notify() {} }, modelRegistry: {
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
      getAvailable: () => models, hasConfiguredAuth: () => true,
    } } as any;
    const resolved = resolveAuditorModel(ctx, primary, fallbacks, false);
    const refs = [resolved.model, ...(resolved.fallbackModels ?? []).map((c) => c.model)].filter(Boolean).map((m) => `${m.provider}/${m.id}`);
    assert.deepEqual(refs, expected);
    assert.equal(!!resolved.error, expected.length === 0);
  }));
}
