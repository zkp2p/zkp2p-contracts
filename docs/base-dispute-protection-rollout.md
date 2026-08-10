# Base dispute-protection rollout

This runbook covers the one-way UPV3/NullifierRegistryV2 cutover followed by a
fresh dispute-protection deployment. It does not authorize a deployment,
package publication, PR merge, Safe submission, Safe execution, release-branch
push, secret change, or production traffic change.

Every live boundary requires a clean worktree at an explicitly approved exact
SHA. Recompute all live reads immediately before acting. A staging approval is
not production approval, and deployment approval is not Safe-execution or
package-publication approval.

## Ratified scope

- Lane 29 is excluded. The current `WhitelistPolicy`, `WhitelistLifecycleHook`,
  and `OrchestratorV3` remain the starting point.
- Lane 31 verifies the already-deployed UPV3/NullifierRegistryV2 pair. Base
  staging is already cut over and is verification-only. Base production uses
  one atomic 22-call Safe batch.
- Lane 32 contains both dispute deployment and activation, but staging uses two
  separately gated runs of that lane: deploy-only, then activate.
- Only PayPal, Venmo, and Cash App have a 14-day dispute-risk window. Every
  other active method must read as zero.
- `attestation-service` dispute-evidence issuance is not implemented. This is a
  known rollout limitation, not evidence that dispute submission works.
- The production attestation release must move from its live UPV2 build to the
  reviewed UPV3 build in tandem with the lane-31 cutover.
- The rollout PR changes deployment/configuration surfaces only; its diff
  against `origin/main` contains no Solidity source change. The fresh dispute
  stack therefore deploys the canonical main contracts, while lanes 31 and 32
  separately pin live runtime hashes and constructor-immutable getters.

## Pinned inventory

Recheck every value at the preflight block. Stop on any mismatch.

| Surface                   | Base production                                   | Base staging                                     |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Chain ID                  | `8453`                                            | `8453`                                           |
| Governance                | Safe `0x0bC26FF515411396DD588Abd6Ef6846E04470227` | EOA `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` |
| Authorized deployer       | EOA `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929`  | EOA `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` |
| PaymentVerifierRegistry   | `0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e`      | `0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc`     |
| Legacy NullifierRegistry  | `0x8d8e1A0e5345a5cc9AA206c3ca76D6d28c514608`      | `0x3FFd04f7909a16d3476263A1f4ce413A089dCc69`     |
| NullifierRegistryV2       | `0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB`      | `0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C`     |
| UnifiedPaymentVerifierV1  | `0x16b3e4a3CA36D3A4bCA281767f15C7ADeF4ab163`      | `0xfFf74adAE1fb470d49cA37772C9859C4a6dBcc03`     |
| UnifiedPaymentVerifierV2  | `0x46A58Dc65587D4D7B8198C6A25eEdf5b2535Da94`      | `0x7750f8Cc276f21B7Db1477FA044Bf3FD4951Bf20`     |
| UnifiedPaymentVerifierV3  | `0xC6F4a193576C60892a47e111Bb5706c30162502B`      | `0x4c62E99649c8Ba745E67018f5c8a483D77c429C4`     |
| OrchestratorRegistry      | `0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9`      | `0xfA6384EB6176cfEC049540526A3d2126C3666d8A`     |
| EscrowRegistry            | `0xeD0e847B101abc96E796260AC358e12BAa2f5B21`      | `0xc545f336eC77E69bf115729acCbf2e557A00ac91`     |
| RelayerRegistry           | `0xEbA979889a9c97382A92472fF3703786fF180083`      | `0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E`     |
| WhitelistPolicy           | `0xBC53641b4B2504f0061D6a9426C61B8eBE9B4Ff0`      | `0x7d9277cb8bb78a51eeaafB7CFF306E7DA4C972fD`     |
| AddressGroupRegistry      | `0x39F80118f9eB619135f116171b6Cb91D372C5AF2`      | `0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D`     |
| Stake token (USDC)        | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`      | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`     |
| Vault controller delay    | `172800` seconds                                  | `172800` seconds                                 |
| OrchestratorV3            | `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`      | `0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f`     |
| Expected predecessor hook | `0x251d78fb6bBb4071995Bce74bAfC9E4168638622`      | `0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1`     |
| MultiAttestationVerifier  | `0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5`      | `0x9855a39aC5975069632e91160d8712CBfF19e864`     |
| MultiSendCallOnly         | `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B`      | not used                                         |

