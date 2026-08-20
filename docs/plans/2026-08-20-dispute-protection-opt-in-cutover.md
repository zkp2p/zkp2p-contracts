# Dispute Protection Opt-In Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Review:** Internal reviewer ✅ | Codex CLI convergence ⚠️ max 5 rounds reached; final two findings resolved in this plan

**Goal:** Restore deposit-scoped dispute protection to opt-in semantics, deploy a passive successor vault/policy/hook stack on Base staging and Base, publish its canonical contracts package, and hard-cut the indexer to the new environment-specific policies.

**Architecture:** Keep the public Solidity ABI unchanged while replacing the inverted storage mapping with a direct enabled mapping. Preserve lane 32 and its deployment artifacts as historical evidence; lane 34 deploys versioned successor records and a checked-in alias manifest selects the canonical public names. Deployment and governance activation remain separate: live deployment creates and configures the passive trio, while Base activation is represented only by a validated unsigned Safe batch and Base staging advances one separately confirmed EOA transition at a time.

**Tech Stack:** Solidity 0.8.18, Foundry, Hardhat Deploy, ethers v5, Node.js test runner, Yarn 4 workspaces, GitHub Actions trusted npm publishing, Envio/TypeScript/pnpm for the indexer.

---

### Task 1: Lock the opt-in contract behavior with failing tests

**Files:**
- Modify: `test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol`
- Modify: `test-foundry/deterministic/integration/IntentLifecycleHookV1OrchestratorV3.t.sol`
- Modify: `test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol`
- Modify: `test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol`

**Step 1: Capture the reproducible pre-change ABI hash**

Run `forge inspect contracts/hooks/DisputeProtectionPolicy.sol:DisputeProtectionPolicy abi | jq -S . | shasum -a 256` at the current default-on commit and record the digest in the implementation log. The Solidity change must reproduce this digest exactly; do not depend on ignored `artifacts/` or `out/` from another checkout.

**Step 2: Change the policy default regression**

Rename `test_isDisputeProtectionEnabledDefaultsTrueForUntouchedAndMissingDeposits` to `test_isDisputeProtectionEnabledDefaultsFalseForUntouchedAndMissingDeposits` and assert both reads are false:

```solidity
function test_isDisputeProtectionEnabledDefaultsFalseForUntouchedAndMissingDeposits() public view {
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId));
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), type(uint256).max));
}
```

**Step 3: Require explicit opt-in before policy admission**

Replace the untouched-deposit success case with two assertions: untouched admission reverts with `DisputeProtectionNotEnabled`, then the depositor enables the deposit and the existing stake-lock/snapshot assertions pass. Add `_enableProtection()` and call it before every protected admission path. Audit all direct `onIntentSignaled` calls in the file, not only `_admitAndSettle`; keep only the untouched/default regression and the deliberately disabled rejection path unenabled.

**Step 4: Update the integration admission matrix**

Update the full matrix in `DisputeLifecycleHookOrchestratorV3.t.sol`: rename default-on/opted-out cases to default-off/opted-in semantics, leave untouched deposits direct unless whitelist rejection applies, and explicitly set protection `true` only in stake-backed rows. Add one test proving that whitelist-disabled plus untouched protection admits directly without a stake lock, and one proving that explicit protection plus a nonzero risk window locks stake. Add the surprising zero-window row explicitly: with whitelist enabled, a non-whitelisted taker, protection enabled, and `riskWindow == 0`, admission succeeds directly, creates no dispute intent, and locks no stake.

In `IntentLifecycleHookV1OrchestratorV3.t.sol`, keep direct whitelist pass-through tests intact and remove redundant explicit `false` writes from whitelist-failure/direct-pass-through rows. In `WhitelistLifecycleHookOrchestratorV3.t.sol`, explicitly opt the deposit in before the rotation test expects the fresh combined-hook intent to create a pending dispute-protection intent. Audit all three integration files for untouched assumptions; do not preserve a default-on expectation under a renamed test.

**Step 5: Run the focused tests and observe RED**

Run:

```bash
forge test --match-path 'test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol'
forge test --match-path 'test-foundry/deterministic/integration/IntentLifecycleHookV1OrchestratorV3.t.sol'
forge test --match-path 'test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol'
forge test --match-path 'test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol'
```

Expected: failures caused by untouched deposits still reading enabled and entering the default-on policy path.

**Step 6: Commit only the failing tests**

```bash
git add test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol \
  test-foundry/deterministic/integration/IntentLifecycleHookV1OrchestratorV3.t.sol \
  test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol \
  test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol
git commit -m "test: require dispute protection opt in"
```

### Task 2: Implement the ABI-stable direct enabled mapping

**Files:**
- Modify: `contracts/hooks/DisputeProtectionPolicy.sol`
- Modify: `contracts/interfaces/IDisputeProtectionPolicy.sol`
- Modify: `contracts/hooks/IntentLifecycleHookV1.sol`

**Step 1: Replace the inverted mapping**

Use the direct mapping and preserve the public setter/getter/event signatures:

```solidity
mapping(address => mapping(uint256 => bool)) internal isDepositDisputeProtectionEnabled;

function setDisputeProtectionEnabled(address _escrow, uint256 _depositId, bool _isEnabled)
    external
    onlyDepositor(_escrow, _depositId)
{
    isDepositDisputeProtectionEnabled[_escrow][_depositId] = _isEnabled;
    emit DisputeProtectionEnabledUpdated(_escrow, _depositId, _isEnabled);
}

function isDisputeProtectionEnabled(address _escrow, uint256 _depositId) external view override returns (bool) {
    return isDepositDisputeProtectionEnabled[_escrow][_depositId];
}
```

