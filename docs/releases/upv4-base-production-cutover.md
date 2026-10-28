# UnifiedPaymentVerifierV4 Base production cutover

Status, 2026-10-28:

- UPV4 is deployed on Base and owned by the Safe.
- The cutover Safe transaction (nonce 86) is being signed. It has not been
  executed.
- Routes are still on UPV3.

Each remaining step is its own approval boundary (see
`.claude/skills/ship-contracts/SKILL.md`).

UPV4 ships to Base production before OrchestratorV4. On Base, O4 stays
unregistered and UPV4 serves the live OrchestratorV3 through its V2
`getDepositPreIntentHook` probe (`test_OrchestratorV3FulfilsThroughUPV4`). The
Base V1 orchestrator is unused and plays no part in this release.

## Deployer

The previous production deployer `BASE_DEPLOY_PRIVATE_KEY` is compromised and
must not sign anything. Base production deploys now use
`0x41123d6419C7b8e44157f6F3b0088442116641eC`. Its key is `STAGING_DEPLOYER_KEY`
in Kohai Infisical, which the user designated for production too.

## Deployment (executed)

| Item | Value |
| --- | --- |
| UnifiedPaymentVerifierV4 | `0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048` |
| Deploy tx | `0xa6fa3ce43ca5352460be4ce917709f17d60fda677fa48a1fbc6f081902dcf931`, block 53210472, deployer nonce 117 |
| Constructor | `(OrchestratorRegistry 0xBe9f…82A9, NullifierRegistryV2 0x5455…aeB, MultiAttestationVerifier 0x9Fe9…02d5)` |
| Catalog | 13 `addPaymentMethod` calls, nonces 118–130, in PaymentVerifierRegistry order |
| Ownership | `transferOwnership(Safe)` tx `0xa9abe1334345ea502e059c769db50bc31153d229c8f05e85e01d5c1d8ff54ce6`, block 53210497. Single-step `Ownable`, so nothing to accept |
| Source | main `646898f2afa2d0e114a7f44e96fc6222aa1c7a91` |

The source checks:

- The creation input equals the compiled artifact plus those arguments, byte for
  byte.
- The 9,048-byte runtime carries the same compiler metadata as staging UPV4
  `0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb`.

### Recording

Lane 47 (`deploy/47_deploy_unified_payment_verifier_v4.ts`) records this
deployment rather than deploying again. A tagged Base run with no record checks
the pinned deployment on-chain and saves `deployments/base/UnifiedPaymentVerifierV4.json`.
It checks:

- the deploy transaction (sender, nonce, creation input) and its receipt;
- the runtime code, immutables and `DOMAIN_SEPARATOR`;
- `owner() == Safe`;
- the 13 methods in order.

The run sends no transaction and uses no signer. Once the record exists, every
Base run re-checks it and skips; any mismatch throws. Those later runs check the
chain against the record's own ABI, bytecode, metadata and receipt, not against
the compiled artifact. A later edit to UPV4 or to a file it imports, such as
`IOrchestratorV4.sol`, therefore does not break untagged Base runs. Only the
adoption run compares the compiled artifact with the chain.

```bash
yarn record:upv4:base        # read-only: check, save the record, export, extract
yarn write:upv4-safe-batches # render the three batches from the record
yarn verify:upv4-safe-batches
yarn verify:upv4:base        # Basescan source verification
```

## Pinned registry state

Read at Base block `53209611` and pinned in `UPV4_BASE_RELEASE`
(`deployments/parameters.ts`):

| Contract | Address | State |
| --- | --- | --- |
| Safe (2 of 2) | `0x0bC26FF515411396DD588Abd6Ef6846E04470227` | owns every contract below and UPV4 |
| PaymentVerifierRegistry | `0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e` | 13 methods, 72 currency entries, all on UPV3 |
| NullifierRegistryV2 | `0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB` | writers `[UPV3]` |
| OrchestratorRegistry | `0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9` | O3 registered |
| MultiAttestationVerifier | `0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5` | threshold 1 |
| UnifiedPaymentVerifierV3 | `0xC6F4a193576C60892a47e111Bb5706c30162502B` | current verifier |
| OrchestratorV3 | `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7` | live orchestrator |

Method order: alipay, chime, venmo, revolut, cashapp, wise, mercadopago, zelle,
monzo, paypal, upi, xmoney, monobank.

## 1. Export the package with the Base UPV4 address

Approval: package export, then separately RC publication through
`.agents/skills/zkp2p-contracts-publish/SKILL.md`. Never publish locally.

`record:upv4:base` refreshes `deployments/outputs/baseContracts.ts`. After that,
`yarn pkg:build` emits `addresses/base.json:UnifiedPaymentVerifierV4` and
`abis/base/UnifiedPaymentVerifierV4.json`. UPV3 stays, because it is routed
until step 3 and remains the rollback target. The package exports the latest
address; it does not say whether routes are active.

## 2. Ship the route-aware attestor and Pay support signer to production

Approval: attestor and Pay production deploys. Do this while every route is
still on UPV3.

