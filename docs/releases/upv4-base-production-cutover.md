# UnifiedPaymentVerifierV4 Base production cutover

Status: prepared, not executed. Each numbered step is its own approval boundary
(see `.claude/skills/ship-contracts/SKILL.md`). Approving one step does not
approve the next.

UPV4 ships to Base production before OrchestratorV4. On Base, O4 stays
unregistered and UPV4 serves the live OrchestratorV3 through its V2
`getDepositPreIntentHook` probe (`test_OrchestratorV3FulfilsThroughUPV4`). The
Base V1 orchestrator is unused and plays no part in this release.

## Pinned Base state

Read at Base block `53209611` on 2026-10-28 and pinned in
`UPV4_BASE_RELEASE` (`deployments/parameters.ts`). Lane 47 re-reads all of it at
one block and stops on any difference.

| Contract | Address | State |
| --- | --- | --- |
| Safe (2 of 2) | `0x0bC26FF515411396DD588Abd6Ef6846E04470227` | owns every contract below |
| PaymentVerifierRegistry | `0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e` | 13 methods, 72 currency entries, all on UPV3 |
| NullifierRegistryV2 | `0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB` | writers `[UPV3]` |
| OrchestratorRegistry | `0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9` | O3 registered |
| MultiAttestationVerifier | `0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5` | threshold 1 |
| UnifiedPaymentVerifierV3 | `0xC6F4a193576C60892a47e111Bb5706c30162502B` | current verifier |
| OrchestratorV3 | `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7` | live orchestrator |
| Deployer | `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` | `BASE_DEPLOY_PRIVATE_KEY` |

Method order: alipay, chime, venmo, revolut, cashapp, wise, mercadopago, zelle,
monzo, paypal, upi, xmoney, monobank.

Source: UPV4 compiled from main has the same 9,048-byte runtime and compiler
metadata hash as staging UPV4 `0x7Da43ba0F85cfb64733216C4A2288f80dFfe1EAb`,
which has served staging since block 53201742. Lane 47 checks this before
deploying.

## 0. Preconditions