In `_validateIntentAdmission`, reject `!isDepositDisputeProtectionEnabled[_escrow][_depositId]` with the existing `DisputeProtectionNotEnabled` error.

**Step 2: Rewrite all default-on prose**

Describe explicit depositor opt-in in the policy, interface, hook, and pause NatSpec. Keep `riskWindow == 0` as the existing direct pass-through and do not add aliases or migration state.

**Step 3: Run focused tests and observe GREEN**

Run all four focused commands from Task 1. Expected: all files pass.

**Step 4: Prove ABI equality**

Rerun the exact `forge inspect ... | jq -S . | shasum -a 256` command from Task 1. Expected: it equals the recorded pre-change digest with no added, removed, or changed ABI entries.

**Step 5: Commit**

```bash
git add contracts/hooks/DisputeProtectionPolicy.sol \
  contracts/interfaces/IDisputeProtectionPolicy.sol \
  contracts/hooks/IntentLifecycleHookV1.sol
git commit -m "fix: make dispute protection opt in"
```

### Task 3: Retire executable lane 32 and introduce canonical aliasing

**Files:**
- Modify: `deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts`
- Create: `deployments/active-dispute-stack.json`
- Create: `deployments/activeDisputeStack.cjs`
- Create: `tsconfig.dispute-deployment.json`
- Create: `scripts/active-dispute-stack.spec.cjs`
- Modify: `scripts/test-dispute-lifecycle-deployment.cjs`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `.github/workflows/release-readiness.yml`

**Step 1: Write failing alias and historical-lane tests**

The Node test must assert:

```js
assert.equal(await historicalLane.skip(fakeHre), true);
assert.deepEqual(resolveActiveDisputeAliases("base", contracts), {
  ...contracts,
  StakeVault: contracts.StakeVault,
  DisputeProtectionPolicy: contracts.DisputeProtectionPolicy,
  IntentLifecycleHookV1: contracts.IntentLifecycleHookV1,
});
assert.equal(Object.keys(publicContracts).some((name) => name.endsWith("OptIn")), false);
```

It must reject a missing internal record, an unknown public key, an unsupported network, a public/internal artifact ABI mismatch, and duplicate public exposure.

**Step 2: Run the Node test and observe RED**

Run `node --test scripts/active-dispute-stack.spec.cjs`. Expected: missing module/manifest failure.

**Step 3: Add the manifest and resolver**

Start live networks on their predecessor records; localhost/hardhat select successor records after lane 34 runs:

```json
{
  "version": 1,
  "networks": {
    "base": {
      "StakeVault": "StakeVault",
      "DisputeProtectionPolicy": "DisputeProtectionPolicy",
      "IntentLifecycleHookV1": "IntentLifecycleHookV1"
    },
    "base_staging": {
      "StakeVault": "StakeVault",
      "DisputeProtectionPolicy": "DisputeProtectionPolicy",
      "IntentLifecycleHookV1": "IntentLifecycleHookV1"
    },
    "localhost": {
      "StakeVault": "StakeVaultOptIn",
      "DisputeProtectionPolicy": "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1": "IntentLifecycleHookV1OptIn"
    },
    "hardhat": {
      "StakeVault": "StakeVaultOptIn",
      "DisputeProtectionPolicy": "DisputeProtectionPolicyOptIn",
      "IntentLifecycleHookV1": "IntentLifecycleHookV1OptIn"
    }
  }
}
```

`deployments/activeDisputeStack.cjs` is the single JS-compatible resolver boundary. It uses `// @ts-check` plus JSDoc types, loads the JSON manifest directly, and exports `resolveActiveDisputeAliases`, `getActiveDisputeDeploymentName`, and network normalization. TypeScript/ts-node consumers import it with `require`; CommonJS tests require it directly; ESM release scripts load it with `createRequire(import.meta.url)`. No consumer may duplicate the mapping.

`resolveActiveDisputeAliases` must copy each selected internal entry to its canonical public key and remove all `*OptIn` keys. `getActiveDisputeDeploymentName` must be the only path used by deployment summaries, output canonicalization, extractors, release verification, and smoke tests. Define and test one normalization function mapping Hardhat `base_staging`, output/package `baseStaging`, and manifest `base_staging` to the same key.

Add `tsconfig.dispute-deployment.json` with `allowJs`, `checkJs`, and `noEmit`. In this task its exact `files` list is `deployments/activeDisputeStack.cjs`, `deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts`, `scripts/active-dispute-stack.spec.cjs`, and `scripts/test-dispute-lifecycle-deployment.cjs`. Tasks 4, 5, and 6 extend the list only after their consumers exist; the final list is enumerated in Task 6. Expose `yarn typecheck:dispute-deployment` and add an unconditional release-readiness step that runs it immediately after `yarn test:dispute-lifecycle-deployment`.

**Step 4: Make lane 32 read-only and superseded**

Replace its executable deployment body with pinned predecessor evidence checks exported for lane 34. Its `skip` returns true only after Base/Base-staging predecessor deployment records exist and their addresses and pinned runtime hashes match; missing or mismatched live evidence fails closed. Localhost/hardhat skip without requiring live artifacts. Lane 34 repeats the mandatory live evidence check before any successor work. Lane 32 must never compare predecessor runtime against the newly compiled policy artifact, deploy locally, mutate ownership, queue Safe calls, or activate a hook.

