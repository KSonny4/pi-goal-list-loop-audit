import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { captureGoalRevision, piGlaDir, type Goal, type PendingCompletion } from "./goal-loop-core.js";
import { auditorPolicyError } from "./auditor-policy-snapshot.js";
import { requestHash, stableJson } from "./auditor-protocol-hash.js";
import type { AuditorRequest } from "./goal-loop-auditor-process.js";

export function auditRepositoryHead(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2000 });
  return result.status === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

/** Retained JSON is untrusted at both preflight and consumption. */
export function validateRetainedAuditorResult(result: unknown): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw auditorPolicyError("previous dispatch outcome unknown: malformed retained result");
  const value = result as Record<string, unknown>;
  if (typeof value.ok !== "boolean" || typeof value.output !== "string" || typeof value.thinkingLevel !== "string"
    || typeof value.protocolVersion !== "number" || typeof value.attemptId !== "string" || typeof value.requestHash !== "string" || typeof value.model !== "string"
    || !Array.isArray(value.toolCalls) || value.toolCalls.some((call: unknown) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) return true;
      const tool = call as Record<string, unknown>;
      return typeof tool.name !== "string" || typeof tool.argsPrefix !== "string" || typeof tool.finishedAt !== "number" || !Number.isFinite(tool.finishedAt);
    })) throw auditorPolicyError("previous dispatch outcome unknown: malformed retained result");
}

/** Reconcile only the exact persisted dispatch. Missing/corrupt or mismatched
 * artifacts remain unknown; never synthesize a verdict or rerun that effect. */
export function readAuditorReplay(cwd: string, goal: Goal, claim: PendingCompletion): AuditorRequest | undefined {
  const started = claim.auditorDispatchStarted;
  if (started === undefined) return undefined;
  try {
    if (!started || !/^[a-zA-Z0-9_-]+$/.test(started.id) || !started.requestHash
      || started.repositoryHead !== auditRepositoryHead(cwd)) throw new Error("dispatch binding missing or repository HEAD changed");
    const dir = path.join(piGlaDir(cwd), "audit-jobs", started.id);
    const request = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8")) as AuditorRequest;
    const { requestHash: hash, ...payload } = request;
    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    validateRetainedAuditorResult(result);
    if (hash !== started.requestHash || requestHash(payload) !== hash || request.attemptId !== started.id
      || request.model !== started.ref || request.cwd !== cwd
      || stableJson(request.goalRevision) !== stableJson(captureGoalRevision(goal))
      || result.protocolVersion !== 1 || result.attemptId !== started.id || result.requestHash !== hash
      || result.model !== request.model) throw new Error("retained result identity mismatch");
    return request;
  } catch (error) {
    throw auditorPolicyError(`previous dispatch outcome unknown: ${error instanceof Error ? error.message : String(error)}`);
  }
}
