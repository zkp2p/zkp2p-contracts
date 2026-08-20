# Immutable Production Deployment Lanes Design

## Decision

Once a numbered deployment script has been used to deploy production contracts, its source file is immutable provenance. New safety checks, successor deployments, and retirement behavior must be implemented in new files rather than by rewriting that historical script.

This correction restores the two production-executed files changed by PR #267:

- `deploy/30_deploy_v3_lifecycle_stack.ts` to SHA-256 `97ed83a35e91167186da7a1bde9d3534e6eced436a843a0afd07c0f055bf20fa`. This is the exact file executed from reviewed source SHA `3c4c1306dcce6693cf32300d8917d45c4604b84e` for the production whitelist-only V3 deployment.
- `deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts` to SHA-256 `e103f2b9eb4168504cb226a6191a05c432e313ca5b649b0cc2a3d77fb3a5d283`. This is the exact file used from source SHA `d5558c2888c9246448e1926135fd0c2cbeceb3e4` for the production dispute-stack deployment.

Both deployed versions are identical to the corresponding blobs at `fbe141161fe4138421a21e28715e540dafdfee4f`, the parent of PR #267.

## Active versus immutable

Immutability and retirement are separate properties:

- Lane 30 remains active through a current wrapper, but its historical source cannot change. The wrapper preserves the managed predecessor/successor dispute-hook anti-rollback guard that PR #267 added directly to lane 30.
- Lane 32 is both immutable and retired. Its original source remains at its original path for audit provenance, but supported deployment commands must not load or execute it.
- Lane 34 remains the only supported opt-in dispute successor lane.

## Enforcement

Add a new manifest outside `deploy/` that records each immutable lane's deployed source SHA, SHA-256 digest, tags, and retirement state. The active deployment runner validates both immutable files before every supported deployment. A digest mismatch fails before Hardhat is launched.

Every supported deployment, tagged or untagged, runs from the same filtered temporary deployment directory. The runner omits retired lane 32 and mounts a new current wrapper in place of immutable lane 30. The wrapper verifies the active predecessor or successor dispute hook and returns without invoking historical lane 30 when that managed hook is active; otherwise it delegates to lane 30's exact historical function and skip behavior. It exports the exact historical tags `30_deploy_v3_lifecycle_stack`, `V3LifecycleStack`, and `OrchestratorV3`, plus the exact `29_deploy_whitelist_policy` dependency, with regression coverage for those values and both mount modes.

The wrapper uses a runtime `require`, and the focused current-surface TypeScript project removes immutable lanes 30 and 32 from its explicit roots, replacing them with the wrapper and current helpers. Exact byte-integrity checks, rather than reinterpretation under future TypeScript types, are the acceptance gate for historical source.

For tagged deployments, the runner accepts exactly one tag and rejects comma-separated multi-tag input as well as either of lane 32's historical tags before Hardhat is launched. For untagged deployments, the child environment explicitly removes any inherited `DEPLOY_ACTIVE_TAG`; a stale parent value must never authorize lane 34. Raw direct Hardhat invocation remains unsupported; repository commands are the enforced operational interface.

The manifest must be ordinary TypeScript with small exported functions so focused Node tests can validate:

- both checked-in files match their deployed digests;
- the current lane-30 wrapper is mounted under lane 30's filename for tagged and untagged active runs;
- lane 32 is excluded from an untagged active run;
- lane 32 is also absent from a tagged lane-34 run's mounted source set;
- the unrelated `32_deploy_deposit_creation_guard.ts` remains mounted by exact filename;
- both historical lane-32 tags are rejected;
- multi-tag input is rejected and an untagged child receives no `DEPLOY_ACTIVE_TAG`;
- unrelated active tags remain accepted;
- a mutated immutable file fails the digest check.

A runner-level regression injects a synchronous child-process stub and observes the actual temporary mount during invocation. It proves hash verification precedes spawning, both invocation modes pass `--deploy-scripts`, the wrapper replaces lane 30, only the exact retired lane-32 filename is absent, non-zero child status propagates as command failure, and cleanup occurs after child success, non-zero status, and spawn error.

## Successor evidence

PR #267 made lane 34 depend on predecessor address and bytecode evidence that was incorrectly placed inside rewritten lane 32. Move that evidence and `assertHistoricalDisputeStack` into a new `deployments/predecessorDisputeStack.ts` helper. Update lane 34 and its Safe simulation and verification consumers to import the helper.

The predecessor helper is current safety logic and may evolve with a future successor. It is not part of the immutable lane-32 source. Its tests continue to prove exact Base and Base-staging addresses, deployment bytecode hashes, runtime hashes, and fail-closed behavior without invoking lane 32.

Move `validateManagedDisputeHookSnapshot` and `guardManagedDisputeLifecycleHook` into a separate current helper. The lane-30 wrapper calls this helper before both execution and skip evaluation. Regression tests cover predecessor and successor hook snapshots and prove that supported Base and Base-staging lane-30 execution leaves an already managed hook unchanged even when the historical groups-cutover enable flag remains set. Asynchronous guard tests also cover missing successor deployment bytecode, missing live hook code, registry mismatch, policy mismatch, and an unknown hook falling through to historical lane-30 behavior.

## Documentation rule

Repository guidance must state the durable rule: a deployment script becomes immutable after a production execution. A replacement or successor gets the next unused numbered lane; retirement and live-state verification belong in separate helpers or runner metadata. Deployment artifacts remain immutable evidence as before.

README deployment documentation must describe lane 32 as an immutable retired source file excluded by the supported runner, while pointing operational predecessor verification to the new helper and successor deployment to lane 34.

## Safety boundary

This correction changes repository deployment selection only. It must not:

- execute any Base or Base-staging transaction;
- modify deployment artifacts or exported addresses;
- generate, propose, sign, or execute a Safe transaction;
- publish an npm package;
- alter Solidity contracts or public ABIs.