Runtime hashes pinned in lane 31:

- Base NRV2: `0x423e2a2183ecd538864079b6268f41957028c25514d1de57bd3d0e70fa6b9bd4`
- Base UPV3: `0x7636c79f0f46cf88c7122767e553264f1898fa253ea214f6a1c3187b0f0a4bcf`
- Staging NRV2: `0xd9d2f4b8bbca6fe26d7a0dfd7e0d6a6d63823ab2a1fe12971e752cf33dee72a0`
- Staging UPV3: `0x3125872c0996c6d79fc3ed080a1b85b0f6eeb1fd51d1003d517ea3053af5a8fa`
- Base and staging MultiAttestationVerifier:
  `0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a`
- Both current O3 deployments: `0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9`
- Base predecessor whitelist hook:
  `0x03d02863ed5eaa096d4089cb1e126681c0621d99409124f4af5be7ed83e341fe`
- Staging predecessor dispute hook:
  `0xfe6624ddbdcca7a2469af6ad6aecd50eda492aae017ad959093b3db1fd7f298a`

MAV mutable configuration is also exact: Base witnesses are
`[0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754, 0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD]`;
staging witnesses are
`[0x66649F896521b0fb487fE2077b4FBDA283d7f19a, 0x4ab950AE1e3326578Bf7e643a2031E858aBa2927]`.
Both thresholds are exactly `1`, with no additional witness.

The hashes above are raw deployed-runtime hashes. Constructor-immutable values
must also match the explicit getter checks in lanes 31 and 32. Runtime length
or a source version alone is insufficient bytecode evidence.

For every fresh dispute artifact, lane 32 requires the persisted compiler-input
hash to match the exact checked-out canonical extended artifact and compares
deployed runtime after masking only compiler-declared immutable slots. The
immutable getters are then checked separately. This prevents a deployment JSON
from self-attesting foreign bytecode.

## Base staging

### 1. Fix and approve the deploy-only SHA

From a clean worktree:

```bash
git fetch origin
git status --short
git rev-parse HEAD
git rev-parse origin/main
git diff --exit-code origin/main -- ':(glob)**/*.sol'
corepack yarn install --immutable
npx tsc --noEmit
node scripts/test-dispute-lifecycle-deployment.cjs
corepack yarn test
```

Record the exact candidate SHA, successful CI run, chain ID, RPC endpoint class,
deployer address, deployer balance, and a fresh block number/hash. Obtain an
explicit approval naming Base staging and that exact SHA.

### 2. Verify lane 31

Base staging was already hard-cut before this lane was introduced. At block
`49,793,275`, all ten routes pointed to staging UPV3, legacy writers were empty,
and NRV2 writers were exactly `[UPV3]`. The audited live method order was:

```text
zelle, monzo, alipay, chime, venmo, revolut, cashapp, wise,
mercadopago, paypal
```

Run lane 31 without a mutation flag. Its `skip` check performs the pinned
address, bytecode, immutable, owner, method-order, currency, route, and writer
reads. It fails closed if staging is no longer fully cut over.

```bash
corepack yarn hardhat deploy --network base_staging --tags V3PaymentBindingStack
```

There is intentionally no staging cutover flag. The registries are EOA-owned;
22 independent transactions would not be atomic. Any future staging drift needs
a separately reviewed recovery plan.

Staging also has a previously deployed chargeback stack, despite its current
artifacts having been intentionally removed from the package. At block
`49,793,681`, the live predecessor was:

| Contract                    | Address                                      |
| --------------------------- | -------------------------------------------- |
| ChargebackNullifierRegistry | `0xaDa339E7d3542ee636FA2cda6BFbFE5720F0EEF5` |
| ChargebackVerifier          | `0xd297CD116D7F6EFb807f855237A2EF72C0854579` |
| StakeVault                  | `0x224a45C65eB9A4D1dB00eD6Bfe21aD7Ec0a9b0E4` |
| ChargebackPolicy            | `0xC1E16Bf824fA7cee8770Fb72F49349091D4e583B` |
| IntentLifecycleHookV1       | `0xE8Fe714f848fAf7ecff7960AfD0C395771C22AA1` |