OrchestratorV3 looks up the verifier with
`PaymentVerifierRegistry.getVerifier(method)` when an intent is fulfilled, not
when it is signaled. UPV3 and UPV4 have different EIP-712 domains
(`verifyingContract`) and different payloads. UPV4 signs `PaymentDetails`, an
`IntentSnapshot` carrying `payerCommitmentHash` and `owner`, and
`settlementData`.

So both signers must read the current route when they sign, and produce the
domain and payload of the verifier that route points to. Before going further,
confirm in production that UPV3 proofs still fulfil.

## 3. Execute the cutover Safe transaction

Approval: Safe execution.

| Field | Value |
| --- | --- |
| Safe nonce | 86 |
| To | MultiSendCallOnly `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D`, operation 1 (delegatecall) |
| Calls | 27 |
| `multiSend` data keccak | `0x6d61bafbe0947c6db17eec69fedd7b485062d712ee66c7cbb3dacd3575d9ae58` (6,916 bytes) |
| safeTxHash | `0xe22ba698b10018c270a658525412b5e9cd81db2a4f42f9dd58983b639a2f8c70` |

`deployments/outputs/safe-batches/base_upv4_cutover.json` encodes to exactly
this hash. `yarn verify:upv4-safe-batches` checks it.

| # | Target | Call |
| --- | --- | --- |
| 0 | NullifierRegistryV2 | `addWritePermission(UPV4)` |
| 1–13 | PaymentVerifierRegistry | `removePaymentMethod` monobank, xmoney, upi, paypal, monzo, zelle, mercadopago, wise, cashapp, revolut, venmo, chime, alipay |
| 14–26 | PaymentVerifierRegistry | `addPaymentMethod(method, UPV4, currencies)` alipay … monobank, with the same currencies |

The registry removes by swap-and-pop. Removing in reverse and re-adding in order
keeps the order. The batch is one atomic transaction, so no intermediate route
state is ever visible. UPV3 stays an NRV2 writer, so the rollback works. A proof
signed for UPV3 just before execution and submitted after it fails, and the
client must re-request it.

## 4. Monitor

- Every route points at UPV4:
  `cast call 0x2b82…eB1e 'getVerifier(bytes32)(address)' <method>`.
- NRV2 writers are `[UPV3, UPV4]`.
- UPV4 emits `PaymentVerified` and UPV3 stops emitting it.
- Fulfil success rate, attestor and support-signer error rates, and the rate of
  `UPV: Invalid attestation` and `Nullifier has already been used` reverts.

After execution, lane 31's wrapper defers to lane 47, because every route then
points at the recorded UPV4. Untagged Base runs keep working. The wrapper still
runs lane 31's frozen readiness checks (O3, MultiAttestationVerifier witnesses
and threshold, NRV2 and UPV3), accepting only the failure of their final
UPV3-only writer check. It also checks the live registry against UPV4 and its
owner: O3's registry, the PVR, legacy registry and NRV2 owners, the method
order, every currency list, every route, and that no legacy writers remain.

## 5. Revoke the UPV3 writer later

Approval: a separate Safe proposal and execution after a stable soak.

`base_upv4_upv3_writer_removal.json` is one call:
`NullifierRegistryV2.removeWritePermission(UPV3)`. It is prepared but not
scheduled. After it executes, the rollback batch must not run until UPV3 is
added back as a writer. Nothing on-chain stops it: the rollback makes only
PaymentVerifierRegistry calls, so it would still execute and route every method
to a UPV3 that can no longer write nullifiers, and every fulfil would revert.
The batch's own description says the removal "disables" the rollback; treat
that as this prohibition, not as an on-chain guard.

## Rollback

Approval: a Safe proposal and execution of the prepared rollback.

`base_upv4_rollback.json` holds 26 calls. It removes all 13 routes in reverse
order and re-adds them on UPV3 in the original order, with the same currencies.
It changes no writer. It is valid only while UPV3 is still an NRV2 writer, which
is true until step 5. Before proposing or executing it, confirm that this
returns `true`:

```bash
cast call 0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB 'isWriter(address)(bool)' \
  0xC6F4a193576C60892a47e111Bb5706c30162502B
```

The route-aware signers follow the route back by themselves. Replay protection
holds across the switch, because UPV3 and UPV4 write one shared replay domain:
`keccak256(method, paymentId)` in NullifierRegistryV2.

After a rollback, UPV4 is still an NRV2 writer, but no route points at it.
Lane 31's live check expects UPV3 to be the only writer, so untagged Base runs
fail closed until governance resolves that.

## Evidence

The fork test
`test-foundry/fork/UnifiedPaymentVerifierV4BaseCutover.t.sol` runs with
`BASE_FORK_RPC_URL` and skips without it. It forks Base at block `53210521`,
after the ownership transfer, against the real UPV4. It runs the exact batch
bytes from `yarn upv4:safe-batches ffi` as the Safe, then checks:

- every route and writer;
- an O3 fulfil through UPV4 with a fork-only witness;
- cross-verifier replay rejection in both directions;
- the rollback, followed by an O3 fulfil through UPV3.

`yarn upv4:safe-batches plan` prints the address-free decoded plan. Its golden
copy is `deployments/upv4-base-release-plan.json`.
