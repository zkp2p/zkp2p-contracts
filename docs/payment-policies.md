# Payment policies through V3

Payment policies are keyed by `(paymentMethod, bytes32 policyId)`. Policy zero is ordinary evidence. Named policies use `keccak256(bytes(canonicalName))`, for example `balance` or `goods-and-services`, scoped by payment method. These names describe possible configurations; this PR does not implement or enable provider classification.

A positive risk window locks the full intent amount at admission; settlement starts its coverage clock. A zero window records the same pending lifecycle without collateral. Every managed order must later present matching signed policy evidence. Unknown or disabled rules reject. Whitelisted, opted-out, and unenrolled orders remain untracked and accept only ordinary evidence.

## Ownership and interfaces

- **OrchestratorV3** owns the intent, escrow validation, reservation and settlement accounting. `SignalIntentParams.lifecycleHookData` is ephemeral admission input. `data` remains opaque, persisted post-hook input. The stored `Intent` and fulfillment ABI are unchanged.
- **IntentLifecycleHookV1** authenticates the calling orchestrator, reads its intent once, decodes the selection and evaluates whitelist admission. It forwards a typed `AdmissionContext` with the canonical intent fields, originating orchestrator and whitelist result. One hook can serve multiple registered orchestrators.
- **DisputeProtectionPolicy (DPP)** owns rule availability, collateral requirements, effective selection and coverage snapshots. One `PolicyIntent` record, exposed by `getPolicyIntent`, contains the original hook and orchestrator. Cancellation and settlement must match both. DPP does not reconstruct caller context through concrete hook getters.
- **StakeVault** owns token custody and collateral accounting. **UPV3** owns payment/snapshot validation and consumption in the existing **NullifierRegistryV2**. The underlying signature checker owns signature verification.

Governance authorizes trusted, reviewed hooks and orchestrators. Typed context does not make an untrusted hook safe. Hooks must remain authorized, and orchestrators registered, until their pending intents reach a terminal callback.

## Admission data

```solidity
params.lifecycleHookData = abi.encode(policyId);
params.data = postHookData;
```

The lifecycle hook accepts empty bytes for ordinary policy zero or exactly one ABI-encoded bytes32. Truncated data and trailing bytes reject. Whitelisted or unmanaged admissions reject nonzero selections instead of silently dropping them. The whitelist-only hook accepts only empty lifecycle input; an orchestrator with no lifecycle hook also rejects nonempty input.

Post-hooks receive `data` byte-for-byte, without a policy prefix or adapter. Policy selection is a request at creation, not evidence about the payment. Each order chooses independently; there is no saved-preference mapping or separate selection transaction.

This changes the `signalIntent` selector and lifecycle admission callback. Callers must encode the new struct and hook implementations must implement `onIntentSignaled(bytes32,bytes)`. There is no legacy overload or alternate prefix decoder.

## Configuration and state

`setPolicy(method, id, window, enabled)` configures rules for future admissions. Register zero first to enroll a method. Registration persists when rules are disabled, so disabling a rule cannot silently reopen admission. Windows are bounded to 365 days. Existing intents retain their admitted coverage.

`setPolicyAdmissionEnabled(escrow, depositId, method, enabled)` is depositor-controlled opt-out. `isPolicyAdmissionEnabled` reports enrollment and opt-out, including zero-window policies; it does not promise collateral coverage or that a selected rule is enabled. Admission checks rule availability separately. These replace the old dispute-protection enable APIs.

`registerPolicyRoute(orchestrator, paymentVerifier, signatureVerifier)` pins each orchestrator's verifier and its underlying signature checker. Routes cannot be overwritten. A verifier shared by multiple orchestrators must use one signature checker. Recursive DPP/UPV signature targets reject. Hook authorization is independent from route registration.

`getPolicyIntent` replaces the split policy metadata and coverage getters. Its record occupies eight slots, including effective policy, origin, lifecycle status and coverage. There is no duplicated escrow/deposit/amount snapshot, cached registry, proof receipt or separate zero-window lifecycle. This storage layout requires a fresh deployment; slot counts are not measured gas savings.