Rewrite `scripts/test-dispute-lifecycle-deployment.cjs` in this task as a historical-lane and alias-only suite that imports no removed lane-32 helpers. Task 4 will aggregate this suite with the new lane-34 suite under the existing release-readiness package command.

Rewrite the V3 deployment sections in `AGENTS.md` and `README.md`: lane 32 is immutable historical evidence, lane 33 is the IntentGuardian fee update, lane 34 is the only successor deployment/activation preparer, the new opt-in flags and tag-scoped commands replace the obsolete lane-32 flags, and passive deployment remains separate from activation. A stale-prose scan must leave no operator instruction that tells readers to execute lane 32.

**Step 5: Run and commit**

Run `node --test scripts/active-dispute-stack.spec.cjs scripts/test-dispute-lifecycle-deployment.cjs`, `yarn typecheck:dispute-deployment`, and `yarn transpile`. Expected: pass.

```bash
git add -f deploy/32_deploy_and_activate_dispute_lifecycle_stack.ts \
  deployments/active-dispute-stack.json deployments/activeDisputeStack.cjs \
  tsconfig.dispute-deployment.json \
  scripts/active-dispute-stack.spec.cjs scripts/test-dispute-lifecycle-deployment.cjs \
  package.json AGENTS.md README.md .github/workflows/release-readiness.yml
git commit -m "refactor: preserve historical dispute deployment lane"
```

### Task 4: Implement passive successor deployment lane 34

**Files:**
- Create: `deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts`
- Create: `scripts/test-opt-in-dispute-lifecycle-deployment.cjs`
- Modify: `deploy/deploy_summary.ts`
- Modify: `deploy/30_deploy_v3_lifecycle_stack.ts`
- Modify: `scripts/test-v3-groups-base-deployment.cjs`
- Modify: `scripts/deployActive.ts`
- Modify: `tasks/etherscanVerifyWithDelay.ts`
- Modify: `package.json`
- Modify: `tsconfig.dispute-deployment.json`

**Step 1: Write failing deployment-helper tests**

Build from an empty dispute-stack deployment map after the normal local core and lane-31 payment-binding fixtures exist and `paymentBindingCutoverReady(hre)` returns true. Tests must require lane 34's local deployment names in this exact order:

```js
[
  "DisputeNullifierRegistry",
  "DisputeVerifier",
  "StakeVaultOptIn",
  "DisputeProtectionPolicyOptIn",
  "IntentLifecycleHookV1OptIn",
]
```

On mocked Base/Base-staging state, assert that `DisputeVerifier` and `DisputeNullifierRegistry` are reused, only the successor trio is deployed, the new vault controller is initialized, only the new hook is authorized, exact risk windows are set, and deploy-only leaves the registry writers and Orchestrator lifecycle hook unchanged.

Add failures for missing opt-in flag, partial non-prefix artifacts, dependency/address/code-hash drift, unexpected owner/pending owner/controller/writers, nonempty predecessor/fresh vault, risk-window drift, and any preactivation lifecycle/financial activity.

**Step 2: Run the helper and observe RED**

Run `node scripts/test-opt-in-dispute-lifecycle-deployment.cjs`. Expected: missing lane/module failure.

**Step 3: Implement lane constants and phase classifier**

Use `SUPPORTED_NETWORKS`, `OPT_IN_DEPLOYMENT_NAMES`, pinned live dependency/predecessor records, and a pure phase classifier. Live phase values are `absent`, `partial`, `deployed`, `prepared`, `active`, or invalid; unknown states throw. Export pure helpers so the Node tests do not require live RPC.

**Step 4: Implement local deployment**

On localhost/hardhat, first require the earlier local lane-31 fixtures to satisfy `paymentBindingCutoverReady(hre) === true`; add a negative regression proving local activation fails closed when routing or retired-writer cleanup is incomplete. Then deploy the local dispute registry/verifier dependencies plus the successor trio, configure writer/controller/hook/risk windows, and activate locally. Lane 32 remains skipped, so no warm lane-32 dispute artifacts may be required. The ordinary numeric localhost run reaches lane 31 before lane 34; the tag-scoped live commands still execute lane 34 alone and never pull lane 31 as a dependency.

**Step 5: Implement live deploy-only**

Require `ENABLE_STAGING_V3_DISPUTE_OPT_IN_DEPLOYMENT=true` or `ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT=true`. Verify exact shared/predecessor state, deploy only missing contiguous successor records, initialize the vault controller, authorize only the successor hook, configure exact risk windows, initiate fresh vault/policy ownership transfers, and leave writer/hook unchanged. The Base run also verifies and clears the exact obsolete predecessor vault/policy pending owners before returning success.

Model the entire deploy-only run as one ordered monotonic prefix, not only the three deployment records: successor deployment records in constructor-dependency order; vault controller initialization; successor-hook authorization; each disputable payment-method risk-window write in the ratified order; fresh vault ownership initiation; fresh policy ownership initiation; Base predecessor-vault pending-owner cancellation; then Base predecessor-policy pending-owner cancellation. Before every transaction, classify the whole prefix from fresh reads. An already-completed exact step is skipped, the first missing step is the only mutation allowed, and any later-complete/earlier-missing or value-drift state fails closed. Do not batch these steps in a way that hides resumability.

**Step 6: Verify idempotence**

A rerun after deployment must send no transaction and return the same deployed phase. A partial prefix resumes from the next deployment or configuration transaction. Tests interrupt after every deployment and every mutation listed in Step 5—including between individual risk-window writes and between the two Base pending-owner cancellations—then prove the next run sends only the next missing action and reaches the same final deploy-only state. A partial non-prefix or any unexpected post-deployment state fails closed.