The current O3 is registered, unpaused, and points to that old hook. Its sole
historical intent was signaled with the old hook and then pruned; the old policy
has no admission, settlement, cancellation, release, or chargeback events, and
`getChargebackIntent` returns `NONE` for that intent. The old vault reports zero
staked, claimable, accounted, unaccounted, and USDC balance. The old dispute
registry has no nullifier events and its sole writer is the old policy. These
facts satisfy the current drain check, but they must be re-read immediately
before activation.

The old policy also emitted two settings-only events for EscrowV2 deposit `87`
(`true` at block `49,612,788`, then `false` at block `49,612,804`). That deposit
is now deleted: `getDeposit(87).depositor == address(0)`. The drain guard permits
this exact two-event history only while the canonical deposit remains an empty
tombstone, its method/intent arrays are empty, its ID is below the monotonic
deposit counter, and its later `DepositClosed` event remains present at block
`49,612,806` (tx `0xbd5a4c...937dc`). Any setting event for a live deposit is a
migration stop because the fresh policy defaults protection on.

### 3. Deploy and prepare lane 32 without activation

```bash
ENABLE_STAGING_V3_DISPUTE_DEPLOYMENT=true \
  corepack yarn hardhat deploy \
  --network base_staging \
  --tags V3DisputeLifecycleStack
```

The run may resume a recognizable prefix of the five deployments. Before it
mutates configuration, it validates every existing contract's code presence,
constructor dependencies, owner/pending owner, controller, writer set, and risk
windows. Unknown state stops the run.

Required result:

- fresh canonical artifacts for `DisputeNullifierRegistry`, `DisputeVerifier`,
  `StakeVault`, `DisputeProtectionPolicy`, and `IntentLifecycleHookV1`;
- policy is the sole dispute-nullifier writer;
- vault controller is the fresh policy;
- no vault controller handoff is pending and its validity timestamp is zero;
- the policy is unpaused and the fresh hook is its only authorized lifecycle
  hook;
- PayPal, Venmo, and Cash App read `14 days`; every other method reads `0`;
- all four owned contracts have the expected owner; the hook's immutable
  dependencies match the four-contract stack and current policies;
- O3 still points to predecessor hook `0xE8Fe...2AA1`.
- the fresh policy/registry have no lifecycle or nullifier history, and the
  fresh vault has no financial events, aggregate liability, unaccounted value,
  or USDC balance. Pre-staking before activation is not allowed in this rollout.

Commit only the five canonical staging artifacts to the contracts PR. Re-run
CI. Do not publish a package automatically.

### 4. Propagate and test the prepared addresses

Before activation:

- verify the predecessor hook's old intents and vault/nullifier liabilities are
  drained, or retain the predecessor stack until they are;
- export and review the package addresses without publishing absent separate
  approval;
- configure and deploy the indexer/curator consumers that are required to read
  the new contracts;
- verify the production-UPV3 attestation change is not accidentally used as
  proof of dispute-evidence support;
- exercise payment attestations for PayPal, Venmo, and Cash App against staging
  UPV3;
- record the explicit accepted limitation that the service cannot yet issue a
  `ZKP2P DisputeVerifier` `DisputeAttestation`.

### 5. Fix and approve the activation SHA

The artifact commit changes the candidate SHA. Re-run source, CI, onchain, and
predecessor-drain checks, then obtain a new explicit Base-staging approval for
that exact SHA.

Activate through the same lane:

```bash
ENABLE_STAGING_V3_DISPUTE_ACTIVATION=true \
CONFIRM_STAGING_V3_DISPUTE_DOWNSTREAM_READY=true \
CONFIRM_STAGING_V3_DISPUTE_PREDECESSOR_DRAINED=true \
  corepack yarn hardhat deploy \
  --network base_staging \
  --tags V3DisputeLifecycleStack
```

### 6. Staging postflight and E2E

Record every deployment/configuration/activation transaction hash and block.
Require:

- lane 31 remains ready;
- the five lane-32 addresses and dependency getters match their artifacts;
- ownership, writer, controller, authorization, and risk windows match step 3;
- O3 is registered, unpaused, and points to the fresh combined hook;
- a non-chargebackable method creates no dispute-protection state;
- each of PayPal, Venmo, and Cash App can complete the payment-proof path through
  UPV3 and creates the expected protected lifecycle state when collateral is
  available;
- cancellation and settlement callbacks reach the expected terminal/intermediate
  state;
- replay attempts fail through NRV2.

