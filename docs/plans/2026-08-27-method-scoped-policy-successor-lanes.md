# Method-Scoped Policy Successor Lanes Implementation Plan

> Design: `docs/superpowers/specs/2026-08-27-method-scoped-policy-successor-lanes-design.md`
>
> Resolves Codex review comments 2–4 on PR #278. Comment 1 is already fixed by `b108135`.

**Goal:** Ship the payment-method-scoped `WhitelistPolicy`, `DisputeProtectionPolicy`, and `IntentLifecycleHookV1` through new deploy-only lanes 36 and 37, pin lanes 29 and 34 as immutable, retire lane 34, and retarget the whitelist bootstrap at the tuple-aware policy — without touching any live artifact, output, evidence file, or live canonical selection.

**Tech Stack:** TypeScript (Hardhat Deploy), Node.js built-in test runner, SHA-256 lane pins.

---

### Task 1: Restore and pin lanes 29 and 34; retire lane 34

**Files:** `deploy/29_deploy_whitelist_policy.ts`, `deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts` (restore to `main` bytes via `git checkout main -- <path>`; never hand-edit), `deployments/immutableDeploymentLanes.ts`, `scripts/test-opt-in-dispute-lifecycle-deployment.cjs`, `package.json`.

- Add the two manifest entries with the exact digests from the design. Add a `retired` guard that rejects every retired lane's tags in `assertSupportedDeploymentTag`.
- Update selection tests: lane 34 is excluded from tagged and untagged source sets; both lane-34 tags are rejected; lane 29 is still mounted from `deploy/`.
- Remove `deploy:dispute-opt-in:*` from `package.json` (the runner now rejects that tag). Keep `verify:dispute-opt-in:*`, `simulate:*`, `verify:dispute-opt-in-safe-batch`.
- Verify: `shasum -a 256` of both files equals the pins; `node scripts/test-opt-in-dispute-lifecycle-deployment.cjs` green.

### Task 2: Lane 36 and bootstrap retarget

**Files:** create `deploy/36_deploy_method_scoped_whitelist_policy.ts`; modify `scripts/bootstrapWhitelistPolicy.ts`, `deploy/deploy_summary.ts`.

- Implement lane 36 per the design (deploy `WhitelistPolicyMethodScoped`, canonical-check existing record, live flags, tagged-run throw, ownership handover, tags/dependencies).
- Bootstrap: default and Base pin resolve `WhitelistPolicyMethodScoped`; reject the lane-29 `WhitelistPolicy` address for the selected network with an explicit error.
- Summary: print `WhitelistPolicyMethodScoped` via `tryGetAddress`; add lane 36/37 tags to `func.tags`.

### Task 3: Lane 37 and predecessor map

**Files:** create `deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts`; modify `deployments/predecessorDisputeStack.ts`, `deployments/active-dispute-stack.json`, `deployments/activeDisputeStack.cjs`, `scripts/active-dispute-stack.spec.cjs`.

- Export `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` (Base: lane-34 trio + `IntentLifecycleHookV1OptIn` as active hook, hashes computed from `deployments/base/*OptIn.json` `deployedBytecode` and live runtime code; Base staging: identical to `PREDECESSOR_DISPUTE_STACKS.base_staging`). Parameterize `assertHistoricalDisputeStack(hre, stacks = PREDECESSOR_DISPUTE_STACKS)`.
- Implement lane 37 per the design: deploy-only live path with the step machine and `assertLiveSharedState`, local path with activation, no activation flags or Safe tooling.
- Manifest: `localhost`/`hardhat` → `MethodScoped` records; generalize internal-name removal in `activeDisputeStack.cjs`; update local fixtures in the spec.

### Task 4: Tests, typecheck wiring, CI

**Files:** create `scripts/test-method-scoped-deployment.cjs`; modify `package.json`, `tsconfig.dispute-deployment.json`, `.github/workflows/release-readiness.yml`.

- Cover everything listed under "Tests" in the design.
- `yarn typecheck:dispute-deployment`, `yarn test:dispute-lifecycle-deployment`, `yarn test:v3-groups-deployment`, `yarn test:method-scoped-deployment` all green.

### Task 5: Docs and integration gate

**Files:** `AGENTS.md`, `README.md`, `CLAUDE.md`.

- Document lanes 29/34 as immutable (34 retired), lanes 36/37 as the current deploy-only successors with their flags and commands, the bootstrap target, and the deferred activation lane.
- Run `yarn chain` and `yarn deploy:localhost` from a fresh deployment database; confirm the final `OrchestratorV3.lifecycleHook()` is `IntentLifecycleHookV1MethodScoped` and `deploy_summary` prints the method-scoped addresses.
- `git diff --check`; `prettier --check` on touched TS/CJS/JSON.