**Step 7: Prevent lane 30 rollback and unrelated live-lane execution**

Route lane 30's `IntentLifecycleHookV1` lookup through `getActiveDisputeDeploymentName`, while also importing lane 32's exact pinned live predecessor hook evidence. Lane 30 must recognize both that network's pinned predecessor and the manifest-selected successor as dispute-lane-managed hook states. Add a read-only guard before lane 30's broader readiness branch and again at the top of its executable body: if either managed hook is active, validate its exact pinned/selected address, runtime hash, registry, and whitelist-policy binding, then return without mutation when valid or throw before any write when drifted. Lane 30 must never call `setLifecycleHook(WhitelistLifecycleHook)` from either managed state, even when a legacy lane-30 enable flag is set.

Extend the V3 groups deployment tests for an active successor, an active pinned staging predecessor after the alias selects the successor, and dependency drift under each state. The exact regression `staging predecessor active + successor alias selected + ENABLE_STAGING_V3_GROUPS_CUTOVER=true` must prove no transaction or Safe call is emitted; the drift variants must prove an exception occurs before any mutation.

Add a tag-scoped mode to `scripts/deployActive.ts` and dedicated `deploy:dispute-opt-in:base_staging` / `deploy:dispute-opt-in:base` commands. Live commands execute lane 34 only: lane 34 performs its own read-only shared-dependency and predecessor checks and has no Hardhat Deploy dependency that can run lane 30, lane 31, or another governance preparer. Localhost/hardhat may explicitly provision their missing local prerequisites inside lane 34. Tests must assert no unrelated Safe calls or state changes. Never use the all-lanes `yarn deploy:base*` commands for the live successor deployment.

Make the existing `test:dispute-lifecycle-deployment` package command run both the historical/alias suite and `scripts/test-opt-in-dispute-lifecycle-deployment.cjs`. Keep the release-readiness workflow on that exact package command, add a separate unconditional `yarn typecheck:dispute-deployment` workflow step, and run both commands locally before committing.

Extend `etherscan-verify-with-delay` with an optional comma-separated contract allowlist and `--fail-on-error`. The allowlist rejects unknown deployment names and verifies only the named records; `--fail-on-error` throws after the summary when any selected verification failed. Add dedicated commands `verify:dispute-opt-in:base_staging` and `verify:dispute-opt-in:base` selecting exactly `StakeVaultOptIn,DisputeProtectionPolicyOptIn,IntentLifecycleHookV1OptIn` with fail-on-error, and cover selection, unknown-name rejection, already-verified success, and nonzero failure behavior in the deployment helper tests.

Extend `tsconfig.dispute-deployment.json` with the Task 4 consumers only after they exist: lane 30, lane 34, `deploy_summary.ts`, `deployActive.ts`, `etherscanVerifyWithDelay.ts`, `test-opt-in-dispute-lifecycle-deployment.cjs`, and `test-v3-groups-base-deployment.cjs`.

**Step 8: Run focused verification and commit**

Run:

```bash
node scripts/test-opt-in-dispute-lifecycle-deployment.cjs
node scripts/test-v3-groups-base-deployment.cjs prepare-resume
yarn test:dispute-lifecycle-deployment
yarn typecheck:dispute-deployment
yarn transpile
yarn deploy:localhost
```

Expected: helper tests pass and local final topology contains one active opt-in stack with no lane-32 duplicate.

```bash
git add deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts \
  scripts/test-opt-in-dispute-lifecycle-deployment.cjs deploy/deploy_summary.ts \
  deploy/30_deploy_v3_lifecycle_stack.ts scripts/test-v3-groups-base-deployment.cjs \
  scripts/deployActive.ts tasks/etherscanVerifyWithDelay.ts \
  tsconfig.dispute-deployment.json package.json
git commit -m "feat: add opt-in dispute successor deployment lane"
```

### Task 5: Add governance preparation and obsolete-batch invalidation

**Files:**
- Modify: `deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts`
- Create: `deployments/safeBatchManifest.ts`
- Create: `contracts/mocks/DisputeLifecyclePostcondition.sol`
- Create: `scripts/simulate-dispute-opt-in-safe-batch.ts`
- Create: `scripts/verify-dispute-opt-in-safe-batch.ts`
- Modify: `scripts/test-opt-in-dispute-lifecycle-deployment.cjs`
- Modify: `tsconfig.dispute-deployment.json`

**Step 1: Write failing state-machine and canonical-hash tests**

Cover every Base-staging monotonic state:

```text
fresh writer absent + predecessor hook
fresh writer present + predecessor hook
fresh writer present + fresh hook + predecessor writer present
fresh writer present + fresh hook + predecessor writer absent
```

Require the next exact transaction only. Missing activation/downstream/drain confirmations, Safe artifacts on staging, unknown writer/hook combinations, or attempts to skip a transition must fail.

Before Base batch preparation and before every Base-staging activation transition, call lane 31's exported read-only `paymentBindingCutoverReady(hre)` and require it to return `true`. This is stricter than `assertPaymentBindingReady`: it additionally proves every active method routes to UPV3 and the retired legacy writer set is empty. Do not make lane 31 a Hardhat Deploy dependency: running its Base body can prepare an unrelated 22-call governance batch. Add negative regressions for a method still routed to a retired verifier and for any retired legacy writer; each must prevent batch generation, staging simulation, and staging execution without writing an artifact or sending a transaction.

Cover the staging drain race after the hook swap. State 3 (`fresh hook + predecessor writer`) is valid and resumable even when the predecessor vault has newly appeared accounting. Writer removal must independently refuse nonzero `totalStaked` and nonzero `totalClaimable`, leave the run in state 3, and reread both values on every retry. Only a fresh zero/zero read permits the final predecessor-writer removal.