A successful service-generated dispute submission cannot be claimed until the
attestation service implements the dispute domain/type. If an authorized
staging witness and a reviewed fixture are separately approved, submit one
manual dispute attestation and verify the dispute nullifier plus vault claim;
otherwise record that leg as intentionally unavailable, not passed.

After activation and one more zero-liability/event check, retire only the old
policy surfaces: pause its admissions, deauthorize the old hook, and remove the
old policy from its dedicated old dispute registry. Do not unregister the
current O3, delete historical artifacts, repoint the old vault, or remove code.
The old vault may retain its historical controller while its balances and
liabilities remain zero.

## Base production

### 1. Production readiness and coordinated attestation release

Use separate exact-SHA production approvals. Before any contract mutation or
Safe submission:

- merge the attestation release-readiness PR with a merge commit; squash/rebase
  would discard its ancestry bridge;
- fast-forward `releases/prod` to the separately approved reviewed main SHA and
  prove `origin/main...origin/releases/prod` is `0 0`;
- build and validate the production Nitro release with the existing authorized
  SSH, signer certificate/key, KMS, PCR8, and deployment materials;
- prove the resulting service signs the UPV3 EIP-712 domain and that its signer
  remains an authorized MAV witness;
- stage the UPV3 service so it can become healthy without serving production
  payment traffic before the registry cutover;
- obtain separate authority for the production service deployment/traffic shift.

The current production service remains on a UPV2 build until this coordinated
release. Do not execute lane 31 first and hope to repair attestation afterward.

Read-only preparation snapshot from 2026-08-10:

| Coordinate                   | Audited value                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Attestation PR               | `zkp2p/attestation-service#314`                                                                    |
| Reviewed PR head             | `6b1428e5fabc363934cf0256ade623231e703ea9`                                                         |
| Main at review               | `edb65df882f6a12025a4149c9c4258f450aef6c5`                                                         |
| Production release at review | `a24695ae18488a8736314a9f1c4072c4077487ec`                                                         |
| Reconciliation commit        | `26deae48db50c33f6f9a899826a327a6ef5d9d82`                                                         |
| AWS account/region/AZ        | `207567755641` / `us-east-1` / `us-east-1a`                                                        |
| EC2                          | `i-04b954673dbc5ef5a`, `m5.2xlarge`                                                                |
| Public service               | `https://attestation-service.zkp2p.xyz`                                                            |
| Enclave slots                | blue CID `17` port `9443`; green CID `19` port `9543`                                              |
| Docker image / EIF           | EC2-local `zkp2p-attestation-prod:latest` / `/tmp/zkp2p-attestation-prod.eif`                      |
| Expected signer              | `0xe078d93bfdd87a8c5c5cca5905dcba0dd7a1f0bd`                                                       |
| Expected PCR8                | `41a4ae0b9b96752cab5addb7d22689b3070e564e29f90a54316fa33fa38ea51387a6e887ea4f5a4b0cc34f69cea3f40e` |
| KMS alias                    | `alias/zkp2p-attestation-prod-envelope`                                                            |
| KMS key                      | `arn:aws:kms:us-east-1:207567755641:key/3c2e4c90-e2ab-45f1-8ad8-f5660bbcef64`                      |

This release path is EC2/Nitro plus systemd, not ECS or CloudFormation. The
canonical image is built locally on the instance; there is no reviewed private
ECR image digest to deploy.

The audited PR worktree did not contain the existing production SSH key,
SSM-known-hosts file, or signer certificate/key. Do not deploy until those exact
materials are securely staged without rotation and the existing certificate
fingerprint `ad7afed11cd5c3faaa401eed48549431bf7e1d1d5ac11bf5dbb14825682e5acc`
and certificate/private-key public keys match. Missing material is a stop, not
authority to create or rotate it.

After the authorized merge-commit and release-branch fast-forward, the deploy
and verification surfaces are:

```bash
DEPLOY_ENV=prod bash deploy/nitro/scripts/infisical-deploy.sh
DEPLOY_ENV=prod bash deploy/nitro/scripts/verify-deployment.sh --json
DEPLOY_ENV=prod bash deploy/nitro/scripts/smoke-verify.sh
```

Require public provenance to report the exact approved merge SHA,
`releases/prod`, `dirty=false`, chain `8453`, verifying contract
`0xC6F4...502B`, the expected signer, and expected PCR8. Then run the standalone
Nitro verifier with `--expected-verifying-contract 0xC6F4...502B`, recover one
fresh authorized buyer signature and one seller signature, and reconfirm that
the signer is a witness on MAV `0x9Fe9...02d5`. Production credentials and any
money-moving E2E require separate authority.

