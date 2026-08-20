# Restore Immutable Production Deployment Lanes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Review:** Internal reviewer ✅ | Codex CLI convergence ✅ (4 rounds)

**Goal:** Restore production-executed lanes 30 and 32 byte-for-byte while enforcing lane-32 retirement outside the historical files.

**Architecture:** A new immutable-lane manifest pins deployed source hashes and tells `scripts/deployActive.ts` which historical lanes to omit, replace, or reject. The filtered runner mounts a current guarded wrapper in place of immutable lane 30 and excludes retired lane 32 for both tagged and untagged runs. Predecessor dispute evidence moves to a new deployment helper so current guards and lane 34 keep their fail-closed checks without importing or editing lane 32.

**Tech Stack:** TypeScript, Node.js built-in test runner, Hardhat Deploy, SHA-256.

---

### Task 1: Specify immutable and retired deployment selection with failing tests

**Files:**

- Create: `deployments/immutableDeploymentLanes.ts`
- Modify: `scripts/test-opt-in-dispute-lifecycle-deployment.cjs`

**Step 1: Write failing selection and integrity tests**

Import the intended manifest API from `deployments/immutableDeploymentLanes.ts`. Assert the exact lane-30 and lane-32 source SHA and SHA-256 values from the approved design. Assert that selection maps lane 30's mounted filename to a current wrapper, excludes only the exact historical lane-32 filename, preserves `32_deploy_deposit_creation_guard.ts`, and preserves lane 34 for both tagged and untagged source sets. Assert both `32_deploy_and_activate_dispute_lifecycle_stack` and `V3DisputeLifecycleStack` are rejected, all comma-separated multi-tag input is rejected, and lane 34 is accepted. Copy both exact immutable blobs into a temporary repository fixture, prove the fixture passes, mutate one byte, and assert the integrity check reports the filename and expected digest.

**Step 2: Run the focused test and verify RED**

Run: `node --test scripts/test-opt-in-dispute-lifecycle-deployment.cjs`

Expected: FAIL because `deployments/immutableDeploymentLanes.ts` and its API do not exist.

Do not implement or commit the manifest yet: its checked-in integrity assertion must not be enabled while the repository still contains the post-PR #267 file bytes.

### Task 2: Move predecessor evidence out of lane 32

**Files:**

- Create: `deployments/predecessorDisputeStack.ts`
- Create: `deployments/managedDisputeLifecycleHook.ts`
- Create: `deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts`
- Modify: `deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts`
- Modify: `scripts/simulate-dispute-opt-in-safe-batch.ts`
- Modify: `scripts/verify-dispute-opt-in-safe-batch.ts`
- Modify: `scripts/test-dispute-lifecycle-deployment.cjs`
- Modify: `scripts/test-v3-groups-base-deployment.cjs`
- Modify: `package.json`

**Step 1: Write the failing predecessor-helper test**

Change the deployment regression to import `PREDECESSOR_DISPUTE_STACKS` and `assertHistoricalDisputeStack` from `deployments/predecessorDisputeStack.ts`. Remove expectations about lane 32's rewritten no-op function. Preserve the current exact address, deployment-bytecode, runtime-code, missing-artifact, address-drift, and code-drift assertions. Change the groups deployment regression to import the intended current wrapper and managed-hook validator, then add Base and Base-staging scenarios proving predecessor and successor hooks remain unchanged when the matching groups-cutover flag is set. Add asynchronous guard cases for missing successor `deployedBytecode`, missing live hook code, registry mismatch, policy mismatch, and an unknown hook that delegates to historical lane-30 behavior.

**Step 2: Run the focused test and verify RED**

Run: `node scripts/test-dispute-lifecycle-deployment.cjs`

Expected: FAIL because the new helpers and wrapper do not exist.

**Step 3: Add the helper and update all consumers**

Move the current predecessor evidence types, constants, address comparison, and `assertHistoricalDisputeStack` implementation without changing their behavior. Move the current managed-hook snapshot validation and live guard out of lane 30. Add a current wrapper with lane 30's exact tags and dependencies; before both execution and skip evaluation it returns early for a verified managed hook, otherwise it delegates through a runtime `require` to immutable lane 30. Update lane 34, the Safe simulation, the Safe verifier, and both regressions to import current helpers. Confirm no current consumer imports lane 32 for successor behavior.

