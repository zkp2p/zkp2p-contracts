# Rail-Aware Default Dispute Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository every non-UI code step is written by Codex via the `/codex` skill; Claude orchestrates, reviews, and runs the verification commands.
>
> **Review:** Internal self-review ✅ | Codex convergence ✅ (2 rounds)

**Goal:** Make stake-backed dispute protection default-on for every `(deposit, paymentMethod)` tuple whose payment method has a nonzero risk window, with a depositor opt-out, while keeping the PR #278 ABI byte-for-byte and letting lane 37 tolerate pre-activation opt-outs and post-preparation staking.

**Architecture:** `DisputeProtectionPolicy` stores a per-tuple *disabled* flag; the effective getter is `!disabled && riskWindow != 0`; the hook keeps selecting the route from that getter. Lane 37's fresh-stack scan is split into allowed configuration/collateral events and forbidden lifecycle/lock events, phase-gated on `StakeVault.controller`. No new lane, artifact, output, evidence, or manifest change.

**Tech Stack:** Solidity 0.8.18, Foundry (only contract test system), TypeScript Hardhat Deploy lane, Node `node:test` deployment regressions.

**Spec:** `docs/superpowers/specs/2026-08-27-rail-aware-default-dispute-protection-design.md`

## Global Constraints

- ABI of `setDisputeProtectionEnabled(address,uint256,bytes32,bool)`, `isDisputeProtectionEnabled(address,uint256,bytes32)`, `DisputeProtectionEnabledUpdated(address,uint256,bytes32,bool)`, and `DisputeProtectionNotEnabled(address,uint256,bytes32)` is unchanged.
- No change to `StakeVault`, `DisputeVerifier`, the dispute nullifier registry, `IntentLifecycleHookV1` logic, or `WhitelistPolicy`.
- No new deployment lane; do not touch `deploy/29*`, `deploy/30*`, `deploy/32*`, `deploy/34*`, `deployments/*/*.json`, `deployments/outputs`, `dispute-stack-evidence.json`, `active-dispute-stack.json`.
- Before editing lane 37, confirm `ls deployments/base deployments/base_staging | grep MethodScoped` prints nothing (lane 37 has not executed on a live network).
- Solidity style: four-space indent, explicit visibility, custom errors, NatSpec on external functions; `forge fmt --check` on touched `.sol` files.
- Foundry commands: `forge test --match-path '<file>'` for iteration; one `yarn test` at the end. No `yarn coverage` locally.
- Commits: conventional prefix, one logical change each. Every commit message on this branch ends with exactly these two trailer lines:

  ```text
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
  ```

  Stage by explicit path, then verify with `git diff --cached --stat` and `git status --short` before committing; run `git diff --check` before every commit.

---

### Task 1: Policy semantics — opt-out storage, rail-aware getter, NatSpec, unit tests

**Files:**
- Modify: `contracts/hooks/DisputeProtectionPolicy.sol` (title NatSpec L13-31, storage L56-57, setter L246-264, getter L346-360, `_validateIntentAdmission` L392-398)
- Modify: `contracts/interfaces/IDisputeProtectionPolicy.sol:145-155` (getter NatSpec)
- Modify: `contracts/hooks/IntentLifecycleHookV1.sol:11-17` (header NatSpec)
- Test: `test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol`

**Interfaces:**
- Consumes: existing `DisputeProtectionEscrowMock(address depositor, IERC20 token)` test mock (L21-32 of the test), fixture constants `METHOD`, `OTHER_METHOD = keccak256("zelle")`, `RISK_WINDOW = 30 days`, `INTENT`, `INTENT_AMOUNT`, `escrow`, `depositId`, `depositor`, `taker`, `other`, `token`, `vault`.
- Produces: storage `isDisputeProtectionDisabledByPaymentMethod` (internal), unchanged external surface with new semantics: `isDisputeProtectionEnabled == !disabled && getRiskWindow(method) != 0`.

- [ ] **Step 1: Rewrite the default/round-trip tests to the rail-aware rule (RED)**

Replace `test_isDisputeProtectionEnabledDefaultsFalseForUntouchedAndMissingDeposits` (L481-485) with:

```solidity
function test_isDisputeProtectionEnabledDefaultsToRailRiskWindow() public view {
    // METHOD has RISK_WINDOW from setUp; OTHER_METHOD has none.
    assertTrue(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, OTHER_METHOD));
    // The getter validates nothing: a nonexistent deposit reads the rail default too.
    assertTrue(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), type(uint256).max, METHOD));
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), type(uint256).max, OTHER_METHOD));
}
```

In `test_SetDisputeProtectionEnabledEnforcesDepositorHandlesMissingDepositAndRoundTrips` (L487-514) change the round-trip block to opt out first, then re-enable, and add the windowless-rail case:

```solidity
    vm.expectEmit(true, true, true, true);
    emit DisputeProtectionEnabledUpdated(address(escrow), depositId, METHOD, false);
    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));

    vm.expectEmit(true, true, true, true);
    emit DisputeProtectionEnabledUpdated(address(escrow), depositId, METHOD, true);
    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, true);
    assertTrue(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));

    // The event carries the requested setting; the effective state still follows the risk window.
    vm.expectEmit(true, true, true, true);
    emit DisputeProtectionEnabledUpdated(address(escrow), depositId, OTHER_METHOD, true);
    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, OTHER_METHOD, true);
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, OTHER_METHOD));
```

