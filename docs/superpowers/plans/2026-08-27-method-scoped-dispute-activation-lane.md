# Method-Scoped Dispute Activation Lane (38) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every non-UI code step is written by Codex via the `/codex` skill; Claude orchestrates, reviews, and runs verification.
>
> **Review:** Internal self-review ✅ | Codex convergence ✅ (3 rounds; all findings accepted)

**Goal:** Ship `deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts` and its guard/postcondition contracts, manifest, simulate/verify scripts, and tests, so Base staging can be activated one EOA transition per run and Base through two unsigned, on-chain-guarded Safe batches — without executing anything live in this PR.

**Architecture:** Pure logic (snapshot type, reducer, batch builders, lock proof, inventory) lives in `deployments/methodScopedActivation.ts` and is unit-tested offline; the lane owns chain reads, execution, guard deployment, and artifact writing; `deployments/activationBatchManifest.ts` is the v2 sidecar with a specified canonical serializer; `deployments/safeArtifacts.ts` installs pairs crash-safely; `scripts/simulate-method-scoped-safe-batch.ts` / `scripts/verify-method-scoped-safe-batch.ts` mirror lane 34's tooling with an in-memory candidate core; two guard, two postcondition, and one orchestrator-surface mock live under `contracts/mocks/`.

**Tech Stack:** Solidity 0.8.18 (mocks only), Foundry, TypeScript Hardhat Deploy, ethers v5, Node `node:test`, in-process Hardhat network for the rehearsal.

**Spec:** `docs/superpowers/specs/2026-08-27-method-scoped-dispute-activation-lane-design.md` — normative for every list and rule; this plan pins names and shapes.

## Global Constraints

- Lane 38 never signs, proposes, or executes a Safe transaction; staging transitions execute only under `ENABLE_STAGING_V3_DISPUTE_METHOD_SCOPED_ACTIVATION=true`, one per run, and only when `DEPLOY_ACTIVE_TAG === "38_activate_method_scoped_dispute_lifecycle_stack"`.
- Do not touch `deploy/29*`, `deploy/30*`, `deploy/31*`, `deploy/32*`, `deploy/34*`, `deploy/36*`, `deploy/37*`, `deployments/*/*.json`, `deployments/outputs/*`, `dispute-stack-evidence.json`, `active-dispute-stack.json`, the **values** in `predecessorDisputeStack.ts` and `immutableDeploymentLanes.ts`, or `safeBatchManifest.ts`. Adding an optional parameter to a current helper (listed per task) is allowed; changing pinned data is not.
- Solidity only under `contracts/mocks/`; four-space indent, explicit visibility, custom errors, NatSpec; `forge fmt --check`.
- **Block tags.** Every activation-state read in the lane and verifier passes an explicit `blockTag` (ethers call override `{ blockTag }`, `getLogs` with explicit `fromBlock`/`toBlock`, `getCode(address, blockTag)`). Helpers reused from the repo gain an optional trailing `blockTag` parameter where they read chain state (Task 3 lists them). The one deliberate latest-block read is lane 31's `paymentBindingCutoverReady(hre)` — a global invariant, not activation state, and not part of any guard; it is called once per run and documented as such.
- Reuse: `assertDeploymentMatchesChain` / `assertCanonicalDeployment` / `zeroImmutableValues` (`deployments/canonicalDeployment.ts`), `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS` + `assertHistoricalDisputeStack` (`deployments/predecessorDisputeStack.ts`), lane 37 exports (`EXPECTED_LIVE`, `getRiskWindowPaymentMethods`, `classifyFreshStackActivity`, `decodeFreshStackLogs`, `LIVE_SUCCESSOR_DEPLOYMENT_NAMES`), lane 36's `METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME`, lane-34 simulate-script exports (`BASE_SAFE`, `BASE_SAFE_RUNTIME_HASH`, `MULTI_SEND_CALL_ONLY`, `MULTI_SEND_CALL_ONLY_RUNTIME_HASH`, `packMultiSendTransactions`, `encodeMultiSendCalldata`, `decodeSafeSimulationEnvelope`, `restoreHardhatModuleResolution`, `requireRuntimeHash`), `normalizeSafeTransactions` / `canonicalTransactionHash` (`safeBatchManifest.ts`), `paymentBindingCutoverReady` (lane 31). Do **not** import `assertSafeArtifactGitState` from the lane-34 verifier: its artifact-child allowlist is hard-coded to lane-34 paths (`scripts/verify-dispute-opt-in-safe-batch.ts:61-65`); Task 4 defines a parameterized copy.
- JSON normalization (used by the manifest, the snapshot, and every test fixture): addresses lowercase `0x` + 40 hex; hashes lowercase `0x` + 64 hex; **envelope metadata is a JSON safe integer** (`version`, `chainId`, block numbers, `transactionIndex`, `logIndex`, `operation`), **every on-chain quantity is a decimal string** (`safeNonce`, `requiredSignatures`, `value`, amounts, timestamps, `pendingControllerValidAt`, `controllerChangeDelay`, risk windows, `depositCounter`, `depositId`, `protocolFee`); no `BigNumber`, no floats; arrays preserve chain order (writers as returned by `getWriters()`, witnesses as returned by `witnesses()`, authorized hooks in first-authorization order); no `undefined` (omit the key or use `null` only where the type says so).
- Commits: conventional prefix, explicit-path staging, `git diff --check`, and these trailer lines on every commit:

  ```text
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
  ```

- Verification ladder per task; full `yarn test` once at the end; no `yarn coverage` locally.

---

### Task 1: Guard, postcondition, and orchestrator-surface mocks + Foundry tests

