# Payment policies with existing payment methods

`IntentLifecycleHookV1` gains evidence policies for zero-stake,
direct-payout intents on deposits with dispute protection enabled. It serves as
both the OrchestratorV3 lifecycle hook and the existing UnifiedPaymentVerifierV3's
attestation verifier. It reuses the current whitelist, dispute policy, witness
verifier and stake vault.

The policy changes are made directly in the existing hook source; there is no
separate policy-hook contract. The updated hook is not deployed or activated.
Each policy needs authenticated attestor evidence and quote/client support
before governance enables admissions.
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
the lifecycle hook already snapshotted by O3. The hook does not change the
ordinary Venmo or PayPal dispute risk windows.

## Policy registration and existing deposit eligibility

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

Deposit eligibility reads the existing dispute policy directly:

```solidity
disputeProtectionPolicy.isDisputeProtectionEnabled(escrow, depositId, paymentMethod);
```

Every deposit with effective dispute protection enabled automatically supports
all governance-enabled policies for that method. This includes existing deposits
and new deposits, since protection defaults on for methods with a nonzero risk
window unless the maker opts out. There is no separate policy opt-in, per-policy
deposit setting, backfill or maker migration transaction.

The existing depositor-only `setDisputeProtectionEnabled` control remains
authoritative. Opting out disables future policy admissions for that deposit and
method; a zero method risk window also makes it ineligible. Enabling protection
therefore permits ordinary stake-backed payments and qualifying policy payments
without stake-backed compensation. Governance can disable each policy globally.
Existing payment-method identity, rates, currencies and liquidity are reused.
Governance, maker and risk-window changes affect future admissions only; a
pending intent keeps its required policy and originating orchestrator.

## Selecting a policy

The buyer signals with the policy's existing payment method and:

```solidity
postIntentHook = IPostIntentHookV2(address(0));
data = abi.encode(keccak256("payment_policy"), policyId);
```

The policy envelope is exactly 64 bytes. Data beginning with the full 32-byte
marker is reserved: malformed lengths, zero or unknown policies, disabled
admissions, wrong payment methods and disabled dispute protection revert. Other
data continues through ordinary admission without reinterpretation.

An enabled whitelist still requires the taker to be allowed. Escrow,
pre-intent-hook, gating-service and other O3 checks continue to apply. Policy
admission skips DPP, so there is no collateral lock, post-settlement risk window
or stake-backed dispute compensation for that intent.

Policies support direct payouts only. The hook does not overwrite or envelope
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
update canonical hook recognition/configuration to accept the replacement hook.
Curator's
`src/api/v3/eligibility/lifecycleHookGate.ts` recognizes the configured lifecycle
hook address exactly; an unknown replacement causes protected quote rows to be
excluded, including ordinary quotes. Its recognition/configuration and any
consumed contract-package address must be ready before changing O3's hook.

Deploy the updated `IntentLifecycleHookV1` with its unchanged constructor:
current orchestrator registry, whitelist policy and DPP. Deployed bytecode cannot
be overwritten; this is a fresh hook address, with existing intents retaining
their snapshotted hook. No core contract or deposit is replaced.

Prepare these governance calls as one reviewed batch, using the respective
contracts' owners:

1. `hook.initializePaymentVerifier(currentUPV3)`, called by the DPP owner. This
   permanently binds the existing UPV3 and captures its current witness verifier;
   verify that checker is the intended witness verifier. The registry must match.
2. `DisputeProtectionPolicy.setLifecycleHookAuthorization(hook, true)`.
3. `UnifiedPaymentVerifierV3.setAttestationVerifier(hook)`.
4. `OrchestratorV3.setLifecycleHook(hook)`.

Verifier binding is one-time and must precede installing the hook as UPV3's
checker; self-verification is rejected. Ordinary lifecycle behavior remains
available without this binding, while no policy can be registered until it is
bound. There is no duplicate governance owner on the hook. The original
constructor and historical deployment scripts remain unchanged.

Governance must separately register/enable the reviewed policies. Existing
protected deposits then become eligible without per-deposit transactions. Retain
the previous hook's DPP authorization while its intents remain pending. Keep the
current UPV3, O3, DPP, vault, method routes and nullifier permissions. Update
current readiness checks for the new checker/hook pairing; historical deployment
lanes and records remain immutable.

At admission and proof settlement, the hook verifies both that it remains
UPV3's checker and that the originating O3's registry routes the bound payment
method to that UPV3. Replacing either dependency therefore cannot settle a pending
policy intent with an ordinary proof. Cancellation and maker-authorized manual
release remain available. To stop new policy intents, disable the policy globally
or opt the deposit method out of dispute protection while retaining the checker
until pending policy intents resolve.

## Direct consumers

- Attestor: validate the exact requested policy, authenticate its evidence and
  append the signed word. Ordinary issuance remains unchanged; do not fall back
  between policy choices.
- Indexer: project `PolicyUpdated` and `PolicyIntentSignaled`, using O3 terminal
  events for intent status. Reuse existing dispute-protection configuration and
  risk-window projections for deposit eligibility; there is no new deposit
  opt-in entity or backfill. Configuration changes affect future quotes; pending
  intent policy remains frozen.
- Curator: recognize the active hook and quote policies only when governance,
  effective dispute protection, whitelist and direct-payout requirements hold.
  Keep ordinary stake quotes unchanged; a policy quote separately carries its
  required evidence and zero-stake admission.
- SDK/client: carry the selected policy through quote, signal, proof and recovery
  using the original payment method and account identity. Do not expose offers
  until the policy, attestor and consumer path are active. No additional maker
  opt-in screen or transaction is needed.

## Verification

`IntentLifecycleHookV1PaymentPolicies.t.sol` exercises real O3, EscrowV2, UPV3,
witness signatures, replay registries, DPP and StakeVault. It covers zero-stake
policy settlement, ordinary 14-day staking and old pending proofs, governance
authorization, one-time verifier binding and installation order, automatic
eligibility of existing protected deposits,
deposit/method opt-out isolation, risk-window changes, permanent policy identity,
frozen admissions, malformed envelopes, exact signed policy matching,
cross-policy replay, synthetic PayPal method isolation, whitelist/custom-hook
boundaries, witness thresholds,
cancellation, manual release, checker rollback and verifier-route replacement.