Add:

```solidity
function test_SetRiskWindowFlipsEffectiveStateExceptForOptedOutTuples() public {
    disputeProtectionPolicy.setRiskWindow(OTHER_METHOD, RISK_WINDOW);
    assertTrue(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, OTHER_METHOD));

    disputeProtectionPolicy.setRiskWindow(METHOD, 0);
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
    disputeProtectionPolicy.setRiskWindow(METHOD, RISK_WINDOW);
    assertTrue(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));

    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    disputeProtectionPolicy.setRiskWindow(METHOD, 7 days);
    assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
}
```

- [ ] **Step 2: Rewrite the admission tests (RED)**

Rename `test_onIntentSignaledRequiresExplicitOptInAndSnapshotsConfiguration` (L85) to `test_onIntentSignaledAdmitsByDefaultRejectsOptedOutAndSnapshotsConfiguration`. Edit its body precisely: **replace L86-96** (the untouched-revert expectation, the `_enableProtection()` call, the admission call, and the `setRiskWindow(METHOD, 7 days)` / `getRiskWindow` pair) with the block below; **retain L98-108 unchanged** (the `getDisputeProtectionIntent` assertions on `taker`, `stakeOwner`, `depositor`, `riskWindow`, `releaseAmount`, `status`); **replace L109-112** (the existing `vault.locks(INTENT)` destructuring and its three assertions) with the "window changes" block below so the lock variables are declared exactly once.

Replacement for L86-96:

```solidity
    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
    vm.expectRevert(
        abi.encodeWithSelector(
            IDisputeProtectionPolicy.DisputeProtectionNotEnabled.selector, address(escrow), depositId, METHOD
        )
    );
    disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

    vm.prank(depositor);
    disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, true);
    disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
```

Replacement for L109-112 (after the retained L98-108):

```solidity
    // Window changes after admission never touch the snapshot or the lock.
    disputeProtectionPolicy.setRiskWindow(METHOD, 0);
    assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).riskWindow, RISK_WINDOW);
    disputeProtectionPolicy.setRiskWindow(METHOD, 7 days);
    assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).riskWindow, RISK_WINDOW);
    (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
    assertEq(stakeOwner, taker);
    assertEq(amount, INTENT_AMOUNT);
    assertEq(maturesAt, type(uint64).max);
```

In `test_onIntentSignaledRejectsUnauthorizedPausedDisabledAndDuplicate` (L130-150) the "disabled" branch must opt out before expecting `DisputeProtectionNotEnabled`, then opt back in before the duplicate check. Delete the `_enableProtection()` helper (L536-539) and its nine call sites (eight direct calls in tests plus the one inside `_admitAndSettle`, L542): default-on makes them no-ops. The existing wrong-token test at L167 already proves the default path once its opt-in call is removed — do not add a duplicate token-mismatch test.

Add a settled-intent snapshot test:

```solidity
function test_SettledIntentKeepsSnapshottedWindowAcrossRiskWindowChanges() public {
    _admitAndSettle(INTENT, INTENT_AMOUNT, false);
    uint64 releaseEligibleAt = disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).releaseEligibleAt;
    disputeProtectionPolicy.setRiskWindow(METHOD, 0);
    assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).releaseEligibleAt, releaseEligibleAt);
    assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).riskWindow, RISK_WINDOW);
    disputeProtectionPolicy.setRiskWindow(METHOD, 90 days);
    assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).releaseEligibleAt, releaseEligibleAt);
}
```

Rename the existing wrong-token test at L167 so its name states the default path (e.g. `test_onIntentSignaledRejectsNonStakeTokenDepositByDefault`) after removing its opt-in call; its existing `IntentTokenMismatch` expectation is the required coverage.

- [ ] **Step 3: Run the policy suite and confirm the new/changed tests fail for the expected reasons**

Run: `forge test --match-path 'test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol' -vv`
Expected: FAIL — `assertTrue` on the untouched METHOD default, the opted-out `DisputeProtectionNotEnabled` cases pass only because current code is opt-in, and the default admission call reverts `DisputeProtectionNotEnabled`.

- [ ] **Step 4: Implement the contract change**

`contracts/hooks/DisputeProtectionPolicy.sol`:

```solidity
    /// @dev Whether the depositor opted a deposit payment method out of default dispute protection.
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) internal isDisputeProtectionDisabledByPaymentMethod;
```

Setter body:

```solidity
        isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod] = !_isEnabled;
        emit DisputeProtectionEnabledUpdated(_escrow, _depositId, _paymentMethod, _isEnabled);
```

Getter body:

```solidity
        return !isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]
            && paymentMethodRiskWindow[_paymentMethod] != 0;
```

`_validateIntentAdmission` check:

```solidity
        if (isDisputeProtectionDisabledByPaymentMethod[_escrow][_depositId][_paymentMethod]) {
            revert DisputeProtectionNotEnabled(_escrow, _depositId, _paymentMethod);
        }
```

