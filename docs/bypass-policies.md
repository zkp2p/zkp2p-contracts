# Signed bypass policies

- Keep the existing payment method and payment nullifier. A bypass policy is an evidence rule, not another rail.
- Approved rules apply globally. There is no maker bypass toggle or per-maker rule list.
- The buyer saves a rule before creating an order. Admission records that rule for the order and locks no stake.
- Ordinary protected orders still lock their full stake at admission.
- One payment attestation carries the signed rule. Fulfillment requires the admitted rule to match.
- If funding does not qualify, the buyer can lock the full required stake and convert the same pending order to ordinary protection, then use a policy-zero attestation.

This implementation changes `DisputeProtectionPolicy` and appends statuses to its interface. OrchestratorV3,
IntentLifecycleHookV1 and UnifiedPaymentVerifierV3 retain their existing code and interfaces. Positive Venmo balance
issuance is not available in the paired attestation change yet; authenticated payer evidence remains a release blocker.

## Wire contract

`data = abi.encode(PaymentDetails, IntentSnapshot, bytes32 policyId)` is exactly **480 bytes**. The existing six-word
payment tuple and eight-word intent tuple remain the first 448 bytes. All issuers must append the final word, including
zero for ordinary payments; the policy checker rejects missing or extra words. There is no legacy wire fallback.

The EIP-712 type remains `PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)`.
`dataHash = keccak256(data)` authenticates the complete payload. Response `actionType` and `metadata` are not evidence.

| Recorded admission | Signed policy | Result |
|---|---|---|
| Pending bypass | Exact admitted nonzero rule | Accept valid payment evidence without stake |
| Pending bypass | Zero or another rule | Reject |
| Ordinary or recovered protected order | Zero | Apply normal protection |
| Whitelisted or open order with no policy admission | Zero | Preserve the existing route |
| Any order without pending bypass admission | Nonzero | Reject |

The attestor owns the meaning of a nonzero rule and must verify its evidence before signing it. Solidity contains no
Venmo funding classifier. `registerBypassPolicy` fixes the rule's payment method permanently; disabling a rule blocks
new choices/admissions without rewriting already admitted orders.

## Contract calls and state

- `setBypassPolicyChoice(escrow, depositId, paymentMethod, policyId)` saves only the caller's preference. Zero resets it.
- The choice persists for that buyer/deposit/method. Reading a preference is not proof that an order was admitted as bypass.
- `getBypassAdmission(intentHash)` returns the original rule, hook, escrow, deposit and amount. Read the existing
  protection status as well: the origin remains stored after recovery.
- `BYPASS_PENDING` closes as `BYPASS_CANCELLED`, `BYPASS_SETTLED`, or `BYPASS_MANUAL_RELEASED`. These appended enum values
  do not renumber existing states. Bypass settlements never create collateral compensation or a releaseable stake lock.
- `convertBypassToProtected(intentHash)` is recorded-taker-only, pending-only and one-way. It checks the original active
  unexpired order, admission pause, current protection configuration and token, resolves current stake delegation, and
  successfully locks the full original amount before becoming ordinary `PENDING`. Failed locking changes no state.
- Recovered settlement resizes the lock and starts the ordinary risk window. Cancellation unlocks it; disputes work normally.
- Current whitelist/open admission behavior remains. A nonmember cannot use no-stake bypass to evade an enabled whitelist.
- A whitelisted/open order which skipped policy admission must use policy zero even if the buyer has saved a bypass choice.

## Why the view checker cannot be skipped

`registerBypassRoute(hook, orchestrator, paymentVerifier, signatureVerifier)` pins reviewed non-proxy dependencies.
One hook has one originating orchestrator for bypass because the unchanged hook does not forward its caller.
The registered payment verifier's existing `setAttestationVerifier` must point to this policy.

Admission and verification check the canonical active intent and its snapshotted hook. Verification accepts calls only
from configured payment verifiers, delegates the original digest/signature check, and enforces the signed rule.
The unchanged verifier already checks the full data hash and intent snapshot before calling the policy.

At admission, verification and proof settlement, the method must still route to the pinned verifier, that verifier
must still use this policy as its checker, and the payment registry must list exactly that verifier as its sole writer.
Settlement then requires both registry directions to bind the consumed payment to this intent. The orchestrator has
already deleted its active intent at that point, so the callback uses the saved origin instead of rereading deleted state.
Any callback failure reverts the entire fulfillment, including payment consumption and token transfers.

Manual maker release and cancellation remain available even if the proof route is broken. All terminal callbacks for
a bypass-origin order, including a recovered order, must come from its original hook. This retains the existing trust
in registered orchestrators and governance; getter-compatible malicious dependencies are not made trustworthy by registration.

## Release boundary

- No deployment, registry mutation, package publication or existing address export is part of this change.
- A replacement policy needs a hook constructed with its address; hook source remains unchanged. Drain the old policy's
  active orders and collateral obligations before moving StakeVault controller authority, or use a separately reviewed migration.
- Review the actual chain, escrow, hook, verifier, signature checker, nullifier history and sole-writer configuration before activation.
- Switch every issuer using the configured payment verifier to the canonical 480-byte payload before enabling the checker.
  Outstanding 448-byte attestations must be regenerated. Consumers must forward the complete signed bytes unchanged.
- Never enable a nonzero Venmo rule until authenticated balance and external-funding captures establish the complete
  response schema, payer/profile ownership and canonical payment-ID correlation through the intended TEE transport.
- Client support for selection, observed admission, funding instructions and recovery is required before user rollout.

`DisputeBypassPolicy.t.sol` exercises the unchanged orchestrator/verifier with a real signature checker and registries,
including wrong policy, missing/tampered policy bytes, replay, unsafe verifier routes, cancellation, manual release,
recovery and compensation. Its synthetic payment attestations validate contract enforcement, not Venmo funding classification.
