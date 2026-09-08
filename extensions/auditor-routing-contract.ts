import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PendingCompletion } from "./goal-loop-core.js";
import { loadSettings } from "./goal-settings.js";
import { resolveAuditorAllowedExtensions } from "./auditor-extensions.js";
import { auditorPolicyError, readAuditorPolicySnapshot } from "./auditor-policy-snapshot.js";

type Resolution = { model?: Model<Api>; error?: string; fallbackModels?: Array<{ model: Model<Api> }> };
type Resolver = (ctx: ExtensionContext, primary?: string, fallbacks?: string[], swap?: boolean) => Resolution;
import type { AuditorRoutingContract } from "./auditor-routing-state.js";
export type { AuditorRoutingContract } from "./auditor-routing-state.js";

function qualified(model: Model<Api>): string {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") throw auditorPolicyError("route has no qualified model identity");
  return `${model.provider}/${model.id}`;
}

/** Capture effective authority, not just the subset currently available. Raw
 * authorization plus qualified dispatch routes fence aliases and removed refs. */
export function captureAuditorRoutingContract(ctx: ExtensionContext, resolve: Resolver): AuditorRoutingContract {
  const settings = loadSettings(ctx.cwd);
  const resolved = resolve(ctx, settings.auditorModel, settings.auditorModelFallbacks, settings.auditorSameSessionSwap !== false);
  if (resolved.error || !resolved.model) throw auditorPolicyError(resolved.error ?? "no authorized route");
  const routes = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate) => candidate.model)].map(qualified);
  const session = ctx.model ? qualified(ctx.model) : undefined;
  if (readAuditorPolicySnapshot() && routes.some((ref) => ref.toLowerCase() === session?.toLowerCase())) throw auditorPolicyError("independent checker matches host session");
  const extensions = resolveAuditorAllowedExtensions(settings.auditorAllowedExtensions, os.homedir(), ctx.cwd, undefined, true);
  const authority = {
    version: 1, primary: settings.auditorModel ?? null, fallbacks: settings.auditorModelFallbacks ?? [],
    swap: settings.auditorSameSessionSwap !== false, session, routes, extensions,
    extensionSpecs: settings.auditorAllowedExtensions ?? [], forbidden: settings.forbiddenModels ?? [],
    thinking: settings.auditorThinkingLevel ?? ctx.thinkingLevel ?? "max", stateRoot: settings.stateRoot,
    snapshotHash: process.env.GLLA_GLOBAL_SETTINGS_SHA256 ?? null,
  };
  return { version: 1, fingerprint: createHash("sha256").update(JSON.stringify(authority)).digest("hex"), routes, extensions };
}

export function assertAuditorRoutingContract(expected: AuditorRoutingContract | undefined, current: AuditorRoutingContract): void {
  if (!expected || expected.version !== 1 || expected.fingerprint !== current.fingerprint) throw auditorPolicyError("effective routing contract changed or legacy identity unknown; cancel and explicitly reauthorize a new goal");
}

export function auditorContractIsCurrent(ctx: ExtensionContext, resolve: Resolver, expected: AuditorRoutingContract | undefined): boolean {
  try { assertAuditorRoutingContract(expected, captureAuditorRoutingContract(ctx, resolve)); return true; }
  catch (error) { ctx.ui.notify(String(error), "warning"); return false; }
}

export function authorizeAuditorClaim(claim: PendingCompletion, current: AuditorRoutingContract, fresh: boolean, replayable = false): void {
  if (fresh) return;
  assertAuditorRoutingContract(claim.auditorRoutingContract, current);
  if (claim.auditorDispatchStarted !== undefined && !replayable) throw auditorPolicyError("previous dispatch outcome unknown; inspect retained job evidence before explicitly reauthorizing a new goal");
}

/** The started receipt is persisted before every effect, including call one.
 * Only an observed retry/exhaustion clears it; process loss never grants a call. */
export function bindAuditorDispatch(claim: PendingCompletion, binding: { requestHash: string; repositoryHead: string | null }): PendingCompletion {
  if (!claim.auditorDispatchStarted) throw auditorPolicyError("dispatch receipt missing before publication");
  return { ...claim, auditorDispatchStarted: { ...claim.auditorDispatchStarted, ...binding } };
}

export function auditorDispatchStarted(ref: string, attempt: 1 | 2): NonNullable<PendingCompletion["auditorDispatchStarted"]> {
  return { id: randomUUID(), ref, attempt, at: new Date().toISOString() };
}