**Files:**
- Create: `contracts/mocks/DisputeMethodScopedActivationTypes.sol`, `contracts/mocks/DisputeMethodScopedRotationGuard.sol`, `contracts/mocks/DisputeMethodScopedCutoverGuard.sol`, `contracts/mocks/DisputeMethodScopedRotationPostcondition.sol`, `contracts/mocks/DisputeMethodScopedCutoverPostcondition.sol`, `contracts/mocks/OrchestratorV3SurfaceMock.sol`
- Test: `test-foundry/deterministic/mocks/DisputeMethodScopedActivation.t.sol`
- Reference: `contracts/mocks/DisputeLifecyclePostcondition.sol` (style: minimal local interfaces), `contracts/StakeVault.sol` (`locks(bytes32)` returns the `StakeLock` struct — `rg -n "struct StakeLock" -A 6 contracts/StakeVault.sol`; `controller`, `pendingController`, `pendingControllerValidAt`, `controllerChangeDelay`), `contracts/hooks/DisputeProtectionPolicy.sol`, `contracts/hooks/IntentLifecycleHookV1.sol`, `contracts/hooks/WhitelistPolicy.sol`, `contracts/registries/NullifierRegistry.sol` (`getWriters`), `contracts/OrchestratorV3.sol`, `contracts/EscrowV2.sol` (`depositCounter` public at L82, `getDeposit`, `getDepositPaymentMethods(uint256) returns (bytes32[])` — confirm with `rg -n "function getDepositPaymentMethods" contracts/EscrowV2.sol contracts/interfaces/IEscrowV2.sol`; note `IEscrowV2` does **not** declare `depositCounter`, so the guard's local interface must), `contracts/unifiedVerifier/DisputeVerifier.sol`, `contracts/unifiedVerifier/MultiAttestationVerifier.sol` (`witnesses()` L121, `requiredSignatures` public at L28), `contracts/registries/OrchestratorRegistry.sol` (`isOrchestrator`), `test-foundry/deterministic/helpers/OrchestratorV3Fixture.sol` (note it sets `allowMultipleIntents(true)` at L104; the trust surface expects `false`).

**Interfaces (Produces):**

```solidity
// DisputeMethodScopedActivationTypes.sol — shared structs + minimal interfaces (declared here, not imported from core)
interface IActivationEscrow {
    function depositCounter() external view returns (uint256);
    function getDepositPaymentMethods(uint256 depositId) external view returns (bytes32[] memory);
}
struct TrustSurface {
    address safe;
    address disputeRegistry;          // Ownable: owner == safe
    address orchestrator;             // owner == safe, !paused(), escrowRegistry/paymentVerifierRegistry/relayerRegistry pins, protocolFee == 0, protocolFeeRecipient, allowMultipleIntents == false
    address orchestratorRegistry;     // isOrchestrator(orchestrator)
    address escrowRegistry;
    address paymentVerifierRegistry;
    address relayerRegistry;
    address protocolFeeRecipient;
    address freshHook;                // orchestratorRegistry()/whitelistPolicy()/disputeProtectionPolicy() pins
    address whitelistPolicy;          // owner == safe; escrowRegistry()/groupRegistry()/orchestratorRegistry() pins
    address groupRegistry;
    address attestationVerifier;      // owner == safe; requiredSignatures == 1; witnesses() == witnesses (order)
    address[] witnesses;
    address disputeVerifier;          // Ownable2Step: owner == safe, pendingOwner == 0; attestationVerifier()/nullifierRegistry() pins
    address nullifierRegistryV2;
    address predecessorPolicy;        // Ownable2Step: owner == safe, pendingOwner == 0; disputeVerifier() == disputeVerifier; disputeNullifierRegistry() == disputeRegistry
    address freshPolicy;              // disputeVerifier() == disputeVerifier; disputeNullifierRegistry() == disputeRegistry; stakeVault() == vault; hook auths; windows
    address vault;                    // Ownable2Step: owner == safe, pendingOwner == 0
    address predecessorHook;
    bytes32[] paymentMethods;         // every active method of the network
    uint64[] riskWindows;             // expected window per method (0 for non-disputable)
}
struct InventoryTuple { address escrow; uint256 depositId; bytes32 paymentMethod; }
```

- `DisputeMethodScopedRotationGuard(TrustSurface, bool expectAcceptOwnership, address deployer)`. `assertReady()`: trust surface (a shared internal `_assertTrustSurface` in a base contract `DisputeMethodScopedTrustSurfaceChecks` that all four contracts inherit); vault controller == predecessorPolicy, pendingController == 0; predecessor `admissionsPaused() == false`; writers == [predecessorPolicy]; hook == predecessorHook; fresh policy exactly `expectAcceptOwnership ? (owner == deployer && pendingOwner == safe) : (owner == safe && pendingOwner == 0)`; fresh policy `admissionsPaused() == false`, `isLifecycleHookAuthorized(freshHook)`, `!isLifecycleHookAuthorized(predecessorHook)`, `getRiskWindow(paymentMethods[i]) == riskWindows[i]`.
- `DisputeMethodScopedCutoverGuard(TrustSurface, bytes32[] intentHashes, InventoryTuple[] tuples, address escrow, uint256 depositCounter)`. `assertReady()`: trust surface; vault pendingController == freshPolicy and `block.timestamp >= pendingControllerValidAt`; controller == predecessorPolicy; predecessor `admissionsPaused() == true`; writers == [predecessorPolicy]; hook == predecessorHook; fresh policy owner == safe, pendingOwner == 0, `admissionsPaused() == false`, hook auths, windows; for each intent hash: status ∈ {CANCELLED(2), RELEASED(4), DISPUTED(5)} **and** `locks(h).amount == 0`; `IActivationEscrow(escrow).depositCounter() == depositCounter`; for each tuple `!freshPolicy.isDisputeProtectionEnabled(t.escrow, t.depositId, t.paymentMethod)`.
- `DisputeMethodScopedRotationPostcondition(TrustSurface, uint64 controllerChangeDelay)`. `assertPostconditions()`: trust surface; fresh policy owner == safe, pendingOwner == 0; predecessor paused; vault pendingController == freshPolicy, controller == predecessorPolicy, owner == safe, pendingOwner == 0, and **`pendingControllerValidAt >= block.timestamp + controllerChangeDelay`** (normative; `StakeVault.proposeController` sets `validAt = block.timestamp + delay`, and the fork simulation executes batch and postcondition in the same call, so this holds exactly without knowing any timestamp at construction); writers == [predecessorPolicy]; hook == predecessorHook.
- `DisputeMethodScopedCutoverPostcondition(TrustSurface)`. `assertPostconditions()`: trust surface; vault controller == freshPolicy, pendingController == 0, owner == safe, pendingOwner == 0; fresh policy owner == safe, pendingOwner == 0, `admissionsPaused() == false`, `isLifecycleHookAuthorized(freshHook)`; writers == [freshPolicy]; hook == freshHook; windows.
- `OrchestratorV3SurfaceMock(owner, escrowRegistry, paymentVerifierRegistry, relayerRegistry, protocolFeeRecipient)` — exposes `owner()`, `paused()`, `lifecycleHook()`, `setLifecycleHook(address)` (onlyOwner), `escrowRegistry()`, `paymentVerifierRegistry()`, `relayerRegistry()`, `protocolFee()` (0), `protocolFeeRecipient()`, `allowMultipleIntents()` (false), plus `setPaused(bool)` and `setAllowMultipleIntents(bool)` test setters. Used by the Foundry immutable-field variants and the JS rehearsal; the Foundry happy path uses the real `OrchestratorV3` from the fixture.

Every check reverts with a distinct custom error naming the field (e.g. `error RegistryOwnerMismatch(address actual)`).

- [ ] **Step 1: Write the failing Foundry test.** Fixture (in `setUp`, reusing `OrchestratorV3Fixture`): deploy `USDCMock` (fixture token), `StakeVault(owner=this, token, 0, 2 days)`, `NullifierRegistry` dispute registry, `DisputeVerifier(this, nullifierRegistryV2, attestationVerifier)`, predecessor + fresh `DisputeProtectionPolicy(this, vault, verifier, registry)`, `AddressGroupRegistry` + `WhitelistPolicy(groups, escrowRegistry, orchestratorRegistry)`, predecessor + fresh `IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, policy)`, real `MultiAttestationVerifier` with one witness and `requiredSignatures = 1` (check its constructor). Wiring: `vault.initializeController(predecessor)`; `registry.addWritePermission(predecessor)`; both policies `setLifecycleHookAuthorization(theirHook, true)`; both policies `setRiskWindow(METHOD, RISK_WINDOW)` and zero for the other fixture methods; `orchestrator.setLifecycleHook(predecessorHook)`; `orchestrator.setAllowMultipleIntents(false)` (override the fixture's `true`); a `SAFE` address (`makeAddr("safe")`) that receives ownership: plain `Ownable` (registry, orchestrator, whitelist policy, attestation verifier) via `transferOwnership(SAFE)`; `Ownable2Step` (vault, both policies, verifier) via `transferOwnership(SAFE)` then `vm.prank(SAFE); acceptOwnership()`; fresh policy left in `owner == this, pendingOwner == SAFE` for the `expectAcceptOwnership` variant. Stake: `_stake(taker, STAKE_AMOUNT)` then open one intent through the predecessor policy (`vm.prank(predecessorHook); predecessor.onIntentSignaled(...)`) and settle it (`onIntentSettled`). Build `TrustSurface` from these.
  Tests: `test_RotationGuardPassesInDeployedState`; one `test_RotationGuardRejects<Field>` per bound field; `test_CutoverGuardPassesAfterDelayAndDrain` (as SAFE: pause predecessor, `proposeController(fresh)`, `vm.warp` past the delay and past the intent's maturity, `releaseMaturedDisputeProtectionIntent`, opt the fixture deposit out on the fresh policy for each inventory tuple passed); one `test_CutoverGuardRejects<Field>` per bound field including: before `validAt`, predecessor unpaused, `PENDING` intent, `SETTLED` intent with amount > 0, `CANCELLED` status with a nonzero lock (construct via a mock vault returning a nonzero amount — add `StakeVaultLocksMock` to the test file), `depositCounter` changed (create a deposit via the fixture), an inventory tuple reading `true`; postcondition pass/reject sets analogously. **Immutable-field rejections use alternate `TrustSurface` pointers** (e.g. point `surface.orchestratorRegistry` at a second `OrchestratorRegistry`, `surface.vault` at a second vault, `surface.nullifierRegistryV2` at another registry) instead of mutating deployed contracts; where the real `OrchestratorV3` cannot be re-pointed, use `OrchestratorV3SurfaceMock` for that variant.
- [ ] **Step 2: Run** `forge test --match-path 'test-foundry/deterministic/mocks/DisputeMethodScopedActivation.t.sol'` — FAIL (contracts missing).
- [ ] **Step 3: Implement the six Solidity files.**
- [ ] **Step 4: GREEN** + `forge fmt --check` on the seven `.sol` files.
- [ ] **Step 5: Commit** `feat(mocks): method-scoped activation guards and postconditions`.

---

### Task 2: Pure activation logic module + v2 manifest + artifact installer + unit tests

**Files:**
- Create: `deployments/methodScopedActivation.ts`, `deployments/activationBatchManifest.ts`, `deployments/safeArtifacts.ts`
- Test: `scripts/test-method-scoped-activation.cjs` (same bootstrap as `scripts/test-method-scoped-deployment.cjs` L1-60)
- Modify: `tsconfig.dispute-deployment.json`, `package.json` (`"test:method-scoped-activation": "node scripts/test-method-scoped-activation.cjs"`)

**Interfaces (Produces — exact):**

```ts
// deployments/methodScopedActivation.ts — pure; imports only `ethers` (utils/BigNumber) and safeBatchManifest types
export type ActivationNetwork = "base" | "base_staging";
export type IntentStatus = 0 | 1 | 2 | 3 | 4 | 5; // NONE, PENDING, CANCELLED, SETTLED, RELEASED, DISPUTED
export type IntentClassification = "none" | "pending" | "settled-unmatured" | "settled-matured" | "terminal" | "terminal-locked";
export type IntentLockState = { intentHash: string; status: IntentStatus; lockAmount: string; maturesAt: string; classification: IntentClassification };
export function classifyIntentLock(status: IntentStatus, lockAmount: string, maturesAt: string, now: string): IntentClassification;
// terminal := status ∈ {2,4,5} && lockAmount == "0"; terminal-locked := status ∈ {2,4,5} && lockAmount != "0" (fails); settled-matured := status 3 && now >= maturesAt
export type LockProof = { fromBlock: number; toBlock: number; intents: IntentLockState[]; ok: boolean; releasable: string[]; blocking: string[]; earliestMaturity: string | null };
export function proveNoLivePredecessorLocks(intents: IntentLockState[], fromBlock: number, toBlock: number): LockProof; // ok iff every classification === "terminal"

export type InventorySource = "predecessor-opt-out" | "token-mismatch";
export type InventoryTuple = { escrow: string; depositId: string; paymentMethod: string; sources: InventorySource[] }; // sorted, deduplicated
export type ConfigEvent = { escrow: string; depositId: string; paymentMethod: string | null; enabled: boolean; blockNumber: number; transactionIndex: number; logIndex: number };
export type InventoryDeposit = { depositId: string; depositor: string; token: string; listedPaymentMethods: string[] };
export type InventoryInput = {
  escrow: string; depositCounter: string; stakeToken: string; block: number;
  deposits: InventoryDeposit[];                       // caller passes every id in [0, depositCounter); the function keeps depositor != 0
  successorRiskWindows: Record<string, string>;      // paymentMethod -> window (decimal string)
  predecessorEvents: ConfigEvent[]; successorEvents: ConfigEvent[]; // MAY contain other escrows; the function ignores any event whose escrow !== input.escrow
  successorEnabled: (depositId: string, paymentMethod: string) => boolean;
};
export type DepositorInventory = { escrow: string; depositCounter: string; block: number; tuples: InventoryTuple[]; violations: InventoryTuple[]; ok: boolean };
export function buildDepositorInventory(input: InventoryInput): DepositorInventory;
// set A: latest predecessor event per deposit (paymentMethod null) is enabled=false → every listed method with nonzero window,
//        minus tuples whose latest successor event (block, txIndex, logIndex) is newer than that predecessor event;
// set B: token != stakeToken → every listed method with nonzero window (never removed);
// violations: tuples where successorEnabled(...) === true; ok := violations.length === 0

export type OwnershipState = { owner: string; pendingOwner: string };
export type ActivationSnapshot = {
  network: ActivationNetwork; blockNumber: number; blockHash: string; blockTimestamp: string;
  freshPolicy: OwnershipState & { admissionsPaused: boolean; disputeVerifier: string; disputeNullifierRegistry: string; stakeVault: string; authorizedHooks: string[]; riskWindows: Record<string, string> }; // authorizedHooks := replay of LifecycleHookAuthorizationUpdated on the fresh policy from its record's receipt.blockNumber to blockTag (latest value per hook, keep those true); the reducer requires it to equal exactly [freshHook] — a third hook is a violation
  predecessorPolicy: OwnershipState & { admissionsPaused: boolean; disputeVerifier: string; disputeNullifierRegistry: string };
  disputeVerifier: OwnershipState & { attestationVerifier: string; nullifierRegistry: string };
  vault: OwnershipState & { controller: string; pendingController: string; pendingControllerValidAt: string; controllerChangeDelay: string; stakeToken: string };
  registry: { owner: string; writers: string[] };
  orchestrator: { owner: string; paused: boolean; lifecycleHook: string; escrowRegistry: string; paymentVerifierRegistry: string; relayerRegistry: string; protocolFee: string; protocolFeeRecipient: string; allowMultipleIntents: boolean; registered: boolean };
  freshHook: { orchestratorRegistry: string; whitelistPolicy: string; disputeProtectionPolicy: string };
  whitelistPolicy: { owner: string; escrowRegistry: string; groupRegistry: string; orchestratorRegistry: string };
  attestationVerifier: { owner: string; requiredSignatures: string; witnesses: string[] };
  lockProof: LockProof; inventory: DepositorInventory;
};
export type ExpectedActivationState = {
  network: ActivationNetwork; governance: string; deployer: string;
  addresses: ActivationAddresses; riskWindows: Record<string, string>; witnesses: string[]; controllerChangeDelay: string;
};
export type ActivationAddresses = {
  safe: string; deployer: string; escrow: string; vault: string; predecessorPolicy: string; freshPolicy: string; predecessorHook: string; freshHook: string;
  registry: string; orchestrator: string; orchestratorRegistry: string; escrowRegistry: string; paymentVerifierRegistry: string; relayerRegistry: string;
  protocolFeeRecipient: string; whitelistPolicy: string; groupRegistry: string; attestationVerifier: string; disputeVerifier: string; nullifierRegistryV2: string; stakeToken: string;
};
export type ActivationPhase = "deployed" | "rotation-proposed" | "active" | "unrecognized";
export type StagingAction = "pause-predecessor-admissions" | "propose-controller" | "release-matured-predecessor-intents" | "accept-vault-controller" | "add-fresh-writer" | "set-fresh-hook" | "remove-predecessor-writer";
export type WaitingReason = "controller-delay" | "predecessor-drain";
export type ActivationReduction = { phase: ActivationPhase; nextStagingAction: StagingAction | null; waiting: { reason: WaitingReason; earliestChangeAt: string | null } | null; violations: string[] };
export function reduceActivation(snapshot: ActivationSnapshot, expected: ExpectedActivationState): ActivationReduction;
export const GUARD_BOUND_FIELDS: Record<ActivationBatchKind, readonly string[]>; // dotted snapshot paths bound EXACTLY by each guard (equality fields); excludes blockTimestamp/blockNumber/blockHash and predicate-only fields
//   rotation: every trust-surface field, vault.controller/pendingController/owner/pendingOwner, predecessorPolicy.admissionsPaused, registry.writers, orchestrator.lifecycleHook, freshPolicy.{owner,pendingOwner,admissionsPaused,authorizedHooks,riskWindows,disputeVerifier,stakeVault}
//   cutover:  rotation's fields + vault.pendingControllerValidAt + lockProof.intents (hash/status/lockAmount) + inventory.{depositCounter,tuples}
export const GUARD_PREDICATE_FIELDS: Record<ActivationBatchKind, readonly string[]>; // fields the guard evaluates as predicates at execution (e.g. cutover: blockTimestamp >= vault.pendingControllerValidAt) — documented, not compared for equality
export function assertGuardExpectationsUnchanged(kind: ActivationBatchKind, p: ActivationSnapshot, s: ActivationSnapshot): void; // compares GUARD_BOUND_FIELDS[kind]; throws listing differing paths
export type TrustSurfaceInput = { safe: string; disputeRegistry: string; orchestrator: string; orchestratorRegistry: string; escrowRegistry: string; paymentVerifierRegistry: string; relayerRegistry: string; protocolFeeRecipient: string; freshHook: string; whitelistPolicy: string; groupRegistry: string; attestationVerifier: string; witnesses: string[]; disputeVerifier: string; nullifierRegistryV2: string; predecessorPolicy: string; freshPolicy: string; vault: string; predecessorHook: string; paymentMethods: string[]; riskWindows: string[] };
export function buildTrustSurface(expected: ExpectedActivationState): TrustSurfaceInput; // paymentMethods in getRiskWindowPaymentMethods(network) order
export const ACTIVATION_INTERFACES: { guard: utils.Interface /* assertReady() */; postcondition: utils.Interface /* assertPostconditions() */; policy: utils.Interface /* acceptOwnership, setAdmissionsPaused(bool), acceptVaultController, releaseMaturedDisputeProtectionIntents(bytes32[]) */; vault: utils.Interface /* proposeController(address) */; registry: utils.Interface /* addWritePermission(address), removeWritePermission(address) */; orchestrator: utils.Interface /* setLifecycleHook(address) */ };
export function buildRotationTransactions(input: { addresses: ActivationAddresses; guard: string; includeAcceptOwnership: boolean }): NormalizedSafeBatchTransaction[];
export function buildCutoverTransactions(input: { addresses: ActivationAddresses; guard: string }): NormalizedSafeBatchTransaction[];
export function buildStagingTransaction(action: StagingAction, addresses: ActivationAddresses, lockProof: LockProof): NormalizedSafeBatchTransaction; // release action encodes lockProof.releasable
```

```ts
// deployments/activationBatchManifest.ts
export type ActivationBatchKind = "rotation" | "cutover";
export type ContractIdentity = { address: string; artifactName: string; constructorArgs: unknown[]; deployTransactionHash: string; runtimeCodeHash: string };
export type ActivationBatchManifest = { version: 2; kind: ActivationBatchKind; chainId: 8453; safe: string; safeNonce: string; sourceSha: string; proofBlock: { number: number; hash: string }; simulationBlockNumber: number; simulationBlockHash: string; simulationResult: "success"; transactions: NormalizedSafeBatchTransaction[]; transactionsSha256: string; guard: ContractIdentity; postcondition: ContractIdentity; trustSurface: TrustSurfaceInput; proofSnapshot: ActivationSnapshot; manifestSha256: string };
// proofSnapshot is the full normalized snapshot read at proofBlock (it embeds lockProof and inventory); the verifier reconstructs P from it and compares GUARD_BOUND_FIELDS[kind] against a fresh read; the guard's constructor arguments are re-derived from trustSurface + proofSnapshot.lockProof.intents[].intentHash + proofSnapshot.inventory.tuples + proofSnapshot.inventory.depositCounter
export function canonicalJson(value: unknown): string;
// recursive: objects → keys sorted ascending, arrays in order; strings verbatim; booleans; numbers only if Number.isSafeInteger; throws on BigNumber-like objects ({_hex}/{_isBigNumber}), undefined, floats, functions, symbols; null allowed
export function computeManifestSha256(manifest: Omit<ActivationBatchManifest, "manifestSha256">): string; // sha256(canonicalJson(...)) hex
export function validateActivationBatchManifest(value: unknown, expected?: Partial<ActivationBatchManifest>): asserts value is ActivationBatchManifest; // exact key set, version 2, chainId 8453, formats, recompute transactionsSha256 and manifestSha256
export const ACTIVATION_BATCH_PATHS: Record<ActivationBatchKind, { batch: string; sidecar: string; supersededDir: string; meta: { name: string; description: string } }>;
// rotation: deployments/outputs/safe-batches/base_method_scoped_rotation.json (+ .sha256.json); cutover: …/base_method_scoped_cutover.json (+ .sha256.json); supersededDir: deployments/outputs/safe-batches/superseded
export function safeBatchJson(kind: ActivationBatchKind, transactions: NormalizedSafeBatchTransaction[], createdAtMs: number): object; // same shape as lane 34's safeBatchJson with lane-38 meta
export function assertBatchMatchesActivationManifest(batch: unknown, manifest: ActivationBatchManifest): void;
```

```ts
// deployments/safeArtifacts.ts
export function installSafeArtifactPair(input: { batchPath: string; sidecarPath: string; supersededDir: string; batchContents: string; sidecarContents: string; supersededSuffix: string }): "installed" | "unchanged";
// staged writes (`*.staged-<pid>`), fsync each; if both existing files are byte-identical → remove staged, return "unchanged"; else rename existing pair into supersededDir as `<basename>_<supersededSuffix>.json` / `.sha256.json`, fsync dir; rename staged sidecar, then staged batch; fsync dir; return "installed". Throws if exactly one of the existing files is present.
export function assertSafeArtifactPairConsistent(batchPath: string, sidecarPath: string): { batch: unknown; manifest: unknown }; // both present, sidecar parses, sidecar.transactionsSha256 == canonicalTransactionHash(batch.transactions); else throw "incomplete artifact pair"
```

- [ ] **Step 1: Write the failing tests** in `scripts/test-method-scoped-activation.cjs`: `classifyIntentLock` full table incl. `terminal-locked`; `proveNoLivePredecessorLocks` ok/blocking/releasable/`earliestMaturity`; `buildDepositorInventory` — internal escrow filtering with mixed-escrow events, extant filter, inactive-but-listed windowed method included, zero-window method excluded, cross-policy newest-wins both directions, set B never removed, `sources` merge for A∩B, `violations` listing; `reduceActivation` over every table row and every `unrecognized` case in the spec + waiting states with `earliestChangeAt` (validAt or `lockProof.earliestMaturity`); `assertGuardExpectationsUnchanged` ignores timestamps/blocks and catches a changed writer; `buildTrustSurface` mapping/order; both batch builders (decode with `ACTIVATION_INTERFACES`, exact order/targets/selectors/args, `includeAcceptOwnership` omission); `buildStagingTransaction` per action; `canonicalJson` rules (sorted keys, throws on BigNumber/undefined/float); manifest validate/tamper (flip a lock proof entry → digest mismatch); `installSafeArtifactPair` unchanged/installed/archived-with-suffix/one-file-present-throws in a temp dir; `assertSafeArtifactPairConsistent`.
- [ ] **Step 2: Run** `yarn test:method-scoped-activation` — FAIL.
- [ ] **Step 3: Implement** — reducer is table-driven: compute the set of violated invariant names, then derive phase/next action/waiting from which hold, keyed on `snapshot.network`.
- [ ] **Step 4: GREEN** — test file, `yarn typecheck:dispute-deployment`, prettier on the three modules + test.
- [ ] **Step 5: Commit** `feat(deploy): method-scoped activation logic and batch manifest`.

---

### Task 3: Lane 38 — pinned chain reads, staging executor, skip/flags; block-tag propagation in reused helpers

**Files:**
- Create: `deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts`
- Modify: `deployments/canonicalDeployment.ts` (add optional trailing `blockTag?: string | number` to `assertDeploymentMatchesChain` and `assertCanonicalDeployment`, threaded into `getCode`), `deployments/predecessorDisputeStack.ts` (add optional trailing `blockTag` to `assertHistoricalDisputeStack`, threaded into `getCode`; **values untouched**), `deploy/deploy_summary.ts` (tags), `tsconfig.dispute-deployment.json`, `scripts/test-method-scoped-activation.cjs`

**Interfaces (Produces, exported from the lane):** `SUPPORTED_NETWORKS`, `TAG`, `FLAGS = { stagingPrepare, stagingExecute, baseRotationPrepare, baseCutoverPrepare, baseReleaseMatured, confirmActivation(network), confirmDownstreamReady(network), releaseReadySha }` (exact env names from the spec), `readActivationSnapshot(hre, network, blockTag): Promise<ActivationSnapshot>` (single reader; internally `enumeratePredecessorIntents` — topic-filtered ≤10 000-block pages from the predecessor record's `receipt.blockNumber`, then per-hash `getDisputeProtectionIntent` + `locks` at `blockTag` — and `readInventoryInputs` — `depositCounter`, `getDeposit`, `getDepositPaymentMethods` per id at `blockTag`, both policies' `DisputeProtectionEnabledUpdated` pages filtered by the canonical escrow topic, successor getter per tuple at `blockTag`; **the predecessor's event is decoded with the predecessor deployment record's ABI** (`deployments/<network>/<METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS.contracts.DisputeProtectionPolicy.deploymentName ?? "DisputeProtectionPolicy">.json`), whose `DisputeProtectionEnabledUpdated(address indexed escrow, uint256 indexed depositId, bool)` is deposit-wide (3 args) and has a different topic hash from the current 4-arg tuple-scoped event — decoding with the compiled ABI would silently miss every predecessor opt-out; the successor's event uses the compiled ABI; `readFreshPolicyAuthorizedHooks` replays `LifecycleHookAuthorizationUpdated` on the fresh policy), `expectedActivationState(network): ExpectedActivationState` (from lane 37's `EXPECTED_LIVE`, `METHOD_SCOPED_PREDECESSOR_DISPUTE_STACKS`, `MULTI_SIG`, `DISPUTE_RISK_WINDOW`, `getRiskWindowPaymentMethods`, the lane-36/37 records), `assertActivationSharedState(hre, network, blockTag)`, `prepareOrExecuteStagingActivation(hre)`, `releaseMaturedPredecessorIntents(hre, network)`, `requireStableStagingNonce`, `activationConfirmation`, `default` with `skip`. Base entry points exist as stubs throwing `not implemented until Task 4`.

- [ ] **Step 1: Write failing lane-level tests** (fake HRE/provider that **throws on any untagged read** — a `getCode`/`call` stub that requires a `blockTag` argument): identity/tags/no deps/summary tags; `skip` matrix (unsupported network, localhost untagged → true, localhost tagged → throws `no predecessor stack on local networks`, live untagged with a flag set → throws before any chain read, live without flags → true); prepare/execute mutual exclusion; `CONFIRM_STAGING_*` ordering; `readActivationSnapshot` builds a normalized snapshot from stubs and never issues an untagged read; raw-log decoding tests for BOTH `DisputeProtectionEnabledUpdated` signatures (3-arg predecessor topic decoded via the record ABI into `paymentMethod: null`, 4-arg successor topic via the compiled ABI) and for `LifecycleHookAuthorizationUpdated` replay producing `authorizedHooks` (a third hook authorized then revoked is excluded; one still authorized is included); staging executor advance check accepts `propose-controller → waiting: controller-delay` and rejects a two-step jump; `releaseMaturedPredecessorIntents` encodes only `lockProof.releasable`; the three helper `blockTag` parameters are threaded (stub asserts the tag).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the helpers' optional `blockTag` and the lane's staging path (mirror lane 34's `prepareOrExecuteStagingActivation` semantics at `deploy/34…:1704-1785`, driven by `reduceActivation`), `assertActivationSharedState` per the spec's preflight list (with `paymentBindingCutoverReady(hre)` as the documented single latest-block read), and `skip`.
- [ ] **Step 4: GREEN** — `yarn test:method-scoped-activation`, `yarn typecheck:dispute-deployment`, `yarn test:method-scoped-deployment`, `yarn test:dispute-lifecycle-deployment`, `yarn test:v3-groups-deployment` (helpers changed), prettier.
- [ ] **Step 5: Commit** `feat(deploy): lane 38 staging activation path`.

---

### Task 4: Lane 38 — Base guard deployment, two batches, simulation, artifacts, verifier

**Files:**
- Modify: `deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts`
- Create: `scripts/simulate-method-scoped-safe-batch.ts`, `scripts/verify-method-scoped-safe-batch.ts`
- Modify: `package.json` (`simulate:method-scoped-safe-batch`, `verify:method-scoped-safe-batch`), `tsconfig.dispute-deployment.json`, `scripts/test-method-scoped-activation.cjs`

**Interfaces:**
- Lane: `prepareBaseRotationBatch(hre)`, `prepareBaseCutoverBatch(hre)`, `deployActivationContract(hre, artifactName, constructorArgs): Promise<ContractIdentity>` (deployer EOA; waits for the receipt; records `deployTransactionHash`, `contractAddress`, `runtimeCodeHash`), `runPinnedSimulation(manifest, forkRpcUrl)` (child process exactly like `deploy/34…:1873-1915`, payload env `METHOD_SCOPED_SAFE_SIMULATION_PAYLOAD`). Chronology per spec: proof block **P** (`readActivationSnapshot` at P; lock proof + inventory inside it) → build trust surface + expectations → deploy guard, then postcondition → capture simulation block **S** (latest after both receipts) → `readActivationSnapshot` at S and `assertGuardExpectationsUnchanged(P, S)` → manifest (`proofBlock` = P, `simulationBlock*` = S) → `verifyActivationCandidate` in `generation` mode on the in-memory pair → simulate → `installSafeArtifactPair` (superseded suffix `<S>_<manifestSha256.slice(0,12)>`).
- Simulate script exports: `simulateMethodScopedSafeBatch(hre: HardhatRuntimeEnvironment, manifest: ActivationBatchManifest, forkRpcUrl: string): Promise<void>` — `hardhat_reset` to `simulationBlockNumber`, assert block hash, Safe/MultiSend runtime hashes + `VERSION() == "1.3.0"`, live `Safe.nonce()` == manifest, `getCode(guard.address)`/`getCode(postcondition.address)` hashes == manifest, append `postcondition.assertPostconditions()`, `simulateAndRevert`, require success. CLI: payload env (lane child) or `--batch <path> --sidecar <path>`.
- Verify script exports: `verifyActivationCandidate(hre, input: { kind; batch: unknown; manifest: unknown; mode: "generation" | "artifact-child"; repositoryRoot: string; forkRpcUrl: string; artifactPaths: { batch: string; sidecar: string } })` (the core; in `generation` mode the pair is in memory and git state must be clean with `HEAD == sourceSha`; in `artifact-child` mode the pair is read from `artifactPaths` after `assertSafeArtifactPairConsistent`, and `sourceSha` must be an ancestor of `HEAD` with only that kind's pair (plus its superseded copies) changed since) and `verifyMethodScopedSafeArtifacts(hre, kind, mode, repositoryRoot, forkRpcUrl)` (file-mode wrapper). Core checks per spec: manifest schema + digests; meta strings; `Safe.nonce()` at a fresh block F == manifest; **independent identity proof** for guard and postcondition (fetch `deployTransactionHash`, receipt status 1 and `contractAddress == address`, `tx.data == artifact.bytecode ‖ abi.encode(constructorArgs derived from manifest.trustSurface / lockProof.intents / inventory.tuples / expectations — not from manifest.guard.constructorArgs)`, `getCode(address, F)` hash == `artifact.deployedBytecode` hash modulo immutables (none expected) == manifest); `readActivationSnapshot(hre, "base", F)` then `assertGuardExpectationsUnchanged(kind, manifest.proofSnapshot, F snapshot)` (which for cutover covers `lockProof.intents` and `inventory.tuples`, and for both kinds covers `freshPolicy.authorizedHooks`, so a third authorized hook fails here); re-run the pinned simulation. `assertActivationArtifactGitState(root, sourceSha, mode, allowedPaths)` — a parameterized copy of the lane-34 helper (`scripts/verify-dispute-opt-in-safe-batch.ts:37-80`) taking the allowed path list.
- CLI: `--batch rotation|cutover [--mode generation|artifact-child]`.

- [ ] **Step 1: Write failing tests**: rotation batch with/without `acceptOwnership`; cutover batch; chronology (`assertGuardExpectationsUnchanged` P vs S with a fake provider that returns different writers at S → throws); manifest from the lane validates and digest covers guard/postcondition/trustSurface/lockProof/inventory; simulate script refuses a wrong guard runtime hash and decodes the envelope (fake provider); verifier core failure modes with stubs: nonce drift, guard initcode drift, postcondition identity drift, receipt `contractAddress` mismatch, re-derived inventory drift (added method on an existing deposit; late predecessor opt-out), lock-proof drift, a third authorized hook at F, sidecar digest mismatch, simulation revert, artifact-child ancestry/allowlist (a diff touching lane-34 paths fails); generation mode requires clean git + `HEAD == sourceSha`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Import discipline as lane 34: the lane imports script constants; scripts `require` the lane lazily inside functions.
- [ ] **Step 4: GREEN** — `yarn test:method-scoped-activation`, `yarn typecheck:dispute-deployment`, prettier, `git diff --check`.
- [ ] **Step 5: Commit** `feat(deploy): lane 38 Base rotation and cutover batches`.

---

### Task 5: Rehearsal, runner-level test, CI wiring, docs, final gates

**Files:**
- Create: `scripts/test-method-scoped-activation-rehearsal.cjs`, `scripts/test-method-scoped-runner.cjs`
- Modify: `deployments/immutableDeploymentLanes.ts` (**only** add an optional trailing `lanes = IMMUTABLE_DEPLOYMENT_LANES` parameter to `selectActiveDeploymentScripts` and `assertSupportedDeploymentTag`; entries untouched), `scripts/deployActive.ts` (thread an optional `lanes` through `runActiveDeployment` options), `package.json` (`test:method-scoped-activation` runs the three files), `.github/workflows/release-readiness.yml` (add `corepack yarn test:method-scoped-activation` after `test:method-scoped-deployment`), `tsconfig.dispute-deployment.json`, `AGENTS.md`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-08-27-method-scoped-policy-successor-lanes-design.md` (pointer)

- [ ] **Step 1: Rehearsal test** (in-process Hardhat like `scripts/test-v3-groups-base-deployment.cjs`): deploy in JS the Task 1 fixture using `OrchestratorV3SurfaceMock` for the orchestrator; wire as in Task 1 (`initializeController(predecessor)`, writer permission, hook authorizations, windows, ownership to a `safe` signer = a funded Hardhat account); open one intent through the predecessor policy from an impersonated predecessor hook and settle it. With a fake HRE bound to the in-process provider and `evm_snapshot`/`evm_revert` between stages:
  (a) **staging path** (governance = deployer signer): steps 1–2 execute; the executor reports `waiting: controller-delay`; `evm_increaseTime` past the delay — with the settled lock still unmatured the reducer reports `waiting: predecessor-drain` and refuses step 4; increase time past maturity → step 3 (release) then 4–7 complete with final `active`.
  (b) **Base path** from a fresh snapshot (governance = `safe` signer; the lane's `deployActivationContract` runs from the deployer signer): build the rotation batch (`includeAcceptOwnership` true: fresh policy left `owner == deployer, pendingOwner == safe`), deploy guard + rotation postcondition, then **execute the batch's transactions sequentially from the `safe` signer** (guard first) **inside one block** — `evm_setAutomine(false)`, send guard + batch transactions + a `rotationPostcondition.assertPostconditions()` call, `evm_mine` once, then re-enable automine — so the normative `pendingControllerValidAt >= block.timestamp + delay` holds exactly as it does in the fork simulation; assert the postcondition call succeeded; advance time and drain; build the cutover batch + guard + postcondition; prove `cutoverGuard.assertReady()` reverts after creating a new deposit (counter change) and, from another snapshot, after unpausing the predecessor, opening a live lock, and re-pausing; then execute sequentially and assert the cutover postcondition. Atomic `MultiSendCallOnly` execution is not rehearsed here (a plain call into MultiSend would make the inner calls originate from MultiSend, not the Safe); it is covered by the pinned fork simulation path, whose envelope decoding is unit-tested in Task 4.
- [ ] **Step 2: Runner-level test**: `selectActiveDeploymentScripts(root, filenames, lanesFixture)` with a fixture that marks lane 37 `retired: true, activeSource: null` and lane 38 `retired: false` proves lane 38 mounts and lane 37 does not; `assertSupportedDeploymentTag("37_…", lanesFixture)` throws and `("38_…")` passes; `runActiveDeployment` with a stubbed spawn and the fixture shows the mounted set. Lane-38 flag rejection is asserted by calling the lane's `skip` and default entry directly (the runner does not know about lane flags).
- [ ] **Step 3: Run** `yarn test:method-scoped-activation` (three files), `yarn test:method-scoped-deployment`, `yarn test:dispute-lifecycle-deployment`, `yarn test:v3-groups-deployment`, `yarn typecheck:dispute-deployment`, `forge test --match-path 'test-foundry/deterministic/mocks/DisputeMethodScopedActivation.t.sol'` — all GREEN.
- [ ] **Step 4: Docs** — AGENTS.md lane-38 bullet (tag-only execution, flags, two guarded batches, pause-before-rotate, retire-37-first, pin-38-after-first-transition, verifier mandatory immediately before execution, scripts never sign); README lane section (commands, artifacts, verifier); CLAUDE.md lane list (`38`: activation lane); pointer in the successor-lanes spec's follow-ups.
- [ ] **Step 5: Localhost gate** — fresh `yarn chain` + `yarn deploy:localhost` ends with lane 38 skipping; tagged lane-38 run on localhost throws the "no predecessor stack" error. Then full `yarn test`.
- [ ] **Step 6: Commit** `feat(deploy): lane 38 rehearsal, runner test, docs`; push `kartik/dispute-activation-lane`; open the PR with `create-pr`.
