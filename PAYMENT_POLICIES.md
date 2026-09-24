# Payment policies with existing payment methods

`PaymentPolicyHook` lets governance register evidence policies and makers opt
individual deposits into zero-stake, direct-payout intents. It serves as both the
OrchestratorV3 lifecycle hook and the existing UnifiedPaymentVerifierV3's
attestation verifier. It reuses the current whitelist, dispute policy, witness
verifier and stake vault.

This contract is not deployed or activated. Each policy needs authenticated
attestor evidence and quote/client support before governance enables admissions.
Registering a policy is an explicit decision to offer it without stake-backed
dispute protection; a policy name does not establish payment irreversibility.

## Existing identities and ordinary flows

The payment method, payment ID, UPV3 address, EIP-712 domain and attestation type
remain unchanged. Both ordinary and policy payments consume the existing
`keccak256(abi.encodePacked(paymentMethod, paymentId))` nullifier through the same
UPV3 and NullifierRegistryV2. No new payment method, registry writer, deposit,
liquidity transfer or historical nullifier migration is required.

Ordinary 448-byte proofs and opaque post-intent hook data remain unchanged.
Ordinary intents retain V1 whitelist/staking admission. Pending intents retain
the lifecycle hook already snapshotted by O3. This module does not change the
ordinary Venmo or PayPal dispute risk windows.

## Policy registration and maker consent

Only the configured UPV3's current owner can call:

```solidity
setPolicy(policyId, paymentMethod, admissionEnabled);
```

Every nonzero policy ID is permanently bound to one nonzero payment method.
Disabling admissions retains that identity; governance cannot rebind it later.
The registry contains only zero-stake policies, not configurable risk windows.
Example registrations are:

| Policy ID | Payment method | Required attestor evidence |
| --- | --- | --- |
| `keccak256("venmo_balance")` | `keccak256("venmo")` | Authenticated qualifying balance-funded payment |
| `keccak256("venmo_goods_and_services")` | `keccak256("venmo")` | Authenticated protected-payment classification |

The two policies are independent choices, not substitutes. Neither changes the
ordinary Venmo method. A future `paypal_balance` policy must bind to
`keccak256("paypal")` and have its own evidence implementation before activation.
The PayPal integration test is synthetic evidence of method isolation, not a
claim that PayPal balance proof support exists.

The depositor then calls:

```solidity
setDepositPolicyEnabled(escrow, depositId, policyId, true);
```

Opt-in defaults to false for each deposit and policy. Delegates cannot make this
risk decision. Existing payment-method identity, rates, currencies and liquidity
are reused. Governance and maker configuration changes affect future admissions
only; a pending intent keeps its required policy and originating orchestrator.

## Selecting a policy

The buyer signals with the policy's existing payment method and:

```solidity
postIntentHook = IPostIntentHookV2(address(0));
data = abi.encode(keccak256("payment_policy"), policyId);
```

The policy envelope is exactly 64 bytes. Data beginning with the full 32-byte
marker is reserved: malformed lengths, zero or unknown policies, disabled
admissions, wrong payment methods and missing maker consent revert. Other data
continues through ordinary admission without reinterpretation.

An enabled whitelist still requires the taker to be allowed. Escrow,
pre-intent-hook, gating-service and other O3 checks continue to apply. Policy
admission skips DPP, so there is no collateral lock, post-settlement risk window
or stake-backed dispute compensation for that intent.

Policies support direct payouts only. The module does not overwrite or envelope
existing bridge/custom-hook data; supplying the policy envelope together with a
post-intent hook reverts. A failed proof leaves the intent in the same policy.
It never changes to ordinary or another policy. The buyer must prove the original
payment or use the existing cancellation/support/manual-release paths.

## Signed evidence

A policy proof has exactly this signed data layout:

```text
existing PaymentDetails (192 bytes)
existing IntentSnapshot (256 bytes)
required policyId (32 bytes)
```