NatSpec (exact replacements):
- Contract title (L16): `@notice Deposit-and-payment-method-scoped, stake-backed dispute protection that is on by default for every payment method with a nonzero risk window and can be opted out per deposit payment method by the depositor.`
- Setter `@dev` (L250-252): `Protection is enabled by default on every payment method with a nonzero risk window; passing false opts the tuple out and true undoes the opt-out. The requested value is emitted as-is; the effective state also depends on the payment method's current risk window. OrchestratorV3 validates Escrow registration before signaling an intent; this policy only verifies that the caller is the deposit's current depositor.`
- Setter `@param _isEnabled`: `Whether non-whitelisted takers may use stake-backed dispute protection on this payment method; false opts out.`
- Getter `@notice`/`@dev` (L346-352) and the interface copy (`IDisputeProtectionPolicy.sol` L145-150): `@notice Returns the effective stake-backed dispute protection state for a deposit payment method.` / `@dev True when the depositor has not opted the tuple out and the payment method has a nonzero risk window. Performs no validation: any escrow, any deposit id (including nonexistent ones), and any payment method with a nonzero window read true.`
- `setRiskWindow` NatSpec (`DisputeProtectionPolicy.sol` ~L268-276): replace the sentence that says a zero window "lets the lifecycle hook pass the payment method through" with `A zero window means the payment method is never routed through dispute protection: the lifecycle hook then applies the deposit's whitelist (rejecting non-members when it is enabled) or admits openly when it is disabled. Changing the window affects future admissions only; admitted intents keep their snapshotted window.`
- `setAdmissionsPaused` NatSpec (~L285-300): replace "opted-in deposit" with "non-opted-out deposit payment method with a nonzero risk window" and "deposits that remain disabled" with "explicitly opted-out deposit payment methods and zero-window payment methods, which never reach this policy and stay gated by the whitelist or open".
- `IDisputeProtectionPolicy.onIntentSignaled` NatSpec (interface ~L106-115): where it calls a zero-window result an "unrestricted pass-through", add `for this direct policy callback; the canonical lifecycle hook never calls this function for a zero-window payment method and applies the whitelist instead`.
- Stale-language scan before committing: `rg -n "opt-in|opts in|opted-in|explicitly enables|explicit opt|until the depositor" contracts/hooks/DisputeProtectionPolicy.sol contracts/hooks/IntentLifecycleHookV1.sol contracts/interfaces/IDisputeProtectionPolicy.sol` must return nothing that describes the old default.
- `IntentLifecycleHookV1.sol` header (L13-17): replace the two sentences with `@notice Lifecycle hook combining tuple-scoped whitelist admission with default-on, opt-out stake-backed dispute protection. Whitelisted takers bypass staking. Non-whitelisted takers use stake-backed admission on payment methods with a nonzero risk window unless the depositor opted the deposit payment method out; otherwise an enabled whitelist rejects them while a whitelist-disabled deposit stays open. A payment method with a zero risk window is never routed through dispute protection, so its whitelist remains the only gate.` and delete the "Non-disputable payment methods give every taker direct access …" sentence.

- [ ] **Step 5: Run the policy suite (GREEN)**

Run: `forge test --match-path 'test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol'`
Expected: PASS, all tests.
Run: `forge fmt --check contracts/hooks/DisputeProtectionPolicy.sol contracts/hooks/IntentLifecycleHookV1.sol contracts/interfaces/IDisputeProtectionPolicy.sol test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git diff --check
git add contracts/hooks/DisputeProtectionPolicy.sol contracts/hooks/IntentLifecycleHookV1.sol contracts/interfaces/IDisputeProtectionPolicy.sol test-foundry/deterministic/hooks/DisputeProtectionPolicy.t.sol
git diff --cached --stat && git status --short
git commit -F - <<'EOF'
feat(dispute): default protection on for windowed rails

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
EOF
```

---

### Task 2: Hook/orchestrator integration tests for the new default

**Files:**
- Test: `test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol`
- Test: `test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol:120-185` (rotation test that opts in and sets a window)
- Test: `test-foundry/deterministic/integration/IntentLifecycleHookV1OrchestratorV3.t.sol` (fixture sets no risk window → verify it stays green unchanged)

**Interfaces:**
- Consumes: fixture helpers `_setWhitelist(bool enabled, bool includeTaker)`, `_setDisputeProtection(bool)`, `_signalDefault()`, `_signal(address, params)`, `_signalCall(address, params)`, `_paramsFor(address)`, `_defaultParams()`, `_addPaymentMethod(bytes32)`, `_stake(address, uint256)`, `_fulfill(...)`, `_intentHash(uint256)`; constants `METHOD` (window `RISK_WINDOW`), `OTHER_METHOD` (no window until set), `WINDOWLESS_METHOD`, `INTENT_AMOUNT`, `STAKE_AMOUNT`; `setUp` stakes `taker` only, so `other` has no stake.
- Produces: nothing new; behavior locked in tests.

- [ ] **Step 1: Rewrite the changed rows (RED)**

`DisputeLifecycleHookOrchestratorV3.t.sol` — apply exactly:

1. `test_WhitelistOnNonMemberUntouchedRejectsBeforeEscrowLock` (L71) → rename `test_WhitelistOnNonMemberUntouchedRequiresStakeBeforeEscrowLock`; the non-member is `other` (no stake), expected revert becomes `IStakeVault.InsufficientFreeStake(other, 0, INTENT_AMOUNT)` from `_signalCall(other, _paramsFor(other))`; keep the counter/remaining assertions and assert both `vault.lockedStake(other) == 0` and `vault.lockedStake(taker) == 0`.
2. `test_WhitelistOnNonMemberOptedInRejectsInsufficientStakeViaVault` (L88) and `test_WhitelistOnNonMemberOptedInLocksStakeBeforeEscrowLock` (L103): remove `_setDisputeProtection(true)` and rename `OptedIn` → `Untouched`.
3. `test_WhitelistOnNonMemberOptedInWindowlessMethodGetsDirectAccess` (L117) → rename `test_WhitelistOnNonMemberWindowlessMethodRejectsEvenWhenOptedIn`; keep the explicit `_setDisputeProtection(true)` on `METHOD` and additionally opt in `WINDOWLESS_METHOD` via `vm.prank(depositor); disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, WINDOWLESS_METHOD, true);` then expect `IntentLifecycleHookV1.TakerNotWhitelisted(address(escrow), depositId, WINDOWLESS_METHOD, other)` from `_signalCall(other, params)`; delete the fulfill tail.
4. `test_WhitelistOnNonMemberOptedOutRejects` (L141): unchanged (still the spec's opt-out row).
5. `test_WhitelistOffUntouchedIsOpenForEveryTaker` (L152) → rename `test_WhitelistOffUntouchedRequiresStakeFromEveryTaker`: `taker` (staked) gets `PENDING` and `vault.lockedStake(taker) == INTENT_AMOUNT`; `other` (unstaked) reverts `InsufficientFreeStake(other, 0, INTENT_AMOUNT)`.
6. `test_DisputeProtectionOptInIsScopedToPaymentMethod` (L168) → rename `test_DisputeProtectionOptOutIsScopedToPaymentMethod`: `_addPaymentMethod(OTHER_METHOD)`, set its window, opt out `METHOD` only; signal on `OTHER_METHOD` → `PENDING` (this locks `INTENT_AMOUNT` of `taker`'s stake); record `uint256 lockedAfterFirst = vault.lockedStake(taker);` then signal on `METHOD` → `NONE` and `assertEq(vault.lockedStake(taker), lockedAfterFirst)` (the opted-out signal adds no lock).
7. `test_WhitelistOffOptedInWindowlessMethodIsOpen` (L193): remove `_setDisputeProtection(true)`, rename `test_WhitelistOffWindowlessMethodIsOpenAndWindowedMethodRequiresStake`; keep both assertions.
8. `test_WhitelistOffUntouchedCreatesNoDisputeProtectionIntent` (L213) → rename `test_WhitelistOffOptedOutCreatesNoDisputeProtectionIntent`, add `_setDisputeProtection(false)` first.
9. `test_PolicyAdmissionRevertBubblesRawAndRollsBackSignal` (L312): remove `_setDisputeProtection(true)`.
10. `test_CancellationWithoutDisputeProtectionIntentLeavesVaultUntouched` (L328): add `_setDisputeProtection(false)` first.
11. Every other test that calls `_setDisputeProtection(true)` on `METHOD` before signaling: remove the call (default-on) unless the test is about re-enabling after an opt-out.

Add:

```solidity
function test_OptedOutWhitelistOffStaysOpenWhilePaused() public {
    _setDisputeProtection(false);
    disputeProtectionPolicy.setAdmissionsPaused(true);

    bytes32 intentHash = _signal(other, _paramsFor(other));

    assertEq(
        uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
        uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
    );
    assertEq(vault.lockedStake(other), 0);
    assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
}

function test_PausedAdmissionsDoNotBlockWhitelistedOrWindowlessTakers() public {
    disputeProtectionPolicy.setAdmissionsPaused(true);
    _setWhitelist(true, true);
    bytes32 whitelistedIntent = _signalDefault();
    assertEq(vault.lockedStake(taker), 0);
    assertEq(escrow.getDepositIntent(depositId, whitelistedIntent).intentHash, whitelistedIntent);

    _addPaymentMethod(WINDOWLESS_METHOD);
    IOrchestratorV3.SignalIntentParams memory params = _paramsFor(other);
    params.paymentMethod = WINDOWLESS_METHOD;
    bytes32 windowlessIntent = _signal(other, params);
    assertEq(vault.lockedStake(other), 0);
    assertEq(escrow.getDepositIntent(depositId, windowlessIntent).intentHash, windowlessIntent);
}
```

(`_setWhitelist(true, true)` configures the whitelist on `METHOD` only; `WINDOWLESS_METHOD` has no whitelist, so `other` is admitted openly there.)

`WhitelistLifecycleHookOrchestratorV3.t.sol` L120-185: the rotation test opts in (L129) after setting the window (L178) — remove the explicit opt-in call only if the test still proves the same rotation behavior with the default; otherwise leave it (an explicit `true` is harmless). Run and decide.

- [ ] **Step 2: Run the two integration files and confirm the expected RED set**

Run: `forge test --match-path 'test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol' -vv`
Expected: with Task 1 already applied, the rewritten tests PASS and any leftover `_setDisputeProtection(true)`-dependent test still passes; the point of this step is to see every renamed test compile and run once. If Task 1 is not applied yet (executing out of order), expected FAIL on rows 1, 2, 5, 6.

- [ ] **Step 3: Run the whole deterministic integration directory (GREEN)**

Run: `forge test --match-path 'test-foundry/deterministic/integration/*.t.sol'`
Expected: PASS. If `IntentLifecycleHookV1OrchestratorV3.t.sol` fails, its fixture must have gained a risk window — it does not today (`rg -n setRiskWindow` returns only the dispute and whitelist files); do not add one.
Run: `forge fmt --check test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git diff --check
git add test-foundry/deterministic/integration/DisputeLifecycleHookOrchestratorV3.t.sol test-foundry/deterministic/integration/WhitelistLifecycleHookOrchestratorV3.t.sol
git diff --cached --stat && git status --short
git commit -F - <<'EOF'
test(dispute): lock in rail-aware default admission rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
EOF
```

---

### Task 3: Lane 37 fresh-stack rule — allowed vs forbidden activity, phase-gated on the controller

**Files:**
- Modify: `deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts` (`POLICY_ADMISSION_EVENTS` L151-158, `VAULT_ADMISSION_EVENTS` L160-173, `eventTopics` L355-365 (delete), `assertFreshStackUnused` L367-423, its call sites L669, L912, L1012, L1098, L1110, L1126, L1202)
- Test: `scripts/test-method-scoped-deployment.cjs`
- Docs: `docs/superpowers/specs/2026-08-27-method-scoped-policy-successor-lanes-design.md` (already amended)

**Interfaces:**
- Produces (exported from lane 37, pure, offline-testable):

```ts
export type FreshStackEvent = {
  name: string;               // ABI event name
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
};
export type FreshStackInput = {
  controllerInitialized: FreshStackEvent | null; // the vault's ControllerInitialized event, if any
  policyEvents: FreshStackEvent[];
  vaultEvents: FreshStackEvent[];
  totalStaked: BigNumberish;
  totalClaimable: BigNumberish;
};
export function classifyFreshStackActivity(input: FreshStackInput): void; // throws Error with a descriptive message, returns on OK
// Every event name must appear in exactly one list per contract; anything else decoded from a log is a hard failure.
export const ALLOWED_POLICY_CONFIGURATION_EVENTS = ["DisputeProtectionEnabledUpdated"] as const;
export const EXPECTED_POLICY_GOVERNANCE_EVENTS = ["RiskWindowUpdated","DisputeVerifierUpdated","LifecycleHookAuthorizationUpdated","AdmissionsPausedUpdated","OwnershipTransferStarted","OwnershipTransferred"] as const;
export const FORBIDDEN_POLICY_LIFECYCLE_EVENTS = ["DisputeProtectionIntentOpened","DisputeProtectionIntentCancelled","DisputeProtectionIntentSettled","DisputeProtectionIntentReleased","DisputeResolved"] as const;
export const ALLOWED_VAULT_COLLATERAL_EVENTS = ["StakeDeposited","StakeWithdrawn","TakerAuthorizationUpdated","StakeOwnerSelected"] as const;
export const EXPECTED_VAULT_GOVERNANCE_EVENTS = ["ControllerInitialized","ControllerProposed","ControllerAccepted","ControllerProposalCancelled","OwnershipTransferStarted","OwnershipTransferred"] as const;
export const FORBIDDEN_VAULT_LOCK_EVENTS = ["StakeLocked","LockFunded","StakeLockIncreased","StakeLockResized","StakeUnlocked","StakeLockResolved","ClaimCreated","ClaimWithdrawn"] as const;
// Pure log decoding, testable with fake logs: maps each raw log to a FreshStackEvent via the contract interface; throws on a topic the ABI cannot decode.
export function decodeFreshStackLogs(contractInterface: ethers.utils.Interface, logs: ethers.providers.Log[], label: string): FreshStackEvent[];
```

Add `import type { BigNumberish } from "ethers";` at the top of lane 37 (the file currently imports only `ethers` from Hardhat and the Hardhat Deploy types). The `ethers.utils.Interface` / `ethers.providers.Log` types come from the existing `import { ethers } from "hardhat"`.

- [ ] **Step 1: Write the failing classifier tests**

Append to `scripts/test-method-scoped-deployment.cjs` (same `node:test` style as the file; `lane37Module` is already required at the top):

```js
function freshEvent(name, blockNumber, logIndex, transactionHash = "0x" + "ab".repeat(32)) {
  return { name, blockNumber, transactionIndex: 0, logIndex, transactionHash };
}

test("fresh-stack classifier allows configuration and post-controller collateral activity", () => {
  const controllerInitialized = freshEvent("ControllerInitialized", 100, 0);
  assert.doesNotThrow(() =>
    lane37Module.classifyFreshStackActivity({
      controllerInitialized,
      policyEvents: [freshEvent("DisputeProtectionEnabledUpdated", 120, 0)],
      vaultEvents: [
        freshEvent("StakeDeposited", 130, 0),
        freshEvent("TakerAuthorizationUpdated", 131, 0),
        freshEvent("StakeOwnerSelected", 131, 1),
        freshEvent("StakeWithdrawn", 140, 0),
      ],
      totalStaked: 1_000_000,
      totalClaimable: 0,
    })
  );
});

test("fresh-stack classifier rejects stake before controller initialization by transaction hash", () => {
  const offending = "0x" + "cd".repeat(32);
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized: freshEvent("ControllerInitialized", 100, 0),
        policyEvents: [],
        vaultEvents: [freshEvent("StakeDeposited", 99, 3, offending)],
        totalStaked: 1,
        totalClaimable: 0,
      }),
    new RegExp(`before controller initialization.*${offending}`)
  );
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized: null,
        policyEvents: [],
        vaultEvents: [],
        totalStaked: 1,
        totalClaimable: 0,
      }),
    /totalStaked must be zero before controller initialization/
  );
});

test("fresh-stack classifier rejects lifecycle, lock, and claim activity in either phase", () => {
  for (const name of lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS) {
    assert.throws(
      () =>
        lane37Module.classifyFreshStackActivity({
          controllerInitialized: freshEvent("ControllerInitialized", 100, 0),
          policyEvents: [freshEvent(name, 150, 0)],
          vaultEvents: [],
          totalStaked: 0,
          totalClaimable: 0,
        }),
      new RegExp(name)
    );
  }
  for (const name of lane37Module.FORBIDDEN_VAULT_LOCK_EVENTS) {
    for (const controllerInitialized of [null, freshEvent("ControllerInitialized", 100, 0)]) {
      assert.throws(
        () =>
          lane37Module.classifyFreshStackActivity({
            controllerInitialized,
            policyEvents: [],
            vaultEvents: [freshEvent(name, 150, 0)],
            totalStaked: 0,
            totalClaimable: 0,
          }),
        new RegExp(name)
      );
    }
  }
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized: freshEvent("ControllerInitialized", 100, 0),
        policyEvents: [],
        vaultEvents: [],
        totalStaked: 0,
        totalClaimable: 5,
      }),
    /totalClaimable must be zero/
  );
});

test("fresh-stack event lists partition every policy and vault ABI event exactly once", () => {
  const artifactEvents = (name) =>
    JSON.parse(readFileSync(join(repositoryRoot, "artifacts", "contracts", ...ARTIFACT_PATHS[name]), "utf8"))
      .abi.filter((entry) => entry.type === "event").map((entry) => entry.name).sort();
  const ARTIFACT_PATHS = {
    DisputeProtectionPolicy: ["hooks", "DisputeProtectionPolicy.sol", "DisputeProtectionPolicy.json"],
    StakeVault: ["StakeVault.sol", "StakeVault.json"],
  };
  const policyLists = [
    lane37Module.ALLOWED_POLICY_CONFIGURATION_EVENTS,
    lane37Module.EXPECTED_POLICY_GOVERNANCE_EVENTS,
    lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS,
  ];
  const vaultLists = [
    lane37Module.ALLOWED_VAULT_COLLATERAL_EVENTS,
    lane37Module.EXPECTED_VAULT_GOVERNANCE_EVENTS,
    lane37Module.FORBIDDEN_VAULT_LOCK_EVENTS,
  ];
  for (const [artifact, lists] of [["DisputeProtectionPolicy", policyLists], ["StakeVault", vaultLists]]) {
    const classified = lists.flat();
    assert.equal(new Set(classified).size, classified.length, `${artifact} lists overlap`);
    assert.deepEqual([...classified].sort(), artifactEvents(artifact), `${artifact} ABI events are not all classified`);
  }
  assert.deepEqual([...lane37Module.ALLOWED_POLICY_CONFIGURATION_EVENTS], ["DisputeProtectionEnabledUpdated"]);
  assert.deepEqual([...lane37Module.FORBIDDEN_POLICY_LIFECYCLE_EVENTS], [
    "DisputeProtectionIntentOpened", "DisputeProtectionIntentCancelled", "DisputeProtectionIntentSettled",
    "DisputeProtectionIntentReleased", "DisputeResolved",
  ]);
  assert.deepEqual([...lane37Module.ALLOWED_VAULT_COLLATERAL_EVENTS], [
    "StakeDeposited", "StakeWithdrawn", "TakerAuthorizationUpdated", "StakeOwnerSelected",
  ]);
  assert.deepEqual([...lane37Module.FORBIDDEN_VAULT_LOCK_EVENTS], [
    "StakeLocked", "LockFunded", "StakeLockIncreased", "StakeLockResized",
    "StakeUnlocked", "StakeLockResolved", "ClaimCreated", "ClaimWithdrawn",
  ]);
});

test("fresh-stack classifier fails closed on an unclassified event and orders same-block events by index", () => {
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized: freshEvent("ControllerInitialized", 100, 0),
        policyEvents: [freshEvent("SomeFutureEvent", 101, 0)],
        vaultEvents: [],
        totalStaked: 0,
        totalClaimable: 0,
      }),
    /unclassified.*SomeFutureEvent/
  );
  // Same block: a deposit at a lower logIndex than ControllerInitialized is pre-controller; a higher one is allowed.
  const controllerInitialized = { ...freshEvent("ControllerInitialized", 100, 2), transactionIndex: 1 };
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized,
        policyEvents: [],
        vaultEvents: [{ ...freshEvent("StakeDeposited", 100, 1), transactionIndex: 1 }],
        totalStaked: 1,
        totalClaimable: 0,
      }),
    /before controller initialization/
  );
  assert.throws(
    () =>
      lane37Module.classifyFreshStackActivity({
        controllerInitialized,
        policyEvents: [],
        vaultEvents: [{ ...freshEvent("StakeDeposited", 100, 9), transactionIndex: 0 }],
        totalStaked: 1,
        totalClaimable: 0,
      }),
    /before controller initialization/
  );
  assert.doesNotThrow(() =>
    lane37Module.classifyFreshStackActivity({
      controllerInitialized,
      policyEvents: [],
      vaultEvents: [{ ...freshEvent("StakeDeposited", 100, 3), transactionIndex: 1 }],
      totalStaked: 1,
      totalClaimable: 0,
    })
  );
});

test("decodeFreshStackLogs maps raw logs to named events and rejects unknown topics", () => {
  const vaultInterface = new ethersLibrary.utils.Interface(
    JSON.parse(readFileSync(join(repositoryRoot, "artifacts", "contracts", "StakeVault.sol", "StakeVault.json"), "utf8")).abi
  );
  const depositTopic = vaultInterface.getEventTopic("StakeDeposited");
  const rawLog = (topic, blockNumber, transactionIndex, logIndex, transactionHash) => ({
    address: "0x" + "11".repeat(20), topics: [topic], data: "0x", blockNumber, transactionIndex, logIndex,
    transactionHash, blockHash: "0x" + "22".repeat(32), removed: false,
  });
  const decoded = lane37Module.decodeFreshStackLogs(
    vaultInterface,
    [rawLog(depositTopic, 7, 3, 5, "0x" + "ee".repeat(32))],
    "StakeVaultMethodScoped"
  );
  assert.deepEqual(decoded, [
    { name: "StakeDeposited", blockNumber: 7, transactionIndex: 3, logIndex: 5, transactionHash: "0x" + "ee".repeat(32) },
  ]);
  assert.throws(
    () => lane37Module.decodeFreshStackLogs(vaultInterface, [rawLog("0x" + "ff".repeat(32), 7, 0, 0, "0x" + "ee".repeat(32))], "StakeVaultMethodScoped"),
    /StakeVaultMethodScoped emitted a log this ABI cannot decode/
  );
});
```

(`readFileSync`, `join`, `repositoryRoot`, and `ethersLibrary` are already imported at the top of the file — see L15-33. Hardhat artifacts must be compiled; the existing suite already depends on them.)

- [ ] **Step 2: Run the file and confirm RED**

Run: `yarn test:method-scoped-deployment`
Expected: FAIL — `classifyFreshStackActivity is not a function`.

- [ ] **Step 3: Implement the classifier and rewire `assertFreshStackUnused`**

In lane 37, replace `POLICY_ADMISSION_EVENTS` / `VAULT_ADMISSION_EVENTS` with the four exported lists above and add:

```ts
function eventOrder(event: FreshStackEvent): [number, number, number] {
  return [event.blockNumber, event.transactionIndex, event.logIndex];
}

function isBefore(left: FreshStackEvent, right: FreshStackEvent): boolean {
  const [lb, lt, ll] = eventOrder(left);
  const [rb, rt, rl] = eventOrder(right);
  return lb !== rb ? lb < rb : lt !== rt ? lt < rt : ll < rl;
}

function includes(list: readonly string[], name: string): boolean {
  return list.includes(name);
}

export function classifyFreshStackActivity(input: FreshStackInput): void {
  for (const event of input.policyEvents) {
    if (includes(FORBIDDEN_POLICY_LIFECYCLE_EVENTS, event.name)) {
      throw new Error(`Fresh DisputeProtectionPolicyMethodScoped has lifecycle activity: ${event.name} in ${event.transactionHash}`);
    }
    if (!includes(ALLOWED_POLICY_CONFIGURATION_EVENTS, event.name) && !includes(EXPECTED_POLICY_GOVERNANCE_EVENTS, event.name)) {
      throw new Error(`DisputeProtectionPolicyMethodScoped emitted an unclassified event: ${event.name} in ${event.transactionHash}`);
    }
  }
  for (const event of input.vaultEvents) {
    if (includes(FORBIDDEN_VAULT_LOCK_EVENTS, event.name)) {
      throw new Error(`Fresh StakeVaultMethodScoped has lock or claim activity: ${event.name} in ${event.transactionHash}`);
    }
    if (includes(ALLOWED_VAULT_COLLATERAL_EVENTS, event.name)) {
      if (!input.controllerInitialized || isBefore(event, input.controllerInitialized)) {
        throw new Error(`StakeVaultMethodScoped received collateral activity before controller initialization (${event.name} in ${event.transactionHash}); the lane cannot initialize the controller and must be superseded`);
      }
    } else if (!includes(EXPECTED_VAULT_GOVERNANCE_EVENTS, event.name)) {
      throw new Error(`StakeVaultMethodScoped emitted an unclassified event: ${event.name} in ${event.transactionHash}`);
    }
  }
  if (!ethers.BigNumber.from(input.totalClaimable).isZero()) {
    throw new Error("StakeVaultMethodScoped totalClaimable must be zero before activation");
  }
  if (!input.controllerInitialized && !ethers.BigNumber.from(input.totalStaked).isZero()) {
    throw new Error("StakeVaultMethodScoped totalStaked must be zero before controller initialization");
  }
}

export function decodeFreshStackLogs(
  contractInterface: ethers.utils.Interface,
  logs: ethers.providers.Log[],
  label: string
): FreshStackEvent[] {
  return logs.map((log) => {
    let name: string;
    try {
      name = contractInterface.getEvent(log.topics[0]).name;
    } catch {
      throw new Error(`${label} emitted a log this ABI cannot decode: ${log.topics[0]} in ${log.transactionHash}`);
    }
    return {
      name,
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
    };
  });
}
```

Rewrite `assertFreshStackUnused(hre, deployments)` to build the input from chain: for each of the vault and the policy that exists, `ethers.provider.getLogs({ address, fromBlock: deploymentBlock(...), toBlock: latest })` with **no topic filter**, decode with `decodeFreshStackLogs(new ethers.utils.Interface((await hre.deployments.getExtendedArtifact("StakeVault" | "DisputeProtectionPolicy")).abi), logs, label)`, take the vault's `ControllerInitialized` event (there is at most one; if two decode, throw) as `controllerInitialized`, read `totalStaked` / `totalClaimable`, and call `classifyFreshStackActivity`. Delete the `eventTopics` helper (L355-365) and the `totalAccounted`, `unaccountedBalance`, and `balanceOf` checks. Keep every existing call site; `readLiveDeployOnlyPrefix` L669 now tolerates staking after `initialize-controller` because the classifier gates on the `ControllerInitialized` event rather than on emptiness.

- [ ] **Step 4: Run the deployment suites (GREEN)**

Run: `yarn typecheck:dispute-deployment && yarn test:method-scoped-deployment && yarn test:dispute-lifecycle-deployment && yarn test:v3-groups-deployment`
Expected: all PASS (the method-scoped file has 18 tests today and gains 6 in this task → 24).
Run: `npx prettier --check deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts scripts/test-method-scoped-deployment.cjs`
Expected: clean.

- [ ] **Step 5: Localhost integration gate**

This gate exercises the newly allowed behavior on a real chain, not just the classifier.

```bash
rm -rf deployments/localhost
yarn chain > /tmp/chain.log 2>&1 & CHAIN_PID=$!
trap 'kill $CHAIN_PID 2>/dev/null; rm -rf deployments/localhost; git checkout -- deployments/outputs/platforms/localhost.json' EXIT
for i in $(seq 1 60); do nc -z 127.0.0.1 8545 && break; sleep 1; done
yarn deploy:localhost                                   # expected: exit 0, summary lists the MethodScoped stack
```

Then, with the chain still up, mutate the passive stack exactly as a depositor and a taker would (localhost also activated it, but the classifier only cares about lifecycle/lock events, and none of these calls create one). Use a throwaway script under the scratchpad (not committed) driven by `yarn hardhat run --network localhost <script>` that:

1. reads `deployments/localhost/{DisputeProtectionPolicyMethodScoped,StakeVaultMethodScoped,EscrowV2,USDCMock}.json`;
2. as the first unnamed account (the deployer, which is also the `USDCMock` holder on localhost), calls `setDisputeProtectionEnabled(escrow, 0, keccak256("paypal"), false)` on the policy **if** deposit 0 exists with that depositor; otherwise skip this call and note it (the opt-out event is also covered by the classifier unit test);
3. approves and calls `depositStake(1_000_000)` on the vault, then `setTakerAuthorization(<second account>, true)` (use the exact function names from the `StakeVault` ABI — check `artifacts/contracts/StakeVault.sol/StakeVault.json` for the authorization and stake-owner selection setters before writing the script).

Re-run the tagged lane and assert it is still prepared with no redeploy:

```bash
yarn ts-node --transpile-only scripts/deployActive.ts localhost 37_deploy_method_scoped_dispute_lifecycle_stack   # expected: exit 0, no "deploying" lines
```

The `trap` stops the chain and restores the ignored/generated files on exit.

- [ ] **Step 6: Commit**

```bash
git diff --check
git add deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts scripts/test-method-scoped-deployment.cjs
git diff --cached --stat && git status --short
git commit -F - <<'EOF'
feat(deploy): tolerate opt-outs and staking on the fresh stack

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
EOF
```

---

### Task 4: Documentation and final gate

**Files:**
- Modify: `README.md` (lane-37 paragraph starting at L702, "`deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts` deploys …")
- Modify: `AGENTS.md` (the "Lanes `36` and `37` are the current, deploy-only successors" bullet)
- The successor-lanes spec already carries its amendment and pointer (L175-182); nothing further there.

- [ ] **Step 1: README lane-37 paragraph** — after "…leaves the active O3 hook and the dispute-registry writer set unchanged." add: `The method-scoped policy is on by default for every payment method with a nonzero risk window (paypal, venmo, cashapp) and can be opted out per deposit payment method by the depositor; depositor opt-outs and taker stake deposits are allowed on the passive stack once its vault controller is initialized, and only lifecycle, lock, or claim activity invalidates the deploy-only preparation.`

- [ ] **Step 2: AGENTS.md lanes 36/37 bullet** — append: `The lane-37 policy is default-on for windowed rails with a depositor opt-out (see the rail-aware default design); pre-activation opt-outs and post-preparation staking are expected and do not invalidate the lane.`

- [ ] **Step 3: Full Foundry suite**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git diff --check
git add README.md AGENTS.md
git add -f docs/superpowers/plans/2026-08-27-rail-aware-default-dispute-protection.md
git diff --cached --stat && git status --short
git commit -F - <<'EOF'
docs: describe rail-aware default dispute protection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tzc4JYcsy2feiByPEeQXrc
EOF
git fetch origin codex/deposit-platform-policy-scope
git status -sb | head -1            # must read "ahead N", never "behind"/"diverged"; if it does, stop and report
git log --oneline origin/codex/deposit-platform-policy-scope..HEAD
git push origin HEAD:codex/deposit-platform-policy-scope
```
