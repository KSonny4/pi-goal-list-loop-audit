// Dependency-free policy boundary shared by settings and state-root selection.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export function auditorPolicyError(reason: string): Error {
  return new Error(`Auditor policy authorization blocked: ${reason}`);
}

export function validateAuditorPolicyInput(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw auditorPolicyError("settings must be a JSON object");
  const settings = value as Record<string, unknown>;
  for (const key of ["auditorModel", "auditorModelFallback"]) {
    if (settings[key] !== undefined && (typeof settings[key] !== "string" || !settings[key].trim())) throw auditorPolicyError(`invalid ${key}`);
  }
  for (const key of ["auditorModelFallbacks", "auditorAllowedExtensions", "forbiddenModels"]) {
    const entries = settings[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((ref) => typeof ref !== "string" || !ref.trim()))) throw auditorPolicyError(`invalid ${key}`);
  }
  if (Array.isArray(settings.auditorAllowedExtensions) && settings.auditorAllowedExtensions.length > 32) throw auditorPolicyError("too many required extensions");
  if (settings.auditorSameSessionSwap !== undefined && typeof settings.auditorSameSessionSwap !== "boolean") throw auditorPolicyError("invalid auditorSameSessionSwap");
  if (settings.auditorThinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(settings.auditorThinkingLevel))) throw auditorPolicyError("invalid auditorThinkingLevel");
}

export function readAuditorPolicySnapshot(): Record<string, unknown> | undefined {
  const hash = process.env.GLLA_GLOBAL_SETTINGS_SHA256;
  if (hash === undefined) return undefined;
  const file = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  if (!file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash)) throw auditorPolicyError("invalid paired snapshot path/hash");
  try {
    const raw = fs.readFileSync(file);
    if (createHash("sha256").update(raw).digest("hex") !== hash) throw auditorPolicyError("snapshot hash mismatch");
    const value: unknown = JSON.parse(raw.toString("utf8"));
    validateAuditorPolicyInput(value);
    if (typeof value.auditorModel !== "string" || !/^[^/\s]+\/\S+$/.test(value.auditorModel)
      || !Array.isArray(value.auditorModelFallbacks) || value.auditorModelFallbacks.length !== 0
      || value.auditorSameSessionSwap !== false || value.stateRoot !== "workingDir"
      || !Array.isArray(value.auditorAllowedExtensions)) throw auditorPolicyError("snapshot requires independent single-route pins, extensions and workingDir");
    return value;
  } catch (error) {
    throw auditorPolicyError(error instanceof Error ? error.message : "snapshot unreadable");
  }
}

export function validateSnapshotOverrides(snapshot: Record<string, unknown> | undefined, project: Record<string, unknown>): void {
  if (!snapshot) return;
  for (const key of ["auditorModel", "auditorModelFallbacks", "auditorSameSessionSwap", "auditorAllowedExtensions", "stateRoot", "auditorThinkingLevel"]) {
    if (project[key] !== undefined && JSON.stringify(project[key]) !== JSON.stringify(snapshot[key])) throw auditorPolicyError(`project overrides enforced ${key}`);
  }
}