For Base, reconstruct canonical bytes using:

```ts
JSON.stringify(transactions.map(({ to, value, data, operation }) => ({
  to: to.toLowerCase(),
  value: String(value),
  data: data.toLowerCase(),
  operation: Number(operation),
})))
```

and SHA-256 those UTF-8 bytes. Mutating target/order/value/calldata/operation/Safe nonce/source SHA/block hash/result must fail verification.

**Step 2: Implement the exact fork simulation driver**

`scripts/simulate-dispute-opt-in-safe-batch.ts` resets Hardhat with `hardhat_reset` against `BASE_FORK_RPC_URL` at the exact recorded block and verifies the returned block hash. It must pin and verify:

- ZKP2P Base Safe `0x0bC26FF515411396DD588Abd6Ef6846E04470227`, `VERSION() == "1.3.0"`, runtime hash `0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000`;
- Safe v1.3.0 `MultiSendCallOnly` `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D`, runtime hash `0xa9865ac2d9c7a1591619b188c4d88167b50df6cc0c5327fcbd1c8c75f7c066ad`;
- local minimal ABIs for `VERSION()`, `nonce()`, `simulateAndRevert(address,bytes)`, and `multiSend(bytes)`.

Compile and deploy `contracts/mocks/DisputeLifecyclePostcondition.sol` only on the ephemeral fork. Pack each inner call as `operation || to || value || dataLength || data`, append one simulation-only call to the assertion contract, then ABI-encode `MultiSendCallOnly.multiSend(bytes)` around those packed transactions. Call `Safe.simulateAndRevert(MultiSendCallOnly, encodedMultiSendCalldata)`, decode Safe v1.3.0's deliberate revert envelope (`success` word plus returned-data length/body), and require inner success plus the assertion's final owner, writer-set, hook, risk-window, controller, and vault-accounting postconditions. The persisted Safe batch and canonical hash contain only the real governance calls; the fork-only assertion call is never persisted.

Expose a runnable `yarn simulate:dispute-opt-in-safe-batch --batch <path> --sidecar <path>` command and test packing, ABI encoding, envelope decoding, pinned runtime rejection, assertion failure, and the distinction between simulated and persisted calls. Sequential calls or independent `eth_call` postconditions are not acceptable.

**Step 3: Implement Base preparation without execution**

Read `Safe.nonce()` through the Safe ABI, never `getTransactionCount`. Build the exact ordered batch: optional reused-verifier ownership acceptance, fresh vault acceptance, fresh policy acceptance, add fresh writer, remove predecessor writer, set fresh hook. Record chain ID, Safe, nonce, exact source SHA, simulation block number/hash/result, normalized transactions, and SHA-256 in the sidecar.

Write the persisted files to deterministic paths `deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.json` and `deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.sha256.json`. Generate both in memory, run the exact simulation from Step 2, then write same-directory temporary files, fsync/close, and rename into place. On any error, remove temporaries and leave neither final file newly written; the verifier rejects a missing half of the pair. Never send, propose, or sign a Safe transaction.

`scripts/verify-dispute-opt-in-safe-batch.ts` accepts those exact two paths, reconstructs canonical bytes/hash, verifies every recorded metadata field against fresh RPC/git inputs, and reruns the pinned fork simulation. It has two explicit Git-state modes. Generation mode requires a clean worktree with `HEAD == sourceSha`. Artifact-child mode requires a clean worktree, requires `sourceSha` to be an ancestor of `HEAD`, and rejects every path in `git diff --name-only <sourceSha>..HEAD` except the exact batch, sidecar, and an explicit obsolete-batch archival path. Tests must prove both modes pass in their intended state and reject a dirty tree, unrelated descendant commit, unallowed path, and non-ancestor source SHA. Add `yarn verify:dispute-opt-in-safe-batch` with the exact paths as defaults and artifact-child mode for the postcommit handoff check.

Extend `tsconfig.dispute-deployment.json` with `deployments/safeBatchManifest.ts`, `scripts/simulate-dispute-opt-in-safe-batch.ts`, and `scripts/verify-dispute-opt-in-safe-batch.ts` before running its typecheck.

**Step 4: Implement Base-staging next-step preparation and execution gates**

Preparation first requires `paymentBindingCutoverReady(hre) === true`, then reads the authorized EOA nonce/balance/gas and simulates only the next call without sending it or writing Safe artifacts. A separately confirmed activation run repeats the full-cutover and transaction preflight and sends only that one call. Reruns classify state again before proceeding. State 3 drain checks follow Step 1 and never remove the predecessor writer while either old-vault accounting total is nonzero.

**Step 5: Prove the obsolete batch is invalid before archival**

Decode the old four-call batch, assert its exact historical targets/calldata, fork the modeled Base state after clearing predecessor vault/policy pending owners, and prove atomic execution reverts before the hook call. Keep the real file in its current location until the actual Base deployment confirms invalidation; archival belongs to Task 8.

**Step 6: Run and commit**

Run `node scripts/test-opt-in-dispute-lifecycle-deployment.cjs`, the focused Safe simulation unit tests, `yarn typecheck:dispute-deployment`, and `yarn transpile`. Expected: pass.

