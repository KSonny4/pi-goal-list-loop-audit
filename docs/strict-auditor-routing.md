# Strict auditor routing and recovery

## Authority

An explicit `auditorModel` authorizes that independent route plus its ordered
`auditorModelFallbacks`, not the host session as an implicit final option.
Forbidden, unregistered, unkeyed, and same-host routes are excluded. If none
remain, verification blocks without a verdict. `auditorSameSessionSwap=false`
is not an independence escape for an explicit primary. Only ordinary local
sessions with **no configured primary** retain the historical session default.

Project fallback arrays replace global arrays, including `[]`; absence inherits.
The legacy singular fallback migrates only when the plural field is absent.
Malformed routing fields are rejected rather than normalized into weaker
permission. Other roles' fallback policy is unchanged.

A GE-style launch pairs an absolute `GLLA_GLOBAL_SETTINGS_PATH` with
`GLLA_GLOBAL_SETTINGS_SHA256` (lowercase SHA-256 of the exact file bytes). When
the hash is present, GLLA requires a readable object snapshot with a qualified
primary, empty fallback array, swap disabled, required extension list, and
`stateRoot: "workingDir"`. Verification happens before state-root selection.
Missing/corrupt/changed snapshots block; there is no fallback to user globals.
Conflicting project routing, thinking, extension, or state-root overrides also
block. Thinking may be absent in the snapshot to inherit the live host dial;
a project cannot add a different override in that case.

Required extensions must all resolve unambiguously to existing absolute real
paths. The persisted contract's resolved paths are passed to transport. The raw
specifications are resolved again at the dispatch fence to detect alias drift,
not to independently choose a new emitted extension list. No package install,
extension discovery widening, or plugin-content hashing is performed here.

## Retry and durable identity

A new completion claim captures a versioned fingerprint of effective primary,
fallbacks, swap behavior, session route, resolved candidate routes, required
extensions and raw specs, forbidden policy, effective thinking, state root,
and snapshot hash. Resumption checks this identity **before** filtering the
stored cursor. Dispatch checks it again after asynchronous setup and before
spawn. Settings/route/extension drift does not reset the spent budget.

Definite billing exhaustion or explicit invalid-key/authentication denial
consumes the current route once and advances immediately to an authorized
alternative. It does not blacklist an entire provider. Ambiguous 401/403,
rate limits, transport failures, timeouts, and 5xx retain the existing finite
same-route retry and cooldown behavior. Semantic disapproval is not an
infrastructure retry.

Every effect, including attempts one and two, first persists a started receipt:
unique job id, qualified route, attempt number and timestamp. Before spawn the
receipt binds the exact request hash and repository HEAD. Failure to persist
blocks the effect. Known retry/exhaustion transitions clear the receipt;
process death does not.

On restart, a started receipt can only consume an exact retained request/result
pair for that id, request hash, model, cwd, goal revision and unchanged repository
HEAD. It uses the normal result parser, evidence/regression shield and terminal
archive path, without spawning a new worker. Missing/corrupt/mismatched artifacts
remain **outcome unknown**, with no semantic verdict and no duplicate call.
This intentionally prioritizes safety over availability, including conservative
blocking when the host died before an uncertain launch completed.

## Operator controls and limitations

`/goal verify` creates authority for a new claim, but never overwrites an existing
pending claim or its spent receipt. Automatic recovery, `/goal resume`, and
`/list resume` cannot silently upgrade a legacy identity-less claim or erase an
unknown effect. Inspect retained `.pi-glla/audit-jobs/<id>/` evidence. To change
authority, explicitly cancel/archive the old goal and create a new goal; do not
edit the cursor or delete history to obtain another call.

Hashing is an integrity fence for supplied authority, not protection against a
malicious same-user process. Repository HEAD binding does not fingerprint every
working-tree file. Model availability/catalog visibility is not proof of live
provider serving. GLLA does not repair Pi core, provider plugins, or host process
inspection behavior.

## Deterministic validation

No live model calls are needed:

```sh
bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/auditor-strict-routing.test.ts tests/auditor-policy-boundary.test.ts tests/auditor-routing-contract.test.ts tests/auditor-routing-process-loss.test.ts
npm run check
npm run release:check
```

The process-loss fixture runs the real registered `complete_goal`, kills the
separate host after a fake RPC peer observes the first or second effect, then
starts a fresh host against the same durable directory. It also proves exact
retained approval replay and corrupt-result rejection. Compatibility controls
exercise normal terminal archive and lifecycle paths with no copied policy
implementation.