## Verification

```text
UPV3 validates the payment, intent snapshot and signed data hash
  -> DPP.verify delegates to the registered signature checker once
  -> DPP enforces the exact signed payload and effective policy
UPV3 consumes the payment in the existing NullifierRegistryV2
OrchestratorV3 settles through the snapshotted lifecycle hook
DPP checks the origin and consumed-payment binding
```

DPP implements the existing `IAttestationVerifier` extension point. UPV3's `setAttestationVerifier` points to DPP; its source, EIP-712 domain and message type remain unchanged. Only registered verifiers can supply a digest/data pair. A tracked intent additionally binds verification to its originating orchestrator's registered verifier.

Admission and nonmanual settlement require the registered method route, DPP as the current checker, and the verifier as the sole payment-registry writer. Settlement requires a consumed-payment binding. A checker or route change therefore cannot bypass managed policy settlement: the fulfillment and payment consumption revert atomically. Maker-authorized manual release and cancellation remain available when proof routing is unavailable.

```text
data = abi.encode(PaymentDetails, IntentSnapshot, bytes32 policyId)
     = 6 payment words + 8 snapshot words + 1 policy word = 480 bytes
dataHash = keccak256(data)
PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)
```

DPP requires exactly 480 bytes. The appended policy word is signed; unsigned metadata and caller labels cannot grant eligibility. Ordinary evidence uses ZeroHash. Issuers must produce this shape before DPP becomes the checker; old 448-byte proofs must be regenerated.

## Correction and collateral

`adjustPolicy(intentHash, policyId)` allows only the taker to correct a tracked, pending, unexpired order. Admissions must be unpaused, the new rule enabled, and the current deposit configuration valid. The effective window becomes `max(previousWindow, selectedRule.riskWindow)`.

Changing from zero coverage to a positive window locks full collateral atomically. Insufficient free stake reverts the correction. Existing positive coverage retains its original stake owner, depositor and pending lock; corrections cannot unlock, shorten or relock it. A shorter or zero-window evidence policy may be selected, but the previously committed longer coverage remains. Settlement compares the signed policy to the effective record and starts that retained window.

Before paying, a buyer may cancel and recreate an order. After paying, correcting the existing order avoids abandoning its payment binding. The client must disclose the effective retained window, which may exceed the newly selected rule's window. No client UI is implemented here.

Zero-window orders skip collateral operations and cannot release or dispute nonexistent coverage. Positive orders retain resizing, maturity, dispute compensation and explicit maker-authorized manual release.

## Deployment and consumer cutover

The new signal and hook ABIs require a fresh OrchestratorV3, lifecycle hook and DPP. Existing UPV3 and payment replay history can be reused, with the new orchestrator registered and the verifier retained as sole writer. Drain pending predecessor admissions before replacing the checker; predecessor collateral must remain resolvable until released or disputed. Vault-controller authority must not move while predecessor locks remain unless an explicit state migration handles them.

Direct consumers must regenerate the OrchestratorV3/hook/DPP ABI and types, supply `lifecycleHookData`, keep post-hook `data` opaque, and adopt `getPolicyIntent` plus the admission enable APIs. Existing gating signatures and stored intent/payment snapshots do not gain a policy field. Attestation-service's 480-byte encoding and UPV3 signing address are unaffected by this refactor.

Executed deployment sources and live selections remain immutable. Current wrappers bind lanes 39/40/42 and their historical rehearsals to the committed executed ABI and bytecode. They restore current artifact resolution before a successor lane runs; no old methods remain in the current contracts. Deployment typechecking checks current sources, wrappers and tests; digest-verified immutable lanes are validated by their historical-artifact rehearsals instead of today's TypeChain ABI. The local-only lane 43 installs the new policy stack and ordinary rules for integration testing. It refuses live execution and protects local reruns from restoring a historical hook.

Balance and G&S classification, nonzero issuance, production deployment, package publication and coordinated consumer rollout remain separate work. Ordinary policy zero does not certify F&F. Classified policies must stay unavailable until evidence validation prevents funding/product mismatches, including G&S using ordinary evidence to evade a longer window.
