# Payment policies through the existing V3 verifier

- One `(paymentMethod, bytes32 policyId)` table selects the admitted risk window.
- `bytes32(0)` is ordinary/default evidence. Named policies use `keccak256(bytes(canonicalName))`.
- Example canonical names are `balance` and `goods-and-services`: exact lowercase UTF-8 names, scoped by payment method. Do not hash ABI-encoded strings or display labels.
- Example windows are ordinary/default 14 days, verified balance 0 days and verified G&S 90 days. These are illustrative configuration, not deployed rules or completed evidence classification.
- Positive windows lock full stake at admission. Zero records the same PENDING intent without collateral. Settlement starts a positive coverage clock. Admission snapshots the policy/window so later configuration changes cannot rewrite an order.
- Every managed order requires matching signed policy evidence. Unknown or disabled selections reject admission. Whitelisted/open orders are untracked and accept only ordinary policy zero.

## Verification through unchanged UPV3

```text
UPV3: validate payment/snapshot and signed data hash
  -> DPP.verify(digest, signatures, data)
       -> registered signature checker, exactly once
       -> decode and enforce the admitted policy
  -> consume payment in the existing NullifierRegistryV2
  -> return the existing result to the unchanged orchestrator
```

DPP implements the existing `IAttestationVerifier` interface. UPV3's existing `setAttestationVerifier` points to DPP; DPP delegates the signature to the registered original checker. UPV3 does not separately check it again. No UPV4, new callback interface, verifier source change, additional proof transaction or verification receipt is required.

Only registered UPVs may call DPP.verify: they validate the digest/data binding and intent snapshot before forwarding. DPP requires the exact 480-byte payload and matching policy. Tracked orders additionally require their registered verifier. UPV3 checks the signed method against the live intent before calling DPP. OrchestratorV3 rejects missing/closed intents; DPP settlement enforces PENDING and the original hook. These lifecycle checks are not repeated inside `verify`. An untracked order needs a valid ordinary attestation from an approved UPV; it does not need a DPP admission or hook-route record.

Admission and nonmanual settlement retain the registered method route, DPP checker and sole payment-registry writer checks. Settlement requires a consumed-payment binding. Switching V3's checker away from DPP therefore cannot settle a managed order; the entire fulfillment and payment consumption revert. Maker-authorized manual release and cancellation retain their existing explicit lifecycle paths when proof routing is unavailable.

## Configuration and state

- `setPolicy(method, id, window, enabled)` configures every rule, including default zero. Register zero first to enroll a method. Registration persists when rules are disabled; disabling a default does not reopen admission or disable enabled sibling rules. Windows are bounded to 365 days.
- Each `signalIntent` supplies its policy in the existing `data` field as described below. DPP has no saved-preference mapping or selection transaction.
- `registerPolicyRoute(hook, orchestrator, paymentVerifier, signatureVerifier)` pins the reviewed route and underlying signature checker. The checker must agree across routes sharing a UPV; recursive DPP/UPV signature targets reject. Routes cannot be overwritten.
- `signatureVerifierByPaymentVerifier` stores the checker used by DPP's signature delegation. No new UPV storage is needed.
- The existing six-slot protection record/getter remains. Full bytes32 policy ID and original hook add two metadata slots; a rule uses one slot and a route two. There is no separate bypass lifecycle, requiresStake flag, proof cache, duplicate escrow/deposit/amount or cached registry address.

The catalog replaces the method-only window mapping, changing DPP storage roots. This requires a fresh DPP deployment, not an in-place storage-compatible upgrade. Slot descriptions are not measured gas savings. Existing lifecycle-hook executable logic is unchanged; its comments and the DPP interface describe the policy semantics.

## Per-order signal data

OrchestratorV3 stores `SignalIntentParams.data` before calling the lifecycle hook. DPP reads it from the registered orchestrator: empty bytes select ordinary policy zero; otherwise `abi.decode(data, (bytes32))` reads the policy from the first word.

```solidity
params.data = abi.encode(policyId); // No post-hook input: exactly 32 bytes.
// When a post-hook needs its own input:
params.data = abi.encodePacked(policyId, postHookData);
```

