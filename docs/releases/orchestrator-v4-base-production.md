# Orchestrator V4 Base production release

Status, 2026-10-29: the deploy tooling and `deployments/orchestrator-v4/base.json`
are ready. Nothing is deployed on Base, and no transaction has been sent or
proposed. Each step below is its own approval boundary (see
`.claude/skills/ship-contracts/SKILL.md`).

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

Run every command from a clean checkout of the merged main commit. The deploy
records `sourceCommit = HEAD`, and later actions require the protected paths to
be unchanged.

```sh
# 0. Read-only preflight (no key)
HARDHAT_CONFIG=hardhat.readonly.config.ts yarn deploy:orchestrator-v4 base inspect

# 1. Deploy the seven contracts (approval: Base deploy; key 0x4112 only)
BASE_DEPLOYER_KEY=<0x4112 key> HARDHAT_CONFIG=hardhat.canonical.config.ts \
  yarn deploy:orchestrator-v4 base deploy

# 2. Basescan source verification (no key)
ETHERSCAN_API_KEY=<key> HARDHAT_CONFIG=hardhat.readonly.config.ts \
  yarn deploy:orchestrator-v4 base verify-source

# 3. Record the private-deposit acknowledgement and the unsigned batch (no key).
#    Run once without the variable or with a wrong count to read "discovered N".
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