```bash
git add deploy/34_deploy_opt_in_dispute_lifecycle_stack.ts \
  deployments/safeBatchManifest.ts \
  contracts/mocks/DisputeLifecyclePostcondition.sol \
  scripts/simulate-dispute-opt-in-safe-batch.ts \
  scripts/verify-dispute-opt-in-safe-batch.ts \
  scripts/test-opt-in-dispute-lifecycle-deployment.cjs \
  tsconfig.dispute-deployment.json package.json
git commit -m "feat: prepare dispute lifecycle governance cutover"
```

### Task 6: Route every public artifact consumer through the alias manifest

**Files:**
- Create: `scripts/canonicalizeDeploymentOutput.ts`
- Modify: `package.json`
- Modify: `packages/contracts/scripts/extractors/addresses.ts`
- Modify: `packages/contracts/scripts/extractors/abis.ts`
- Modify: `packages/contracts/scripts/verify-release.mjs`
- Modify: `packages/contracts/scripts/smoke-installed.mjs`
- Modify: `scripts/active-dispute-stack.spec.cjs`
- Modify: `tsconfig.dispute-deployment.json`

**Step 1: Extend failing tests**

Feed outputs containing predecessor canonical records and successor `*OptIn` records. Assert every generated output/address/ABI/smoke view exposes canonical successor names and addresses, contains no public `*OptIn`, and leaves historical deployment JSON bytes unchanged.

**Step 2: Implement canonicalization**

`canonicalizeDeploymentOutput.ts <network> <file>` loads `deployments/activeDisputeStack.cjs`, rewrites the three canonical contract entries from the selected internal records, deletes internal names, validates matching canonical artifact ABIs, and writes deterministic TypeScript output. Update Base deployment scripts to call this after `hardhat export` and before package extraction.

The TypeScript extractors require the same CJS module, and the ESM verifier/smoke test use `createRequire`; none gets its own mapping. The release verifier resolves the exact selected deployment artifact path rather than assuming `${canonicalName}.json`. The installed smoke test rejects internal-name exports and derives both expected live-network canonical tuples from the checked-in manifest and deployment records rather than duplicating addresses.

Finalize `tsconfig.dispute-deployment.json` by retaining every file added in Tasks 3 through 5 and adding exactly `scripts/canonicalizeDeploymentOutput.ts`, `packages/contracts/scripts/extractors/addresses.ts`, `packages/contracts/scripts/extractors/abis.ts`, `packages/contracts/scripts/verify-release.mjs`, and `packages/contracts/scripts/smoke-installed.mjs`. Thus `checkJs` covers every CJS/ESM/TS resolver consumer as well as the governance helpers. `yarn typecheck:dispute-deployment` must fail if any consumer calls a resolver with an unsupported network or invalid deployment-map shape.

**Step 3: Run package checks and commit**

Run:

```bash
node --test scripts/active-dispute-stack.spec.cjs
yarn typecheck:dispute-deployment
yarn compile
yarn workspace @zkp2p/contracts-v2 extract
yarn workspace @zkp2p/contracts-v2 build
yarn workspace @zkp2p/contracts-v2 verify:release
```

Expected: all checks pass against current manifest selections.

```bash
git add scripts/canonicalizeDeploymentOutput.ts package.json \
  packages/contracts/scripts/extractors/addresses.ts \
  packages/contracts/scripts/extractors/abis.ts \
  packages/contracts/scripts/verify-release.mjs \
  packages/contracts/scripts/smoke-installed.mjs \
  scripts/active-dispute-stack.spec.cjs tsconfig.dispute-deployment.json
git commit -m "fix: export the active dispute stack canonically"
```

### Task 7: Verify and deliver the contracts implementation

**Files:**
- Modify generated artifacts/TypeChain/package outputs only through their generators
- Modify: `docs/superpowers/specs/2026-08-20-dispute-protection-opt-in-cutover-design.md`

**Step 1: Run proportionate gates**

Run focused Foundry tests, deployment Node tests, `yarn transpile`, ABI equality, package extraction/build/release verification, `git diff --check`, and stale-prose scans first. Then run one final `yarn test` because this changes shared admission and deployment/release surfaces. Do not run local coverage.

**Step 2: Run the security differential audit**

Use `audit diff origin/main`. Resolve High/Medium branch-introduced findings; record Low/Informational findings and avoid out-of-scope cleanup.

**Step 3: Commit the exact tracked release surface**

Hardhat `artifacts/`, `typechain/`, and package `_cjs/`, `_esm/`, `_types/`, `abis/`, and `addresses/` directories are ignored build products and must not be force-added. Before committing, inspect `git status --short` and allow only the reviewed source files plus the tracked canonical exports and design document below:

```bash
git add deployments/outputs/baseContracts.ts \
  deployments/outputs/baseStagingContracts.ts \
  docs/superpowers/specs/2026-08-20-dispute-protection-opt-in-cutover-design.md
git diff --cached --name-only
git commit -m "chore: prepare opt-in dispute deployment release"
```

If either tracked export is byte-identical and absent from `git status`, omit it rather than staging generated noise. Abort if any other generated path is staged.

**Step 4: Push and merge the contracts implementation PR**

Push `codex/dispute-protection-opt-in`, create the PR with behavior, deployment, package, and governance impacts, then monitor the complete Foundry and release-readiness checks required for this release surface. Merge through the repository's normal protected path, resolve the canonical merge SHA, and require exact green complete-Foundry and `Release readiness` evidence for that SHA. Perform live deployment from a clean checkout of that merge SHA; do not deploy from the PR head or a SHA lacking exact green evidence.

### Task 8: Perform passive Base-staging and Base deployments