- Nonempty data must contain a complete 32-byte policy ID. Short data fails ABI decoding; unknown or disabled IDs reject admission. Nonempty data is never silently treated as default because a marker is missing.
- **Managed-order post-hook integration must use the policy prefix.** V3 forwards the complete data unchanged; a compatible post-hook reads its input after the first 32 bytes. An existing hook that decodes an address from byte zero is not compatible with this layout. Migrate that consumer before routing its orders through this DPP. Empty/default orders with no post-hook input retain their existing call shape. Untracked/open/whitelisted orders do not go through DPP's admission decoder.
- There is no tag, version marker, alternate tagged decoder or automatic legacy post-hook adapter. This is the canonical layout for the unshipped policy feature. The integration test executes a prefix-aware post-hook for both default and named policies; it does not certify third-party hook compatibility.
- This creation-time selection is a request, not payment evidence. The 480-byte attestation below later authenticates the actual policy. The two data containers have different schemas.
- Every order chooses independently. There is no `policyChoices` mapping, saved-preference setter/getter, or preference-change transaction.
- Positive policies lock full collateral within `signalIntent`; insufficient collateral reverts the entire admission, including the orchestrator record and escrow reservation. Zero-window policies remain tracked without a lock.
- The original signal bytes remain in OrchestratorV3 until pruning. DPP stores the effective policy and coverage window separately because corrections may change them. Removing the preference mapping simplifies DPP; the additional signal bytes are not a measured gas saving.

## Policy correction and collateral

`adjustPolicy(intentHash, policyId)` lets only the buyer correct a tracked PENDING, unexpired order. It requires admissions to be unpaused, an enabled rule for the admitted method, and valid current deposit configuration. A missing, cancelled, settled or expired order cannot be adjusted.

The effective window becomes `max(previousWindow, selectedRule.riskWindow)`. If the order had zero coverage and now needs a positive window, DPP locks full collateral before changing any policy or coverage state. Insufficient free stake reverts atomically. Existing positive coverage keeps its original stake owner, full pending lock and depositor; changing policy does not unlock, shorten, or relock it. Repeated corrections, including refreshing the same ID after a rule update, cannot decrease coverage.

The effective evidence ID changes even when its rule has a shorter or zero window; the previously committed longer coverage still applies. `IntentPolicyAdjusted` emits the old/new IDs and resulting window. The original hook, original signal data and PENDING status remain. Fulfillment compares the attestation to the effective DPP ID, not the original signal bytes, and starts the retained window at settlement.

Before paying, a buyer can cancel and recreate an order with the correct policy. After paying, keep the order and correct it; cancellation does not reverse the off-chain payment. Recovery cannot retroactively provide upfront collateral, but settlement remains blocked until any newly required stake is locked. The client must fetch and disclose the effective retained window, which may exceed the newly selected rule's window. No UI is implemented in this contracts PR.

Zero-window orders skip collateral cancellation, settlement, dispute and release operations. Positive orders retain existing resizing, settlement-based maturity and dispute compensation. Manual release remains explicitly maker-authorized; positive collateral coverage remains.

## Signed data and service

```text
data = abi.encode(PaymentDetails, IntentSnapshot, bytes32 policyId)
     = 6 payment words + 8 snapshot words + 1 policy word = 480 bytes
dataHash = keccak256(data)
PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)
```

The service encodes the full bytes32 name hash; current buyer/seller issuers supply ZeroHash. The existing UPV3 address, EIP-712 name/version (`UnifiedPaymentVerifier` / `1`) and message type remain. DPP checks the appended signed word; unsigned metadata and client-supplied labels cannot grant eligibility. The encoder and server-owned address resolver need no further runtime change for runtime selection or correction: it already signs the policy ID, which must match DPP's effective ID. Creation-time data is a separate client encoding.

Balance/G&S classifiers and nonzero issuance remain unfinished. Ordinary zero does not certify F&F. Do not expose classified policies until evidence validation rejects funding/product mismatches, including G&S attempting ordinary evidence to evade the longer window.

## Rollout and review boundaries

1. Deploy the new DPP and required hook instances; register reviewed routes with the existing UPV3 and signature checker. Configure UPV3's existing checker setter to DPP during the coordinated cutover.
2. Reuse existing replay history and preserve sole-writer/method routing. Drain or explicitly migrate predecessor protected intents before changing their DPP, hook or vault-controller dependencies. Ordinary untracked whitelist orders remain compatible with the V3 checker path.
3. Ensure all issuers produce 480-byte data before enabling DPP verification; regenerate old 448-byte proofs. No new UPV deployment or service signing-address cutover is needed.
4. Historical deployed lanes/artifacts remain immutable. The known historical rehearsal still calls removed setRiskWindow APIs against current DPP artifacts; bind those consumers to matching historical artifacts before release readiness. Contract-only tests do not certify deployment tooling.

No contract/service deployment, package publication, merge or live rule configuration is performed by this PR. Tests cover one signature delegation, hashed policy matching, zero/positive collateral behavior, checker/route bypass attempts, old whitelist fulfillment, runtime selection, correction with monotonic coverage, policy-prefixed post-hook payloads, upstream rejection before DPP and payment replay. Provider evidence classification and production activation are separate work.
