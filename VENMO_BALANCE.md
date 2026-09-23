# Venmo balance with the existing payment method

`VenmoBalancePolicy` adds a maker opt-in for direct-payout, balance-funded Venmo
intents. It serves as both the OrchestratorV3 lifecycle hook and the existing
UnifiedPaymentVerifierV3's attestation verifier. It reuses the current whitelist,
dispute policy, witness verifier and stake vault.

This contract is not deployed or activated. Authenticated per-payment funding
classification in the attestor and the downstream quote/client integration must
be complete before offering this mode to buyers.

## Unchanged identities and proofs

- Payment method: `keccak256("venmo")` for both modes.
- Canonical payment ID: the existing hash of Venmo's payment ID.
- Nullifier: `keccak256(abi.encodePacked(paymentMethod, paymentId))`, written by
  the same UPV3 into the same NullifierRegistryV2. No registry migration or new
  writer is required.
- EIP-712 domain, attestation type and verifying contract: unchanged.
- Ordinary proofs: the existing 448-byte payload, unchanged.
- Ordinary admission, staking, settlement and post-intent hook data: unchanged.
- Pending intents keep the lifecycle hook already snapshotted by O3.

## Selecting balance mode

The depositor calls `setBalanceEnabled(escrow, depositId, true)`. It defaults to
false. Delegates cannot make this risk decision. Existing Venmo deposit identity,
rates, currencies and liquidity are reused.

The buyer signals with the ordinary Venmo method and:

```solidity
postIntentHook = IPostIntentHookV2(address(0));
data = abi.encode(keccak256("venmo_balance"));
```

The exact 32-byte marker selects balance mode. It must be a Venmo direct payout
on an enabled deposit. An enabled whitelist still requires the taker to be
allowed. Escrow, pre-intent hook, gating-service and other O3 validation still
apply. Balance mode skips dispute-policy admission, so it creates no stake lock
or post-settlement risk window. Ordinary intents retain the existing whitelist
or stake admission behavior.

Mode is frozen by intent hash at signal time. Disabling the offer affects only
future intents. A failed balance proof leaves the same intent pending; it does
not change the intent to ordinary mode. Buyers must verify the original payment
or use the existing support/manual-release path rather than pay again.

This first version supports direct payouts only. It does not prefix or reinterpret
bridge/custom-hook payloads. The marker is reserved; submitting it with a
post-intent hook reverts.

## Signed evidence

Balance evidence has exactly this layout:

```text
existing PaymentDetails (192 bytes)
existing IntentSnapshot (256 bytes)
keccak256("venmo_balance") (32 bytes)
```

The attestor must append the word before computing `dataHash` and signing the
existing `PaymentAttestation`. It may issue the balance tag only after authenticating
complete per-payment funding evidence tied to the same canonical payment ID,
payer, recipient, amount and currency. A client flag, account balance, missing
funding fields or unsigned attestation metadata is not funding evidence.

For a frozen balance intent, the module requires exactly 480 bytes and the exact
tag, then delegates the full digest, signatures and data to the original witness
verifier. Witness rotation and signature thresholds remain authoritative there.
An ordinary proof cannot settle a balance intent. Altering, appending or removing
a tag invalidates its signature. Both modes share the same nullifier namespace.
Ordinary intents delegate to the witness verifier without imposing a new payload
length requirement.

Cancellation and settlement clear the frozen mode. The caller must be the
orchestrator that enrolled the balance intent. Maker-authorized manual release
retains its existing behavior and does not require a payment proof.

## Activation order

After the attestor and direct consumers are verified, deploy one module with the
current UPV3, whitelist policy and dispute protection policy. The constructor
captures UPV3's current witness verifier; verify it is the intended live verifier.

Prepare the following governance calls as one reviewed batch:

1. `DisputeProtectionPolicy.setLifecycleHookAuthorization(module, true)`.
2. `UnifiedPaymentVerifierV3.setAttestationVerifier(module)`.
3. `OrchestratorV3.setLifecycleHook(module)`.

Retain the previous hook's dispute-policy authorization while its intents remain
pending. Reuse all existing contract addresses and nullifier permissions except
for the new module. Do not change deployed-source files, deployment records or
package address aliases before an independently authorized deployment.

The module refuses balance admission or proof settlement if its UPV3 checker
has been replaced. Cancellation and maker-authorized manual release remain
available. To stop offering new balance intents, change O3's future hook or
disable the offers while retaining the module's checker until pending balance
intents are resolved. Payment-verifier routing is a governance trust boundary;
do not change the Venmo route during this activation.

Before activation, current deployment readiness checks must recognize the new
checker/hook pairing. Historical deployment lanes remain immutable.

## Direct consumers

- Attestor: authenticate funding from the recorded Venmo response schema; sign
  the extra word only for proven balance payments. Ordinary issuance stays
  byte-for-byte unchanged. Seller evidence without payer funding information
  cannot satisfy a balance intent.
- Indexer: project `BalanceEnabled` per deposit and `BalanceIntentSignaled` per
  intent from this module. Use existing O3 terminal events for intent status.
  No payment-method alias or deposit migration is needed.
- Curator: quote balance mode only for explicitly enabled deposits satisfying
  the whitelist and direct-payout constraints. Ordinary stake quotes are unchanged.
- SDK/client: carry the selected mode through quote, signal, proof and recovery;
  use the same Venmo capture flow and identity. Do not expose balance offers
  before the module and authenticated attestor path are active.

## Verification

`VenmoBalancePolicyOrchestratorV3.t.sol` uses real O3, EscrowV2, UPV3, witness
signatures, nullifier registry, dispute policy and stake vault. It covers balance
settlement without stake, ordinary 14-day settlement, old-hook pending intents,
maker authorization, frozen opt-ins, wrong/missing/unsigned tags, replay in both
directions, witness threshold changes, whitelist and post-hook boundaries,
cancellation, manual release and verifier rollback.