**Files:**
- Create from Hardhat Deploy: `deployments/base_staging/StakeVaultOptIn.json`
- Create from Hardhat Deploy: `deployments/base_staging/DisputeProtectionPolicyOptIn.json`
- Create from Hardhat Deploy: `deployments/base_staging/IntentLifecycleHookV1OptIn.json`
- Create from Hardhat Deploy: `deployments/base/StakeVaultOptIn.json`
- Create from Hardhat Deploy: `deployments/base/DisputeProtectionPolicyOptIn.json`
- Create from Hardhat Deploy: `deployments/base/IntentLifecycleHookV1OptIn.json`
- Modify: `deployments/active-dispute-stack.json`
- Modify generated: `deployments/outputs/baseStagingContracts.ts`
- Modify generated: `deployments/outputs/baseContracts.ts`
- Modify generated package addresses/ABIs
- Move after verified Base invalidation: `deployments/outputs/safe-batches/base_2026-08-11T07-40-03.json` to `deployments/outputs/safe-batches/superseded/base_2026-08-11T07-40-03.json`

**Step 1: Re-read live state and exact release evidence**

Verify current hook, the dispute verifier/nullifier addresses and code hashes needed by the passive successor, predecessor/fresh vault accounting, owners/pending owners/controller, writer set, deployer nonce/balance/gas, and exact green CI/release-readiness SHA. Abort on drift. Do not require lane 31's full payment-binding cutover for passive deployment; that remains an activation-only gate in Tasks 5 and 12.

**Step 2: Deploy Base staging passively**

Run the dedicated lane-34 tag-scoped command with only `ENABLE_STAGING_V3_DISPUTE_OPT_IN_DEPLOYMENT=true`. Verify three new records, empty accounting, configured controller/hook/risk windows, ownership transfer state, unchanged predecessor writer, and unchanged active old combined hook. Run `yarn verify:dispute-opt-in:base_staging`; its exact three-record allowlist and `--fail-on-error` must exit nonzero for any verification failure, while an already-verified response is acceptable. Do not activate.

**Step 3: Deploy Base passively**

Run the dedicated lane-34 tag-scoped command with only `ENABLE_BASE_V3_DISPUTE_OPT_IN_DEPLOYMENT=true`. Verify the fresh trio, empty accounting, ownership transfer state, unchanged active whitelist hook and writer set, and cleared obsolete predecessor vault/policy pending owners. Run `yarn verify:dispute-opt-in:base`; its exact three-record allowlist and `--fail-on-error` must exit nonzero for any verification failure, while an already-verified response is acceptable. Prove the exact obsolete atomic batch now reverts, then archive it under `safe-batches/superseded/`. Do not execute or submit a Safe batch.

**Step 4: Switch manifest aliases only after both deployments verify**

Set Base and Base staging canonical values to the three `*OptIn` records, regenerate canonical outputs/package artifacts, verify no public internal names, and commit the exact real deployment artifacts plus outputs.

**Step 5: Gate the deployment-artifact commit**

Push the artifact commit/PR, merge it through the normal protected path, and require the exact canonical deployment/package SHA to pass complete Foundry plus `Release readiness` before publication.

### Task 9: Publish the protected contracts package

**Files:**
- Modify only the release files selected by `zkp2p-contracts-publish`

**Step 1: Invoke the repository publish skill**

Use `zkp2p-contracts-publish` to discover the current npm release line and next unused version. Do not assume a version and do not publish locally.

**Step 2: Gate and publish**

Require the exact deployment/package SHA to have green complete Foundry and `Release readiness` results. Use the protected GitHub Actions trusted publisher with OIDC/provenance.

**Step 3: Verify publication**

Verify npm version/dist-tag/integrity/provenance, unpacked installed smoke tests, and Base/Base-staging canonical vault/policy/hook addresses.

### Task 10: Implement the indexer hard cut after real addresses exist