The deploy is blue-green only until the nginx flip; after the flip the old
enclave is terminated. A post-flip rollback is therefore a reviewed roll-forward
release, not a hot slot flip. Do not use the UPV2 roll-forward after lane 31 has
executed; the contract migration itself is forward-only.

### 2. Generate and simulate lane 31

At the approved contracts SHA:

```bash
ENABLE_BASE_V3_PAYMENT_BINDING_CUTOVER=true \
  corepack yarn hardhat deploy \
  --network base \
  --tags V3PaymentBindingStack
```

This performs no direct Base writes. It must produce exactly 22 Transaction
Builder calls:

1. ten `PaymentVerifierRegistry.removePaymentMethod(bytes32)` calls in reverse
   live order: PayPal, Monzo, Zelle, Mercado Pago, Wise, Cash App, Revolut,
   Venmo, Chime, Alipay;
2. ten `addPaymentMethod(bytes32,address,bytes32[])` calls in original live
   order, all targeting UPV3 and preserving every audited currency array;
3. `NullifierRegistry.removeWritePermission(UPV1)`;
4. `NullifierRegistry.removeWritePermission(UPV2)`.

Before producing the batch, lane 31 must also prove chain ID `8453`, the exact
current O3 address/owner, O3 registration, `paused() == false`, and zero
`NullifierAdded` history on NRV2 while payment routes are still on UPV2. Any
NRV2 write before the route cutover invalidates the audited one-way starting
state and is a stop.

Calls 11-20 must contain the keccak256 hashes of these exact ordered currency
arrays; signers must decode and compare them rather than trusting call count:

| Method       | Ordered currencies                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alipay       | CNY                                                                                                                                                       |
| Chime        | USD                                                                                                                                                       |
| Venmo        | USD                                                                                                                                                       |
| Revolut      | USD, EUR, GBP, SGD, NZD, AUD, CAD, JPY, HKD, MXN, SAR, AED, THB, TRY, PLN, CHF, ZAR, CNY, CZK, DKK, HUF, NOK, RON, SEK                                    |
| Cash App     | USD                                                                                                                                                       |
| Wise         | USD, CNY, EUR, GBP, AUD, NZD, CAD, AED, CHF, ZAR, SGD, ILS, HKD, JPY, PLN, TRY, IDR, KES, MYR, MXN, THB, VND, UGX, CZK, DKK, HUF, INR, NOK, PHP, RON, SEK |
| Mercado Pago | ARS                                                                                                                                                       |
| Zelle        | USD                                                                                                                                                       |
| Monzo        | GBP                                                                                                                                                       |
| PayPal       | USD, EUR, GBP, SGD, NZD, AUD, CAD                                                                                                                         |

Safe UI must encode one atomic delegatecall to MultiSendCallOnly. Re-fetch the
Safe nonce immediately before proposal; the read-only audit saw nonce `69`.
Stale nonce-65 and nonce-66 proposals are invalid and must not be reused. Save
the generated JSON, decoded call table, simulation URL/result, file SHA-256,
Safe nonce, and preflight block/hash as release evidence.

Execute only after the UPV3 attestation release is ready for the coordinated
traffic cut. Expected event/state diff is exactly ten removals, ten additions,
and two legacy writer removals. Immediately verify all ten methods, order,
currencies, UPV3 routes, empty legacy writers, and sole NRV2 writer.

### 3. Deploy the fresh production dispute stack

This is a new production mutation boundary with its own exact-SHA and deployer
approval:

Before sending, require `getUnnamedAccounts()[0]` to be exactly
`0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929`, record its nonce and ETH balance,
and prove the loaded key is the separately approved production deployer key.
The governance Safe is the ownership destination, not the Hardhat transaction
signer.

```bash
ENABLE_BASE_V3_DISPUTE_DEPLOYMENT=true \
  corepack yarn hardhat deploy \
  --network base \
  --tags V3DisputeLifecycleStack
```

The deployer creates/configures the five fresh contracts. The plain dispute
registry transfers directly to the Safe. The three Ownable2Step contracts leave
the Safe as pending owner. The script must prepare, but never submit or execute,
exactly four Safe calls in this order:

1. `DisputeVerifier.acceptOwnership()`;
2. `StakeVault.acceptOwnership()`;
3. `DisputeProtectionPolicy.acceptOwnership()`;
4. current O3 `setLifecycleHook(fresh IntentLifecycleHookV1)`.

Commit only the five fresh canonical Base artifacts. Propagate addresses to the
package/indexer/curator/operational consumers and re-run CI/state checks before
requesting separate Safe-submission and Safe-execution approval.

The abandoned Base predecessor is historical and must not be restored as a
current alias:

| Contract                    | Historical Base address                      |
| --------------------------- | -------------------------------------------- |
| ChargebackNullifierRegistry | `0xBDA132867221802d78A47392264bB7D05FE35b48` |
| ChargebackVerifier          | `0x0fbf2c7ca3558125c73E0ab7C269eb7cf37454f4` |
| StakeVault                  | `0x57ec47d27FB0E1911C7d1813685C602C3C56Ff91` |
| ChargebackPolicy            | `0x2Ea164BBb11C709FCD46fE59340ce758AE553a5C` |
| IntentLifecycleHookV1       | `0x92362bC7bA3adf523ac4343ce495D4d8667973d0` |

Before any optional cleanup, re-prove that the old policy/DNR have no lifecycle
or nullifier events, the old vault totals/unaccounted balance/USDC balance are
zero, and no current O3 intent has snapshotted the old hook. With separate
mutation approval, defense-in-depth unlinking is exactly: pause old policy
admissions, deauthorize old hook `0x92362b...97d0`, then revoke old policy
`0x2Ea164...a5C` from old registry `0xBDA132...b48`. Keep the old code, event
history, and vault controller; do not accept its stale pending ownerships.

### 4. Production activation and postflight

Before Safe signing, require exact target/calldata/order, current Safe nonce,
successful atomic simulation, accepted ownership state, O3 pin/owner/registry/
unpaused/predecessor-hook checks, sole fresh dispute writer, three non-zero risk
windows, seven zero risk windows, and downstream acknowledgement.

After execution, re-run both lane readiness checks and record transaction,
events, addresses, owners, writers, controller, risk windows, O3 hook, balances,
and active-intent counts.

## Stop and recovery rules

Stop before signing or sending when chain ID, source/compiler-input SHA,
address, code hash, immutable, owner, pending owner, pending controller,
controller-valid-at, writer set/order, authorized-hook set, policy admission
state, fresh-stack activity/balance, O3 registry/fee/multi-intent configuration,
payment method order, currency array, route, Safe target/operation/nonce,
signer/PCR8, predecessor hook, registry membership, pause state, simulation, or
expected event diff does not match this runbook and the fresh preflight.

- Before lane-31 execution, abort with no state change.
- After lane-31 execution, recovery is forward-only. Never route a method back
  to UPV1/UPV2 because the legacy registry cannot observe NRV2 writes. Repair
  attestation/configuration, or deploy another verifier bound to NRV2, authorize
  it on NRV2, and atomically migrate forward.
- Before dispute activation, abandon a bad fresh stack and deploy a new canonical
  stack; do not repoint artifacts to a predecessor.
- After dispute activation, governance may restore the current whitelist hook
  for new intents. Existing intents retain their snapshotted dispute hook, so
  keep the fresh policy, vault, verifier, and writer authorization live until
  every intent and liability drains. A used stack is never reactivated by this
  lane. After drain, archive its five addresses and transactions as historical
  evidence, remove only its canonical-current aliases in a separately approved
  deployment worktree, deploy and propagate a second fresh canonical stack,
  then activate that stack with a new reviewed batch. Never delete or repoint
  the historical artifacts.
- Keep the old staging chargeback stack alive until its snapshotted intents,
  vault liabilities, and dispute-nullifier activity are proven drained. Only
  then may its admissions be paused, its old hook deauthorized, and its policy
  writer revoked.
- The abandoned production predecessor has no observed intents or vault balance
  at the audited block. Pausing the old policy, deauthorizing its old hook, and
  revoking its writer from the dedicated old dispute registry are optional
  hardening after a fresh zero-liability/event/O3-snapshot recheck; they are not
  part of lane 31 or the four-call activation batch.

Never delete historical executed Safe batches or active dependency artifacts.
Do not restore `Chargeback*` aliases, obsolete current-address exports, invalid
stale Safe proposals, or removed generated junk. Historical addresses remain
available through git and chain history, not through current package aliases.