The attestor appends the required word before computing `dataHash` and signing
the existing `PaymentAttestation`. It may emit a policy ID only after validating
that policy's authenticated evidence against the same canonical payment ID,
payer, recipient, amount and currency. Client flags, unsigned metadata and a
current account balance cannot establish eligibility.

For Venmo balance, the attestor requires personal-payment classification and a
complete payer-scoped `TransactionDetails` response whose `transactionFields`
array omits `fundingSource`. A present source, including null or split funding,
does not qualify. For Venmo goods and services, the authenticated story must
have `subType == "payment_protected"`; existing protected-payment amount
normalization remains in the attestor. The hook neither infers funding from the
policy name nor changes payment amounts.

The hook requires exactly 480 bytes and the frozen intent's exact policy ID,
then delegates the complete digest, signatures and data to the original witness
verifier. Witness rotation and signature thresholds remain authoritative there.
An ordinary proof or another policy's signed tag cannot satisfy an enrolled
intent. Changing, appending or removing a tag invalidates its signature. Ordinary
intents delegate without imposing a new payload-length requirement.

Cancellation and settlement clear enrollment. Only the originating orchestrator
can clear it. Maker-authorized manual release retains its existing trusted
behavior and does not require a payment proof.

## Activation prerequisites and order

Deployment and activation require separate authorization. This change contains
no deployment lane, live configuration, deployment artifact or package-address
update.

Before activation, complete the attestor and direct-consumer integration and
update canonical hook recognition/configuration to accept this module. Curator's
`src/api/v3/eligibility/lifecycleHookGate.ts` recognizes the configured lifecycle
hook address exactly; an unknown replacement causes protected quote rows to be
excluded, including ordinary quotes. Its recognition/configuration and any
consumed contract-package address must be ready before changing O3's hook.

Deploy one module with the current UPV3, whitelist policy and DPP. Its constructor
captures UPV3's current witness verifier; verify that dependency is the intended
live verifier. Prepare these governance calls as one reviewed batch:

1. `DisputeProtectionPolicy.setLifecycleHookAuthorization(module, true)`.
2. `UnifiedPaymentVerifierV3.setAttestationVerifier(module)`.
3. `OrchestratorV3.setLifecycleHook(module)`.

Governance must separately register/enable the reviewed policies. Retain the
previous hook's DPP authorization while its intents remain pending. Keep the
current UPV3, O3, DPP, vault, method routes and nullifier permissions. Update
current readiness checks for the new checker/hook pairing; historical deployment
lanes and records remain immutable.

At admission and proof settlement, the module verifies both that it remains
UPV3's checker and that the originating O3's registry routes the bound payment
method to that UPV3. Replacing either dependency therefore cannot settle a pending
policy intent with an ordinary proof. Cancellation and maker-authorized manual
release remain available. To stop new policy intents, disable admissions or
maker offers while retaining the checker until pending policy intents resolve.

## Direct consumers

- Attestor: validate the exact requested policy, authenticate its evidence and
  append the signed word. Ordinary issuance remains unchanged; do not fall back
  between policy choices.
- Indexer: project `PolicyUpdated`, `DepositPolicyEnabled` and
  `PolicyIntentSignaled`, using O3 terminal events for intent status. Configuration
  changes affect future quotes; pending intent policy remains frozen.
- Curator: recognize the active hook and quote policies only when governance,
  maker, whitelist and direct-payout requirements hold. Ordinary stake quotes
  remain unchanged.
- SDK/client: carry the selected policy through quote, signal, proof and recovery
  using the original payment method and account identity. Do not expose offers
  until the policy, attestor and consumer path are active.

## Verification

`PaymentPolicyHookOrchestratorV3.t.sol` exercises real O3, EscrowV2, UPV3,
witness signatures, replay registries, DPP and StakeVault. It covers zero-stake
policy settlement, ordinary 14-day staking and old pending proofs, governance
and maker authorization, permanent policy identity, frozen admissions, malformed
envelopes, exact signed policy matching, cross-policy replay, synthetic PayPal
method isolation, whitelist/custom-hook boundaries, witness thresholds,
cancellation, manual release, checker rollback and verifier-route replacement.