**Files (in `../zkp2p-indexer`):**
- Modify: `src/config/contractAddresses.ts`
- Modify: `src/services/quoteCandidates.ts`
- Modify: `src/handlers/v3/dispute_protection_policy.ts`
- Modify: `test/config/contractAddresses.test.ts`
- Modify: `test/v3/dispute_protection_policy.test.ts`
- Modify: `test/services/quoteCandidates.test.ts`
- Modify: `test/v3/config_schema.test.ts`
- Modify: `config.base_staging.yaml`
- Modify: `config.base_prod.yaml`
- Modify: `config.local.yaml` as required for generated parity
- Modify: `scripts/check-config-sync.cjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `packages/indexer-schema/README.md`
- Modify: `packages/indexer-schema/docs/schema-field-reference.md`
- Modify: `packages/indexer-schema/llms.txt`
- Modify generated Envio/config/schema outputs

**Step 1: Create an indexer branch from fresh canonical main**

Fetch, switch from release branches to a new `codex/dispute-protection-opt-in` branch based on `origin/main`, and confirm the worktree is clean.

**Step 2: Write failing resolver tests**

Change both `resolveDisputeProtectionConfigProjection` and the effective resolver to receive `activePolicyAddress`. Test that the projection selects only the active policy when predecessor and successor rows coexist regardless of lexicographic address order; missing active config is false; explicit false is false; explicit true is false for a predecessor/competing policy; explicit true is false when the active policy risk window is zero/missing; and explicit true is true only for the active policy plus nonzero window. Include Base and Base staging fixtures with chain ID 8453 but different active policies, plus a predecessor event that cannot mutate either `QuoteCandidate` or `OrderbookEntry`.

**Step 3: Implement the resolver hard cut**

Use:

```ts
if (!config || !config.enabled) return false;
if (normalizeAddress(config.policyAddress) !== normalizeAddress(activePolicyAddress)) return false;
const riskWindow = await context.DisputeProtectionRiskWindow.get(
  buildRiskWindowId(chainId, activePolicyAddress, paymentMethodHash),
);
return (riskWindow?.riskWindow ?? 0n) !== 0n;
```

Delete the missing-config risk-window scan and every lexicographic policy fallback. Filter `resolveDisputeProtectionConfigProjection` to the normalized active policy before selecting a row. Add `DisputeProtectionPolicy` to `src/config/contractAddresses.ts`, where `ENVIO_DEPLOYMENT_ENV` already distinguishes staging and production package bundles. Pass that environment-resolved address through every quote creation/refresh and both event fan-out paths. Ignore predecessor events for effective projection. Extend `test/config/contractAddresses.test.ts` so Base and Base staging share chain ID 8453 but resolve different active policies.

**Step 4: Update actual package and network configs**

Update `@zkp2p/contracts-v2` plus lockfile to the published version. Bind Base and Base staging policy/vault addresses to the real lane-34 records and record each deployment block in the adjacent comment/artifact scan; Envio has one chain-level `start_block`, not per-contract from-blocks. Preserve the comment-only hook address with the real fresh hook. Extend `scripts/check-config-sync.cjs` beyond pre-`chains` text comparison so it compares the environment-resolved package policy with the corresponding YAML binding. Rewrite all four schema/indexer documentation surfaces so missing configuration is disabled, not enabled.

**Step 5: Generate and verify**

Run:

```bash
pnpm codegen
NODE_OPTIONS='--no-warnings --import tsx' pnpm exec mocha --timeout 20000 --exit test/v3/dispute_protection_policy.test.ts test/services/quoteCandidates.test.ts test/v3/config_schema.test.ts test/config/contractAddresses.test.ts
pnpm typecheck
pnpm check:config-sync
```

Then run the repository's package/config/address scans and one complete test suite at the finalized indexer state.

**Step 6: Commit, push, and deliver the indexer PR**

Commit code and generated/lockfile changes coherently. Push and wait for exact-head CI. Deploy/reindex staging and production through their normal release lanes only after the corresponding approvals; verify predecessor policy events cannot opt deposits into the successor projection.

### Task 11: Propagate the published package to Curator

**Files (in `../curator`):**
- Modify: `package.json`
- Modify: `yarn.lock`
- Modify only generated/config files changed by the package update

**Step 1: Create a clean Curator branch from fresh main**

First require the existing `richard/dispute-lifecycle-enforcement` PR to be reviewed, merged, and present on canonical `origin/main`; that change makes `IntentLifecycleHookV1` the exact-hook readiness target and is a prerequisite for the promised preactivation fail-closed state. If it is not merged, stop rather than performing a package-only bump that would still report `WhitelistLifecycleHook` as canonical. After the prerequisite merge, do not build on the old feature checkout: fetch updated canonical main and create an isolated feature branch/worktree if the current checkout has unrelated work.

**Step 2: Bump only the contracts package**

Update `@zkp2p/contracts-v2` to the verified published version and regenerate `yarn.lock`. Do not change lifecycle readiness behavior: before activation, the exact-hook check must continue to produce the expected fail-closed/direct-only state.

**Step 3: Verify and deploy both environments**

Run focused `v3ChainConfig`, lifecycle readiness, and Earn tests plus typecheck. Deliver the Curator PR, merge through normal protections, deploy staging and production through their normal lanes, and verify both environments consume the fresh package tuple while remaining non-`Canonical` before hook activation.

### Task 12: Prepare activation artifacts and hand off governance

**Files:**
- Create after fresh reads: `deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.json`
- Create after fresh reads: `deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.sha256.json`
- Create after commit: `deployments/outputs/safe-batches/base_opt_in_dispute_lifecycle.handoff.md`
- No Base-staging Safe artifact

**Step 1: Prove downstream readiness**

Verify the published package and deployed indexer configs expose the exact fresh addresses. Verify Curator consumes the new tuple and is fail-closed/direct-only while the predecessor hook remains active; do not require `Canonical` yet. Call lane 31's read-only `paymentBindingCutoverReady` against a fresh Base block and require `true` before creating any governance artifact.

**Step 2: Prepare, but do not execute, Base activation**

Generate the exact Safe batch and sidecar at the two deterministic paths from fresh chain/Safe/source/CI state, using the pinned fork driver and `paymentBindingCutoverReady`; generation mode first proves the clean checkout is exactly the recorded `sourceSha`. Commit them as an artifact-only child whose parent is that source SHA. From the clean artifact-child commit, run artifact-child verification against the committed pair and fresh RPC state; it must prove `sourceSha` ancestry and that the complete descendant diff contains only the exact batch, sidecar, and explicitly allowed obsolete-batch archival evidence. Only after that verification passes, create `base_opt_in_dispute_lifecycle.handoff.md` recording the artifact commit SHA and verification result, then present the three exact paths for separate Safe-owner review and approval. The handoff file is deliberately created after verification and is not an input to the batch verifier. Do not sign, propose, or execute it.

**Step 3: Keep staging activation separately gated**

Require `paymentBindingCutoverReady(hre) === true`, report the exact next staging EOA transition and its fresh simulation. Do not send it without separate activation approval. After any approved transition, rerun the full-cutover gate, classifier, drain reads, and postflight before advancing.

**Step 4: Postflight after external activation**

After external governance execution, verify emitted hook update, active fresh hook, exact writer set, owners/controllers/risk windows, both vault accounting states, indexer catch-up, cache refresh, and only then Curator `Canonical` readiness.
