# Orchestrator V4 Base production release

Status, 2026-10-29:

- The passive seven-contract suite is deployed on Base (see below).
- The four-call activation batch for Safe nonce 87 has been handed to the
  signers. It has not executed, so O4 is not registered.
- The UPV3 writer revoke remains a separate, later transaction.

Each step below is its own approval boundary (see
`.claude/skills/ship-contracts/SKILL.md`).

## Deployment (executed 2026-10-29)

The deploy ran from `526f81d2ea53f2045b821931b21f7b7e8f15a2c4`, with CI green
(Complete Foundry suite and Release readiness) on that exact SHA.

- **Deployer:** `0x41123d6419C7b8e44157f6F3b0088442116641eC`, nonces 133–145,
  13 confirmed transactions, blocks 53251251–53251289.
- **Config hash:** `9b3e56c1…4512`.
- **State:** the suite is passive. O4 is not registered, and no shared registry,
  route or writer changed.

| Contract | Address | Deploy tx |
| --- | --- | --- |
| StakeVaultV2 | `0x4aDE08EC1098D0d8856dd7bbBBc7789794089A97` | `0x3ef9b7c5…ea22` |
| AddressGroupRegistryV4 | `0xDcafc54E4fb47B1d41ADD08dd82142a30ec4706E` | `0xc7a433db…10a2` |
| WhitelistPolicyV2 | `0xF7069D157D1AFb2CbE117e24f4262aE51eeD390c` | `0xdfa2da0d…839f` |
| IntentSignalPolicy | `0x572f1Eb9043a7217C998221D6d3BCfb3D69338cC` | `0x93ca8f6f…f994` |
| DisputeProtectionPolicyV2 | `0xB49Fa38C6Bb3C8C51ddb13711BB213cDD9DB1799` | `0xac51f76e…6283` |
| OrchestratorV4 | `0x74c55679268FAfB493864915aD16A320AB8c40Ba` | `0x80694325…0393` |
| ProtocolViewerV4 | `0x685123dB5fE2b88D00ED3764c088d600D9B2b6Fc` | `0xb26b8f4e…d0f5` |

`prepare-governance` ran at block 53251399 and recorded the acknowledgement of
1507 public private deposits (checked at block 53251338). The batches were
rendered for Safe nonce 87:

- **Activation:** safeTxHash `0xa09c600337986d8095fd800f6ebd9c36ea684721b56c4b1a8d423b9af58a59b0`
  via MultiSendCallOnly `0xA1da…102B`, or
  `0xd5d697dcacb8d4718d39b54a4e0d1fa094b340939af9c7307a7a9e0b375be8bc` via
  `0x40A2…130D`. Both matched the live Safe's `getTransactionHash`.
- **Rollback:** a direct call at nonce 88, safeTxHash
  `0xa18405c2bed0afd7d3193167ebad72296b4497a6566de0a2cb9a0d76687c70e1`.

Source verification: Basescan auto-verified all seven contracts as similar
matches of identical earlier deployments. Six of those are staging-suite
contracts. StakeVaultV2 matched `0xa33d…Fb4e` and DisputeProtectionPolicyV2
matched `0x3C53…94b1`. Each source contract carries the same compiler metadata
(IPFS) hash as our runtime, so Basescan shows our exact source; it just does not
display our constructor arguments.

The runner's `verify-source` requires an exact match with constructor arguments,
so it stopped at StakeVaultV2 (`Explorer source verification failed`).
`hardhat verify --force` got `already verified` back from Etherscan, which does
not re-verify through the API. The exact-match check lives in
`scripts/verify-orchestrator-v4-source.ts`, a protected deployed path, so it was
not changed after the deploy. `verification.sources` stays unrecorded.

An anvil fork at block 53251436 ran both through `execTransaction` with
impersonated owners:

- **Activation:** ExecutionSuccess, 176,449 gas. O4 was registered, O3 was
  unchanged, the vault, policy and O4 were owned by the Safe, and the DPPV2
  writer was added. NRV2 writers and all 13 routes were unchanged.
- **Rollback:** ExecutionSuccess, 69,010 gas. O4 was paused.

## Decisions

- O3 (`0x0140…b5c7`) stays registered and unpaused while clients migrate. O4 is
  added next to it.
