# UPV5 cutover: NullifierRegistryV3, UnifiedPaymentVerifierV5, DisputeVerifierV2

Status: not started. Staging first, then Base production.

| Item | Link |
| --- | --- |
| Contracts | [zkp2p-contracts#395](https://github.com/zkp2p/zkp2p-contracts/pull/395) |
| Deploy lane, scripts, this runbook | [zkp2p-contracts#396](https://github.com/zkp2p/zkp2p-contracts/pull/396) |
| Attestation service | [attestation-service#771](https://github.com/zkp2p/attestation-service/pull/771), pinned at `74ed5a97` |
| Pay | [pay#1688](https://github.com/zkp2p/pay/pull/1688) |
| Curator | [curator#1195](https://github.com/zkp2p/curator/pull/1195) |
| Indexer | [zkp2p-indexer#334](https://github.com/zkp2p/zkp2p-indexer/pull/334) |
| zkp2p-clients SDK | [zkp2p-clients#2675](https://github.com/zkp2p/zkp2p-clients/pull/2675) |
| Staging `@zkp2p/contracts-v2` RC | _TBD_ |
| Base `@zkp2p/contracts-v2` RC | _TBD_ |

Each step below is its own approval boundary (`.claude/skills/ship-contracts/SKILL.md`). Nothing in this repo
signs or sends a production transaction on its own.

## What changes

- **NullifierRegistryV3** stores `nullifier → intentHash` only, so one payment can consume several nullifiers.
  `isNullified` falls through to NullifierRegistryV2 (and from there to NullifierRegistry), and intent lookups fall
  through to NullifierRegistryV2. Pre-cutover payments stay spent, and V2-era payments keep their intent bindings.
- **UnifiedPaymentVerifierV5** takes `abi.encode(PaymentDetails, IntentSnapshot, settlementData, bytes32[] nullifiers)`
  and writes each nullifier to V3 exactly as signed. Its EIP-712 domain is `("UnifiedPaymentVerifier", "1")` at
  UPV5's own address.
- **DisputeVerifierV2** takes dispute data `abi.encode(DisputeDetails, bytes32[] nullifiers)`.
  `DisputeDetails.originalPaymentId` is the raw payment-ID hash, as in DisputeVerifier. The TEE signs a set of
  candidate nullifiers. The dispute binds if any candidate is bound to the intent in V3, which falls back to
  NullifierRegistryV2, and otherwise reverts `InvalidPaymentBinding`. Its domain is `("ZKP2P DisputeVerifier", "1")`
  at its own address.

### Design decision: the contract does not derive the nullifier

UPV5 deliberately does not require `keccak256(abi.encodePacked(method, paymentId))` to appear in the signed list.
This is Kartik's decision; do not re-raise it in review.

- The TEE computes both the settlement nullifiers and the dispute candidates from one function, the value UPV4
  derived on-chain.
- Pay's KMS signer uses the same formula.
- Both are tested against the shared golden vector (see the gate below).

## Tooling

| Command | What it does |
| --- | --- |
| `yarn deploy:upv5:<network>` | Lane 49 (`deploy/49_deploy_unified_payment_verifier_v5_stack.ts`), tagged, with its `ENABLE_*` flag. Deploys the three contracts, adds every UPV4 payment method to UPV5, hands ownership to governance, then exports the deployment output and extracts the package. It changes no writer, route or dispute policy. |
| `yarn verify:upv5:<network>` | Basescan source verification of the three contracts. |
| `yarn upv5:postconditions <network> [--pre]` | 16 read-only checks, pinned to one block. `--pre` lists what is not yet true and exits 0; without it, any failure exits 1. |
| `yarn upv5:staging-cutover [--execute]` | Base staging cutover as direct transactions from the staging signer. A dry run by default. |
| `yarn write:upv5-safe-batch` / `yarn verify:upv5-safe-batch` | Render, or re-derive byte for byte, `deployments/outputs/safe-batches/base_upv5_cutover.json` and its sha256 sidecar from the Base records. |
| `yarn upv5:safe-batches hash <nonce>` | MultiSend data keccak and safeTxHash for a Safe nonce. |
| `yarn upv5:safe-batches preflight` | Read-only. Checks live Base still matches what the batch assumes, then runs the whole batch as one transaction from the Safe (an `eth_call` with MultiSendCallOnly's code at the Safe's address). |

Both deploys use signer `0x41123d6419C7b8e44157f6F3b0088442116641eC` (`STAGING_DEPLOYER_KEY` on staging,
`BASE_DEPLOYER_KEY` on Base; see the [UPV4 runbook](upv4-base-production-cutover.md#deployer)). The retired signer
`0x84e1…1929` must never sign; config loading and lane 49 both refuse it. RPC defaults: hardhat uses
`ALCHEMY_API_KEY`; the read-only scripts take `--rpc <url>` or `BASE_RPC_URL` / `STAGING_RPC_URL`.

What the 16 postcondition checks compare against:

- Bindings come from the lane 49 records and pins, never from the live UPV4 or old DisputeVerifier, so later changes
  to those cannot fail a check.
- The two "Cutover-time" checks compare UPV5's and DisputeVerifierV2's current attestation verifiers with the
  recorded bindings. They are meant for the cutover, not as permanent invariants: governance may later rotate a
  verifier with `setAttestationVerifier`.
- Routine untagged lane 49 runs check only the bindings that cannot change (V3's predecessor, UPV5's registries,
  DisputeVerifierV2's registry) plus governance ownership. For attestation verifiers they only require a nonzero,
  deployed contract.
- "Catalog equals the plan" compares method set, order and currencies. On Base the plan is
  `UPV4_BASE_RELEASE.paymentRoutes`; on staging it is the journal the cutover script writes.

### Catalog freeze, on both networks

On Base staging, from `yarn deploy:upv5:base_staging` until `yarn upv5:staging-cutover --execute` finishes, make no
`PaymentVerifierRegistry` change: no `addPaymentMethod`, `removePaymentMethod`, `addCurrencies` or
`removeCurrencies`. On Base, freeze the same calls from `yarn deploy:upv5:base` until the Safe batch executes.

UPV5 copies UPV4's catalog when it deploys, and the Base batch re-adds exactly the 13 routes and currencies pinned in
`UPV4_BASE_RELEASE.paymentRoutes`. After the cutover the add-method lanes (35, 41, 43) follow the routes and add to
UPV5.

### Package addresses

The package exports the latest addresses, not activation status. Before a network records UPV5, the package exports
zero addresses for `NullifierRegistryV3`, `UnifiedPaymentVerifierV5` and `DisputeVerifierV2` there whenever the
other network has them. Consumers treat zero as missing; attestation-service, Pay, Curator and the clients SDK already
do.

## Gate before each cutover

Check both items immediately before the staging cutover (S3) and again before the Base batch (P3/P4).

1. **The attestation-service build is pinned** to an exact #771 commit, currently `74ed5a97`. The enclave image you
   will deploy must come from that commit, and Pay's KMS signer from pay#1688 at its reviewed commit.
2. **The golden vector is identical.** Compare
   `test-foundry/fixtures/upv5-golden-vector.json` with both copies in attestation-service at the pinned commit:

   ```bash
   C=~/Documents/zkp2p/zkp2p-contracts/test-foundry/fixtures/upv5-golden-vector.json
   A=~/Documents/zkp2p/attestation-service
   git -C "$A" fetch origin
   for f in src/unified/__tests__/fixtures/upv5-golden-vector.json \
            package/zkp2p-attestation/tests/golden/upv5-golden-vector.json; do
     diff <(jq -S . "$C") <(git -C "$A" show 74ed5a97:"$f" | jq -S .) && echo "identical: $f"
   done
   ```

   Each `diff` must print nothing. `jq -S` sorts keys and normalises formatting; the copies currently differ only in
   whitespace, and their content must not differ at all.

## Cross-repo order

Run this order once on staging, then again on Base.

1. **Merge source.** zkp2p-contracts#395 and #396 merge to `main`. Lane 49 is tag-gated, so merging deploys
   nothing.
2. **Deploy the contracts** with lane 49 (below).
3. **Record and publish.** Open a recording PR with the three `deployments/<network>/*.json` records and the
   regenerated `deployments/outputs/*Contracts.ts`. After it merges, Kartik publishes a `@zkp2p/contracts-v2` RC
   through the trusted `publish-contracts-v2` workflow (`.agents/skills/zkp2p-contracts-publish/SKILL.md`, npm
   passkey approval).
4. **Bump consumers to the RC.**
   - **Who:** Curator (curator#1195), Pay (pay#1688) and the clients SDK (zkp2p-clients#2675). Each keeps UPV4
     behaviour until UPV5 is selected for its environment, so these can ship ahead of the cutover.
   - **Indexer:** deploy it with the new addresses (zkp2p-indexer#334) so it already watches UPV5 `PaymentVerified`
     and V3 `NullifierAdded`.
   - **attestation-service (#771):** build it and approve the enclave now, but do not deploy it.
   - **Staging:** #771 must not reach staging until the staging cutover script has finished. Staging's attestation
     generation is hard-coded to UPV5.
   - **Preprod** (Base phase only): preprod Curator, Pay and Peer Verify settle on the production contracts through
     the production attestor, so they follow the Base phase. Preprod Curator needs the verifier list V5 + V4 at the
     prod cutover. Pay preprod uses the `base` records.
5. **Pass the gate** above.
6. **Pause and protect** (Base: required; staging: recommended):
   - pause Pay support manual KMS releases and relayer fulfils;
   - extend every intent that would expire inside the window (step 8). Use EscrowV2 `extendIntentExpiry` through
     the guardian relayer, with the `intent-guardian` skill.
7. **Cut over**: the staging script, or the Base Safe batch.
8. **Deploy attestation-service, then Pay and Curator (and on Base the preprod services), back to back**, selecting
   UPV5. From the cutover until the attestor runs UPV5, fulfils fail: the routes point at UPV5 but proofs are still
   signed for UPV4.
   - **Window length:** tens of minutes. The attestor rollout includes the enclave deploy and the parent approval.
   - **Proofs in flight:** a proof signed for UPV4 before the cutover and submitted after it also fails; the client
     must request a new one.
9. **Validate** (list below), then resume relayer fulfils and manual releases.

## Staging phase

Base staging governance is the staging signer EOA, so the cutover is direct transactions.

### S1. Deploy

```bash
git fetch origin && git checkout <approved main SHA>
yarn install --immutable && yarn compile
yarn deploy:upv5:base_staging
yarn verify:upv5:base_staging
yarn upv5:postconditions base_staging --pre
```

Lane 49 reads the constructor inputs from the live predecessors and asserts them against `UPV5_BASE_STAGING_RELEASE`
(`deployments/parameters.ts`):

| Contract | Constructor |
| --- | --- |
| NullifierRegistryV3 | `(NullifierRegistryV2 0x2eb4…778C)`, the registry UPV4 writes |
| UnifiedPaymentVerifierV5 | `(OrchestratorRegistry 0xfA63…6d8A, V3, MultiAttestationVerifier 0x9855…e864)`, read from UPV4 |
| DisputeVerifierV2 | `(staging signer as owner, V3, MultiAttestationVerifier 0x9855…e864)`, DisputeVerifier `0x9735…C708`'s verifier |

It then adds all 14 UPV4 methods to UPV5. On staging, governance is the deployer, so no ownership moves. An
interrupted run resumes from its records; the deployment output is exported only when the run succeeds.

Expected pre-check: `11/16 true`. The five TODOs are the cutover checks: NullifierRegistryV2 writers, V3 writer,
routes, catalog plan (no journal yet) and dispute verifier.

### S2. Record, publish, bump consumers

Cross-repo steps 3 and 4. The recording PR contains:

- `deployments/base_staging/{NullifierRegistryV3,UnifiedPaymentVerifierV5,DisputeVerifierV2}.json`;
- `deployments/outputs/baseStagingContracts.ts`.

### S3. Gate, then cut over

Pass the gate, then:

```bash
yarn upv5:staging-cutover                      # dry run: prints every call, simulates, prints the pre-check
yarn upv5:staging-cutover --execute            # STAGING_DEPLOYER_KEY
yarn upv5:postconditions base_staging          # must exit 0: 16/16
```

The script sends, in order:

1. `NullifierRegistryV2.removeWritePermission(w)` for every live writer, read with `getWriters()`.
2. `NullifierRegistryV3.addWritePermission(UPV5)`.
3. `PaymentVerifierRegistry.removePaymentMethod` for every route from the tail, then `addPaymentMethod(method, UPV5,
   currencies)` in the original order. The registry has no update call, and this keeps the order and currencies.
4. `DisputeProtectionPolicyV2.setDisputeVerifier(DisputeVerifierV2)`.

Writers go first, so NullifierRegistryV2 stops accepting writes before V3 accepts any. Each removed route is
unroutable until its re-add, one to two minutes across the 28 route transactions.

Safety rules:

- **Start conditions:** the script refuses to start unless every deployment check passes, the signer owns
  NullifierRegistryV2, the registry and the policy, and UPV5 supports every planned method.
- **Journal:** it writes its plan to `deployments/outputs/upv5-cutover-base_staging.json` before the first
  transaction, because a removed route loses its currencies on-chain. A rerun resumes from the first call the chain
  does not reflect, and stops if the state is not a prefix of the plan.
- **Lost journal:** without a journal it plans only from an untouched state. NullifierRegistryV2 must still have
  writers, V3 none, every route on UPV4, the policy on the old DisputeVerifier, and the registry's method set equal
  to UPV4's. Otherwise a crash after some removals plus a lost journal would silently drop methods.
- **Record it:** commit the journal in a recording PR afterwards.

### S4. Deploy services and validate

Cross-repo steps 8 and 9. Deploy #771 to staging only now.

## Prod phase

Base governance is Safe `0x0bC26FF515411396DD588Abd6Ef6846E04470227`.

### P1. Deploy

```bash
git fetch origin && git checkout <approved main SHA>
yarn install --immutable && yarn compile
yarn deploy:upv5:base                          # BASE_DEPLOYER_KEY
yarn verify:upv5:base
yarn upv5:postconditions base --pre
```

| Contract | Constructor |
| --- | --- |
| NullifierRegistryV3 | `(NullifierRegistryV2 0x5455…aeB)` |
| UnifiedPaymentVerifierV5 | `(OrchestratorRegistry 0xBe9f…82A9, V3, MultiAttestationVerifier 0x9Fe9…02d5)` |
| DisputeVerifierV2 | `(Safe 0x0bC2…0227 as owner, V3, MultiAttestationVerifier 0x9Fe9…02d5)`, DisputeVerifier `0x30d4…2f34`'s verifier |

DisputeVerifierV2 is owned by the Safe from construction: it has no deployer-only setup, so there is nothing to
accept and no window where the deployer owns it. After adding the 13 methods, the lane calls
`transferOwnership(Safe)` on NullifierRegistryV3 and UPV5. Both are single-step `Ownable`, so the Safe owns them at
once.

Expected pre-check: `12/16 true`. The catalog-plan check already passes against the pins. The four TODOs are
NullifierRegistryV2 writers, V3 writer, routes and dispute verifier.

### P2. Record, publish, bump consumers

The recording PR contains:

- `deployments/base/{NullifierRegistryV3,UnifiedPaymentVerifierV5,DisputeVerifierV2}.json`;
- `deployments/outputs/baseContracts.ts`.

Then publish the RC and bump consumers, including preprod (cross-repo step 4).

### P3. Build, check and propose the Safe batch

```bash
yarn write:upv5-safe-batch                     # from the Base records; commit the JSON and sidecar
yarn verify:upv5-safe-batch
yarn upv5:safe-batches preflight
yarn upv5:safe-batches hash <Safe nonce>       # compare data keccak and safeTxHash with the Safe UI
```

`base_upv5_cutover.json` is one atomic transaction of 30 calls:

| # | Target | Call |
| --- | --- | --- |
| 0–1 | NullifierRegistryV2 `0x5455…aeB` | `removeWritePermission` UPV3 `0xC6F4…502B`, UPV4 `0x7bE5…2048` |
| 2 | NullifierRegistryV3 | `addWritePermission(UPV5)` |
| 3–15 | PaymentVerifierRegistry `0x2b82…Eb1e` | `removePaymentMethod` monobank, xmoney, upi, paypal, monzo, zelle, mercadopago, wise, cashapp, revolut, venmo, chime, alipay |
| 16–28 | PaymentVerifierRegistry | `addPaymentMethod(method, UPV5, currencies)` alipay … monobank, with the currencies pinned in `UPV4_BASE_RELEASE` |
| 29 | DisputeProtectionPolicyV2 `0xB49F…1799` | `setDisputeVerifier(DisputeVerifierV2)` |

An independent review ran this batch through the real Safe on a fork at about 1.63M gas.

The four legacy August dispute policies (DisputeProtectionPolicy, OptIn, MethodScoped, MethodScopedStaked) are not
in this batch; that decision is separate. Upload the JSON in the Safe UI's Transaction Builder. If the UI wraps the
calls with a different MultiSendCallOnly than the repo default `0x40A2…130D`, only the target and the safeTxHash
change. The data keccak must match.

`preflight` fails unless all of these hold:

- every deployment postcondition passes: bindings, owners, V1 and V3 writers, every routed method supported;
- the live catalog (methods, order, currencies) equals the pins, and every route is on UPV4;
- NullifierRegistryV2's writers are exactly UPV3 and UPV4;
- the policy still selects DisputeVerifier `0x30d4…2f34`;
- the registry, NullifierRegistryV2 and the policy are owned by the Safe;
- all 30 calls succeed as one transaction from the Safe.

If that last simulation reverts, preflight also simulates each independent call alone and names the ones that
revert.

**Optional guard.** For extra protection, a guard contract that re-checks the pinned state on-chain could head the
batch, as lanes 38 and 40 did. It is not built here; the preflight simulation, the freeze and the Safe signers'
review stand in for it.

### P4. Gate, pause, execute, deploy services, validate

1. Pass the gate.
2. Pause Pay support manual KMS releases and relayer fulfils, coordinated with the Pay owner. Anything signed for UPV4
   in the window reverts once the routes move, and a half-submitted manual release is harder to recover than a
   delayed one.
3. Extend intents that would expire in the next hour or so, through the guardian relayer (`intent-guardian` skill).
4. Run `yarn upv5:safe-batches preflight` immediately before execution, then execute the Safe transaction.
5. Run the post-check; it must show 16/16:

   ```bash
   yarn upv5:postconditions base
   ```

6. Deploy attestation-service (enclave plus parent approval), then Pay, Curator and the preprod services. All
   select UPV5.
7. Validate. Make validation item 3 (one supervised KMS manual release) the first release after the pause, then
   resume relayer fulfils and manual releases.

## Validation

Run on staging after S4 and on Base after P4. For each fulfil, expect a UPV5 `PaymentVerified` event and a V3
`NullifierAdded(nullifier, intentHash, UPV5)` in the same transaction, where
`nullifier == keccak256(abi.encodePacked(method, paymentId))`.

1. **Buyer TEE fulfil**: a fresh intent fulfilled with a buyer-side attestation.
2. **Seller SAR / auto-release fulfil**: a fresh intent released from the seller side.
3. **Pay support KMS manual release**: a Pay manual release signed by the support KMS key.
4. **Replay of a pre-cutover payment**: run the Base fork test rather than a live attempt. The real attestor ties
   the payment timestamp to the intent, so it will not sign an old payment for a new intent.

   ```bash
   BASE_FORK_RPC_URL=<Base RPC> forge test --match-path test-foundry/fork/NullifierRegistryV3BaseFork.t.sol
   ```

   `test_UPV5OnV3RejectsAPayloadReplayingTheLiveNullifier` takes a live NullifierRegistryV2 nullifier and shows
   UPV5 on V3 rejecting it with `Nullifier has already been used`.
5. **Non-payment dispute and email dispute on a post-cutover payment**: both reach DisputeProtectionPolicyV2 through
   DisputeVerifierV2. Each has a candidate set containing the nullifier V3 bound to the intent, and both bind.
6. **Dispute on a pre-cutover hold**: the candidate set contains the payment's V2 nullifier. V3 falls back to
   NullifierRegistryV2, finds it bound to the intent, and the dispute binds.
7. **Binding edge cases**:
   - A dispute whose candidate set includes the nullifier bound to the intent, among others that are not, binds.
   - A dispute where no candidate is bound to the intent reverts `InvalidPaymentBinding`.
8. **Indexer**: shows UPV5 `PaymentVerified` events and V3 nullifiers.

Also watch the fulfil success rate, attestor and Pay signer errors, and the rate of `UPV: Invalid attestation`,
`UPV: No nullifiers`, `Nullifier has already been used` and `InvalidPaymentBinding` reverts.

## Rollback

The cutover is one-way: rollback means fixing forward. NullifierRegistryV2 cannot see what is written to V3.

Example: on Base, a $500 Venmo payment settles through UPV5 after the cutover, and V3 records its nullifier. If the
routes then went back to UPV4, UPV4 would check only NullifierRegistryV2, find nothing, and the same Venmo proof
could release a second $500 from another deposit. Routing back to UPV4 reopens payment replay.

- **An exact undo is allowed only if all of these hold:**
  - no UPV5-domain attestation has been issued yet, so the attestor and Pay have not switched to UPV5;
  - relayer fulfils and support releases are still paused;
  - V3 has no writes.

  The undo re-adds the removed NullifierRegistryV2 writers, routes every method back to UPV4 and points the policy
  back at DisputeVerifier. On Base it is a new Safe batch; none is prebuilt.

  Check V3's logs from the cutover block up to the block the undo will execute at, both when preparing it and
  immediately before executing it:

  ```bash
  cast logs --address <V3> 'NullifierAdded(bytes32,bytes32,address)' --from-block <cutover block> --to-block latest
  ```

  If any write has slipped in, do not undo; roll forward.
- **Otherwise, fix forward.** Pause what is broken and deploy a corrected verifier that writes V3, then re-route to
  it. Never give a NullifierRegistryV2 writer back its route.
- **The dispute side is separate.** Pointing the policy back at DisputeVerifier reopens no replay, because dispute
  nullifiers live in their own registry. It would, however, fail every dispute on a post-cutover payment, since
  DisputeVerifier reads only NullifierRegistryV2.
- **The UPV4 rollback batch is retired.** It now lives at `safe-batches/superseded/base_upv4_rollback.json` and
  must never run after this cutover.

## Evidence

The specs are `scripts/upv5-*.spec.cjs` (`yarn test:upv5-release`). They pin the release addresses and lock:

- lane 49's constructor inputs, ownership, resume and refusal paths, against a mocked chain;
- the staging call order, its resume rule and the lost-journal refusal;
- every postcondition, including catalog drift;
- the 30-call Base batch against placeholder addresses, including swap-and-pop order preservation, the absence of
  the legacy dispute policies and the single-transaction simulation request.

Fork rehearsals on a local anvil fork of Base are summarised in #396.