- The release PR is merged. The exact main SHA has a green complete Foundry
  suite and a green `Release readiness` run (`AGENTS.md`, "PR Feedback Versus
  Release Readiness").
- The deployer has enough ETH for one deployment, 13 `addPaymentMethod` calls
  and one `transferOwnership`. On 2026-10-28 it held 0.0000399 ETH.
- You run from a clean checkout of that SHA, with `.env` holding
  `BASE_DEPLOY_PRIVATE_KEY` and `ALCHEMY_API_KEY`.

## 1. Deploy lane 47

Approval: Base production deployment of lane 47 at `<sha>` with the production
deployer.

```bash
ENABLE_BASE_UPV4_DEPLOYMENT=true \
CONFIRM_BASE_UPV4_RELEASE_READY_SHA=<sha> \
yarn deploy:upv4:base
```

The lane:

1. checks the pinned state, the exact SHA (HEAD, clean worktree), the chain,
   the deployer, and the staging metadata match;
2. deploys `UnifiedPaymentVerifierV4(OrchestratorRegistry, NullifierRegistryV2,
   MultiAttestationVerifier)`;
3. adds the 13 methods to UPV4's own catalog in registry order;
4. calls `transferOwnership(Safe)`. UPV4 is single-step `Ownable`, so no
   `acceptOwnership` is queued;
5. writes three Safe Transaction Builder batches, each with a `.sha256.json`
   sidecar, under `deployments/outputs/safe-batches/`;
6. runs `hardhat export` and extracts the package, so
   `deployments/outputs/baseContracts.ts` gains `UnifiedPaymentVerifierV4`.

The lane changes no registry, route or writer. A rerun at the same SHA resumes a
partial run: it adds missing methods in order and transfers ownership. Once
everything matches, a rerun skips.

Then:

```bash
yarn verify:upv4:base                  # Basescan source verification
yarn verify:upv4-safe-batches          # re-derive and decode all three batches
yarn safe:propose-chunks --file deployments/outputs/safe-batches/base_upv4_cutover.json
                                       # dry run: plans and simulates from the Safe; never add --propose here
```

Decode every batch and compare it with the table below before multisig handoff.
Open a recording PR with:

- `deployments/base/UnifiedPaymentVerifierV4.json`;
- `deployments/outputs/baseContracts.ts`;
- the three batches and their sidecars;
- a lane-47 entry in `deployments/immutableDeploymentLanes.ts` (sha256 and
  `deployedSourceSha`);
- the lane-47 status line in `AGENTS.md` and `CLAUDE.md`.

## 2. Export the package with the Base UPV4 address

Approval: package export, then separately RC publication through
`.agents/skills/zkp2p-contracts-publish/SKILL.md`. Never publish locally.

Once the record is committed, `yarn pkg:build` emits a `UnifiedPaymentVerifierV4`
entry in `addresses/base.json` and `abis/base/UnifiedPaymentVerifierV4.json`. The
package exports the latest address; it does not say whether routes are active.
The UPV3 entry stays, because UPV3 is still routed until step 4 and remains the
rollback target.

## 3. Ship the route-aware attestor and Pay support signer to production

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

## 4. Execute the cutover Safe batch

Approval: Safe proposal, then Safe execution. Propose at the live Safe nonce,
which was 86 on 2026-10-28. Run `--propose` only once proposal is approved.

`base_upv4_cutover.json` holds 27 calls, run atomically in one MultiSend:

| # | Target | Call |
| --- | --- | --- |
| 0 | NullifierRegistryV2 | `addWritePermission(UPV4)` |
| 1–13 | PaymentVerifierRegistry | `removePaymentMethod` monobank, xmoney, upi, paypal, monzo, zelle, mercadopago, wise, cashapp, revolut, venmo, chime, alipay |
| 14–26 | PaymentVerifierRegistry | `addPaymentMethod(method, UPV4, currencies)` alipay … monobank, with the same currencies |

The registry removes by swap-and-pop. Removing in reverse and re-adding in order
keeps the order. UPV3 stays an NRV2 writer, so the rollback works. A proof
signed for UPV3 just before the flip and submitted after it fails, and the
client must re-request it.

## 5. Monitor

- Every route points at UPV4:
  `cast call 0x2b82…eB1e 'getVerifier(bytes32)(address)' <method>`.
- NRV2 writers are `[UPV3, UPV4]`.
- UPV4 emits `PaymentVerified` and UPV3 stops emitting it.
- Fulfil success rate, attestor and support-signer error rates, and the rate of
  `UPV: Invalid attestation` and `Nullifier has already been used` reverts.

## 6. Revoke the UPV3 writer later

Approval: a separate Safe proposal and execution after a stable soak.

`base_upv4_upv3_writer_removal.json` is one call:
`NullifierRegistryV2.removeWritePermission(UPV3)`. It is prepared now but not
scheduled. After it executes, the rollback batch cannot run until UPV3 is added
back as a writer.

## Rollback

Approval: Safe execution of the prepared rollback.

`base_upv4_rollback.json` holds 26 calls. It removes all 13 routes in reverse
order and re-adds them on UPV3 in the original order, with the same currencies.
It changes no writer. It is valid only while UPV3 is still an NRV2 writer, which
is true until step 6.

The route-aware signers follow the route back to UPV3 by themselves. Replay
protection holds across the switch, because UPV3 and UPV4 write one shared
replay domain: `keccak256(method, paymentId)` in NullifierRegistryV2. The fork
test below shows a payment nullified by either verifier is rejected by the
other.

After a rollback, UPV4 is still an NRV2 writer, but no route points at it.
Lane 31's live check expects UPV3 to be the only writer, so untagged Base runs
fail closed until governance resolves that.

## Evidence

The fork test
`test-foundry/fork/UnifiedPaymentVerifierV4BaseCutover.t.sol` runs with
`BASE_FORK_RPC_URL` and skips without it. It forks Base at block `53209611`,
deploys UPV4 as the deployer, and runs the exact batch bytes from
`yarn upv4:safe-batches ffi` as the Safe. It then checks:

- every route and writer;
- an O3 fulfil through UPV4 with a fork-only witness;
- cross-verifier replay rejection in both directions;
- the rollback, followed by an O3 fulfil through UPV3.

`yarn upv4:safe-batches plan` prints the address-free decoded plan. Its golden
copy is `deployments/upv4-base-release-plan.json`.