- New O4 deposits start public. The fresh `WhitelistPolicyV2` has nothing
  enabled, so every existing private deposit on the O3 whitelist policy is
  public through O4. Base records this with the same exact-count
  acknowledgement staging used.
- The UPV3 `NullifierRegistryV2` writer revoke is not part of this release. The
  O4 batch never contains it, and every Base check accepts writers `{UPV4}` or
  `{UPV3, UPV4}`.
- The V1 orchestrator `0x8888…10D0` is registered and unpaused but unused. Base
  does not gate on it and has no drain checkpoint.

## What the runner does on Base

`scripts/deploy-orchestrator-v4.ts` keeps base_staging behaviour unchanged
(config hash `554cb2fd…a729`, the same 32 activation calls). On `base`:

- It adopts the lane-47 UPV4 `0x7bE5…2048` from its pin. It never deploys it,
  adds methods to it, transfers it, or saves a Hardhat record for it, and it
  checks the pin against `deployments/base/UnifiedPaymentVerifierV4.json`.
- It deploys seven contracts in this order: StakeVaultV2, AddressGroupRegistryV4,
  WhitelistPolicyV2, IntentSignalPolicy, DisputeProtectionPolicyV2 (then
  `setController`), OrchestratorV4 (then `setSignalPolicy` and
  `setSettlementPolicy`), and ProtocolViewerV4. Then it transfers ownership of
  the vault, the policy and O4 to the Safe. The vault and the policy are
  two-step, so the Safe accepts them in the batch. O4 is single-step.
- Preflight accepts each route on UPV3 or UPV4, and NRV2 writers `{UPV4}` or
  `{UPV3, UPV4}`.
- `prepare-governance` builds the batch from a live snapshot. It emits route
  steps only if some route is off UPV4, and never emits a payment-writer grant
  or revoke.
- The signer key is `BASE_DEPLOYER_KEY`. A key that derives a retired deployer
  (`0x84e1…1929`) is refused, and so is a configured signer or governance in
  `RETIRED_DEPLOYERS`.

## Configuration (`deployments/orchestrator-v4/base.json`)

Every value was read on-chain at Base block `53247430` and checked again by
`inspect` at block `53248324`.

| Field | Value | Source |
| --- | --- | --- |
| `signer` | `0x41123d6419C7b8e44157f6F3b0088442116641eC` | current deployer, nonce 133, 0.039 ETH |
| `governance` | `0x0bC26FF515411396DD588Abd6Ef6846E04470227` | Safe 1.3.0, 2 of 2, no guard, no modules, nonce 87 |
| `gatingService` | `0x7aCe8cF3cb5fEa7103594dA6C6478e69fD7717a4` | new prod O4 gating key (EOA, nonce 0) |
| `existing.PredecessorWhitelistPolicy` | `0x389Cd9bA91FfFcd83d267B241E975541892759Ce`, codehash `0xa83d138a…85a4`, tx `0x82940c1c…c58c`, block 50528043 | live O3 hook `0x5Dd6…0031`.`whitelistPolicy()` |
| `existing.UnifiedPaymentVerifierV4` | `0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048`, codehash `0xa2f9051e…1269`, tx `0xa6fa…f931`, block 53210472 | lane 47; owner Safe, 13 methods in PVR order |
| `legacyDrainCheckpoints` | `[]` | no Base drain |
| `legacyWhitelistCheckpoint` | `{ indexedBlock: 50528042, enabled: [] }` | the block before the predecessor policy existed |
| `baselineBlock` | `53247430` | verification block |

The whitelist checkpoint is a genesis checkpoint. Discovery replays the
predecessor policy's full `EnabledUpdated` history, so no reviewed row list is
needed and nothing can be missed. The cost is about 2,700 log windows and about
6,500 reads per run. Base runs them 16 at a time, so one discovery takes several
minutes.

All 13 routes already point to UPV4. NRV2 writers are `[UPV3, UPV4]`.
DisputeNullifierRegistry writers are `[0xbF4B…e4Fc]`. The Safe owns all four
mutable registries.

## Private deposits that become public

At block `53247430` the predecessor policy had 2,546 enabled
(escrow, deposit, method) tuples across 2,446 deposits. 936 of those deposits
are deleted, which leaves 1,510:

- 1,168 on EscrowV2 `0x7777…00Ef`;
- 342 on the V1 Escrow `0x2f12…8888`. O4 cannot lock these: V1 Escrow only
  accepts its own orchestrator. The discovery still counts them.

The fork rehearsal at block `53248571` discovered **1509**. The live count is
whatever `prepare-governance` discovers at run time.

The predecessor policy is owned by `0xC754a6BcA8caDbF982CAe85d497CDe517DDE8a11`,
not the Safe. Ownership moved there from `0x84e1…1929` at block `52926983`. The
runner does not gate on it, but that owner should be confirmed.

## Commands

The deploy recorded `sourceCommit = 526f81d2ea53f2045b821931b21f7b7e8f15a2c4`.
Every later runner action (`prepare-governance`, `verify`, `verify-source`) and
every `o4:safe-batches` command checks release provenance:

- `526f81d` must be an ancestor of HEAD, so #362 must land on main as a merge
  commit, never a squash or a rebase.
- Every protected release path must be byte-identical to `526f81d`.
- The checkout needs full Git history; a shallow clone cannot see `526f81d`.

Run these commands from a clean, full checkout of the #362 merge commit, checked
out detached. A later main commit that touches a protected path, such as
`contracts/` or `hardhat.config.ts`, fails provenance. That includes re-rendering
the rollback at a new nonce, so keep the merge commit available for emergencies.
`o4:safe-batches` also requires the manifest to match the pinned deployment
(addresses, deploy transactions, nonces, source commit and config hash).

```sh
# 0. Read-only preflight (no key)
HARDHAT_CONFIG=hardhat.readonly.config.ts yarn deploy:orchestrator-v4 base inspect

# 1. Deploy the seven contracts (approval: Base deploy; key 0x4112 only)
BASE_DEPLOYER_KEY=<0x4112 key> HARDHAT_CONFIG=hardhat.canonical.config.ts \
  yarn deploy:orchestrator-v4 base deploy

# 2. Basescan source verification (no key). Run it before Basescan auto-similar-matches the
#    new addresses; once a similar match exists, Etherscan rejects exact re-verification.
ETHERSCAN_API_KEY=<key> HARDHAT_CONFIG=hardhat.readonly.config.ts \
  yarn deploy:orchestrator-v4 base verify-source

# 3. Record the private-deposit acknowledgement and the unsigned batch (no key).
#    A deliberately wrong count (e.g. 999999999) fails with "discovered N"; without
#    the variable the error lists every deposit instead.
O4_BASE_ACCEPT_PUBLIC_PRIVATE_DEPOSITS=<N> HARDHAT_CONFIG=hardhat.readonly.config.ts \
  yarn deploy:orchestrator-v4 base prepare-governance

# 4. Render, check and simulate the Transaction Builder batches at the live Safe nonce
yarn o4:safe-batches render --safe-nonce <nonce>
yarn o4:safe-batches verify --safe-nonce <nonce>
BASE_FORK_RPC_URL=<rpc> HARDHAT_CONFIG=hardhat.base-fork.config.ts HARDHAT_NETWORK=hardhat \
  yarn o4:safe-batches simulate --safe-nonce <nonce>

# 5. After the Safe executes the activation batch (no key)
HARDHAT_CONFIG=hardhat.readonly.config.ts yarn deploy:orchestrator-v4 base verify
```

The manifest is written to `deployments/outputs/orchestrator-v4-base.json`. The
batches go to `deployments/outputs/safe-batches/base_o4_{activation,rollback}.json`,
each with a `.sha256.json` sidecar. Commit them in a recording PR after step 4.

The Safe has no delegates, so the Transaction Service rejects API proposals.
Import the Transaction Builder JSON in Safe{Wallet} instead.

The privacy acknowledgement is checked when `prepare-governance` runs, not when
the Safe executes. A deposit made private on the O3 policy after that point is
public through O4 once the batch executes. So the last step before the final
signer executes is `simulate` at the live nonce: its active `verifySuite` runs
discovery again. If that fails on a newly private deposit, run
`prepare-governance` with the new N and render again. The calldata and the
safeTxHash do not change, so existing signatures stay valid; only `createdAt` and
the description change. A race of minutes remains.