Add `managed-hook-no-rollback` to `test:v3-groups-deployment` in `package.json` so the canonical focused command always runs the principal wrapper regression.

**Step 4: Run focused deployment tests and verify GREEN**

Run:

```bash
node scripts/test-dispute-lifecycle-deployment.cjs
node scripts/test-v3-groups-base-deployment.cjs managed-hook-guard
node scripts/test-v3-groups-base-deployment.cjs managed-hook-no-rollback
```

Expected: all three PASS.

Do not commit or push this incomplete state; the wrapper is not mounted until Task 3 atomically adds the runner enforcement and restores the immutable sources.

### Task 3: Restore the production-executed files exactly

**Files:**

- Create: `deployments/immutableDeploymentLanes.ts`
- Modify: `deploy/30_deploy_v3_lifecycle_stack.ts`
- Modify: `deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts`
- Modify: `scripts/deployActive.ts`
- Modify: `tsconfig.dispute-deployment.json`

**Step 1: Apply the exact historical blobs**

Use the patch from `git diff HEAD fbe141161fe4138421a21e28715e540dafdfee4f -- deploy/30_deploy_v3_lifecycle_stack.ts deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts` through `apply_patch`. Do not hand-edit either restored file.

**Step 2: Implement the manifest and filtered runner**

Create exports with these responsibilities:

```ts
export const IMMUTABLE_DEPLOYMENT_LANES = {
  /* exact lane 30 and 32 evidence */
} as const;
export function assertImmutableDeploymentLanes(repositoryRoot: string): void;
export function selectActiveDeploymentScripts(
  repositoryRoot: string,
  filenames: readonly string[]
): Array<{ filename: string; sourcePath: string }>;
export function assertSupportedDeploymentTag(tag: string | undefined): void;
```

Use `createHash("sha256")` over exact bytes. Lane 30 maps to `deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts`; only the exact historical lane-32 filename maps to no active source. Reject all comma-separated multi-tag input and either retired tag. Refactor `scripts/deployActive.ts` so both tagged and untagged paths validate hashes, build the same filtered temporary directory, mount the wrapper under lane 30's historical filename, preserve `32_deploy_deposit_creation_guard.ts`, omit only historical lane 32, pass `--deploy-scripts <temporary-directory>`, and then invoke Hardhat. Preserve `--no-compile` and set `DEPLOY_ACTIVE_TAG` for a single tagged run; explicitly delete any inherited `DEPLOY_ACTIVE_TAG` from the untagged child environment.

Export an injectable runner function whose synchronous spawn dependency can be stubbed. Add a runner-level regression that inspects the temporary directory during the stubbed spawn and proves: integrity validation happens before spawn, both modes receive `--deploy-scripts`, lane 30 resolves to the wrapper, historical lane 32 is absent, the deposit-creation guard remains, non-zero child status propagates as command failure, and the temporary directory is removed after a successful child result, non-zero status, and child error.

In the same executable correction, remove immutable lanes 30 and 32 from `tsconfig.dispute-deployment.json` and add the manifest, predecessor helper, managed-hook helper, and active wrapper. This keeps the pushed SHA's focused typecheck green without changing historical bytes.

**Step 3: Verify exact deployed hashes**

Run:

```bash
shasum -a 256 deploy/30_deploy_v3_lifecycle_stack.ts deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts
```

Expected:

```text
97ed83a35e91167186da7a1bde9d3534e6eced436a843a0afd07c0f055bf20fa  deploy/30_deploy_v3_lifecycle_stack.ts
e103f2b9eb4168504cb226a6191a05c432e313ca5b649b0cc2a3d77fb3a5d283  deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts
```

Run `git diff --exit-code fbe141161fe4138421a21e28715e540dafdfee4f --` separately for each restored path. Expected: exit 0.

**Step 4: Prove the supported runner and managed-hook guard**

Run the focused manifest and deployment regressions again, including `yarn test:v3-groups-deployment`. Expected: PASS with exact historical hashes, the wrapper mounted for lane 30, lane 32 excluded in tagged and untagged runs, and predecessor/successor hooks protected on Base and Base staging.