After activation, `verify` fails if any deposit becomes private on the O3 policy
after the last recorded acceptance. Nothing can record a new acceptance once O4
is registered: `prepare-governance` requires O4 to be unregistered, and `verify`
refuses an acknowledgement. That is intended behaviour, but it needs a decision:
either accept that `verify` fails, or add a dated follow-up acknowledgement.

`simulate` forks Base and checks the Safe's runtime, version, guard, modules,
owners, threshold and nonce. It compares the on-chain `getTransactionHash` with
the off-chain hash. Then it impersonates the two owners: one `approveHash`, then
`execTransaction` with sorted `v = 1` signatures. It requires `ExecutionSuccess`
and runs the runner's active `verifySuite` on the fork. Finally it executes the
rollback as a direct call at nonce + 1.

## Expected activation batch

With today's state (every route on UPV4) the batch is four calls, all with value
0:

| # | Target | Call |
| --- | --- | --- |
| 1 | StakeVaultV2 (fresh) | `acceptOwnership()` |
| 2 | DisputeProtectionPolicyV2 (fresh) | `acceptOwnership()` |
| 3 | DisputeNullifierRegistry `0xA845615b5203F7a21321DdF5e3a1ca024D93a443` | `addWritePermission(DisputeProtectionPolicyV2)` |
| 4 | OrchestratorRegistry `0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9` | `addOrchestrator(OrchestratorV4)` |

`render` prints the safeTxHash for both MultiSendCallOnly deployments: Transaction
Builder's `0x40A2…130D` and `0xA1da…102B`, which Safe{Wallet} used for the UPV4
cutover. Signers must match the hash their wallet shows against one of them.
Safe nonce 87 may be taken first by another queued batch, such as
`base_one_hour_intent_expiry.json`. In that case, render again at the new nonce.

## Rollback

`base_o4_rollback.json` is one call, `OrchestratorV4.pauseOrchestrator()`. The
Safe{Wallet} sends a single call directly (operation 0), and `render` prints
that hash too. It pauses O4 only. O3, the routes and the writers are untouched,
and O4 stays registered.

Once O4 is registered, never run the lane-47 UPV4 rollback
(`base_upv4_rollback.json`, which routes back to UPV3) while O4 is unpaused.
UPV3 cannot serve O4:

- O4 has no `getDepositPreIntentHook`, so UPV3 treats it as a V1 orchestrator
  and decodes the wrong intent layout.
- The attestor signs O4 proofs only under the UPV4 domain.

Every O4 fulfil would revert. Pause O4 first with `base_o4_rollback.json`.

## Fork rehearsal (2026-10-29)

Run with `BASE_FORK_RPC_URL=… yarn test:orchestrator-v4-base-fork` from `e3b4d8c`
plus the Safe tooling, at fork block `53248571`. It uses the real `base.json`,
with only the signer replaced by a Hardhat fixture key on the fork.

- Preflight passed. The seven contracts deployed, and UPV4 and its record were
  untouched.
- `prepare-governance` discovered 1509 private deposits and recorded the
  acknowledgement.
- The batch was exactly the four calls above.
- `execTransaction` succeeded (gas 176,449). On the fork, the off-chain
  safeTxHash for nonce 87 matched `getTransactionHash`.
- The active `verifySuite` passed with UPV3 still a writer.
- The rollback `execTransaction` paused O4 (gas 69,010), and O3, the routes and
  the writers stayed unchanged.

The run took about 33 minutes, most of it the two privacy discoveries. The
addresses and hashes are fork-only.

## Staging after this merge

This branch changes the runner (an execution path) and merges main's
`hardhat.config.ts` (a deployed path, from #372). The staging manifest pins
source `0749b75` and tools `a723af5`, so staging `verify` no longer passes
provenance from main. Re-verify staging from `69dbf0d` if needed. Staging
behaviour itself is unchanged.

## Not part of this release

Each of these is separately approved:

- the UPV3 writer revoke (`base_upv4_upv3_writer_removal.json`);
- the package export of the O4 addresses;
- downstream client, attestor and curator rollout;
- relayer allowlists;
- group creation on the fresh `AddressGroupRegistryV4`.