**Step 5: Verify the executable correction before publication**

Run:

```bash
yarn test:dispute-lifecycle-deployment
yarn test:v3-groups-deployment
yarn typecheck:dispute-deployment
npx prettier --check deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts deployments/immutableDeploymentLanes.ts deployments/predecessorDisputeStack.ts deployments/managedDisputeLifecycleHook.ts deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts scripts/deployActive.ts scripts/simulate-dispute-opt-in-safe-batch.ts scripts/verify-dispute-opt-in-safe-batch.ts scripts/test-dispute-lifecycle-deployment.cjs scripts/test-opt-in-dispute-lifecycle-deployment.cjs scripts/test-v3-groups-base-deployment.cjs package.json tsconfig.dispute-deployment.json
git diff --check
```

Expected: all commands exit 0 before the executable commit is created or pushed.

**Step 6: Commit and push the atomic executable correction**

```bash
git add deploy/30_deploy_v3_lifecycle_stack.ts deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts deployments/immutableDeploymentLanes.ts deployments/predecessorDisputeStack.ts deployments/managedDisputeLifecycleHook.ts deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts scripts/deployActive.ts scripts/simulate-dispute-opt-in-safe-batch.ts scripts/verify-dispute-opt-in-safe-batch.ts scripts/test-dispute-lifecycle-deployment.cjs scripts/test-opt-in-dispute-lifecycle-deployment.cjs scripts/test-v3-groups-base-deployment.cjs package.json tsconfig.dispute-deployment.json
git commit -m "fix(deploy): restore immutable production lanes"
git push -u origin codex/restore-immutable-deploy-lanes
```

### Task 4: Codify the rule and verify the correction

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-20-immutable-production-deployment-lanes-design.md`
- Modify: `docs/plans/2026-08-20-restore-immutable-production-deployment-lanes.md`

**Step 1: Update repository guidance**

Document the production-execution immutability rule in `AGENTS.md`. Replace its now-false statement that lane 32 always skips with the exact model: lane 32 is executable immutable historical source, the supported runner excludes it, and `deployments/predecessorDisputeStack.ts` owns current read-only predecessor verification. Rewrite the README lane-30 and lane-32 paragraphs to distinguish immutable source, the active wrapper, external retirement, and predecessor verification.

**Step 2: Run proportionate verification**

Run:

```bash
yarn test:dispute-lifecycle-deployment
yarn test:v3-groups-deployment
yarn typecheck:dispute-deployment
npx prettier --check deployments/immutableDeploymentLanes.ts deployments/predecessorDisputeStack.ts deployments/managedDisputeLifecycleHook.ts deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts scripts/deployActive.ts deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts scripts/simulate-dispute-opt-in-safe-batch.ts scripts/verify-dispute-opt-in-safe-batch.ts scripts/test-dispute-lifecycle-deployment.cjs scripts/test-opt-in-dispute-lifecycle-deployment.cjs scripts/test-v3-groups-base-deployment.cjs AGENTS.md README.md docs/superpowers/specs/2026-08-20-immutable-production-deployment-lanes-design.md docs/plans/2026-08-20-restore-immutable-production-deployment-lanes.md
git diff --check
```

Expected: all commands exit 0. No Solidity test is required because no Solidity, ABI, contract behavior, deployment artifact, or address changes.

**Step 3: Review the final diff and scope**

Confirm the only executable changes are the new manifest/helper, active runner integration, current lane-34 consumers, and tests. Confirm both restored historical files match their deployed hashes and that no deployment artifact, package output, Safe artifact, contract, or ABI changed.

**Step 4: Commit, push, and create the correction PR**

```bash
git add AGENTS.md README.md
git add -f docs/superpowers/specs/2026-08-20-immutable-production-deployment-lanes-design.md docs/plans/2026-08-20-restore-immutable-production-deployment-lanes.md
git commit -m "docs(deploy): freeze production deployment lanes"
git push
```

Create a PR against `main` describing the exact deployed-source hashes, external retirement mechanism, focused verification, and explicit absence of chain or package mutations.
