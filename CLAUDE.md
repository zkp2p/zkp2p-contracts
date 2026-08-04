# CLAUDE.md

## Project

ZKP2P contracts is the canonical Solidity 0.8.18 repository for the protocol's
on-chain escrow, orchestration, verifier, registry, policy, deployment, and npm
package artifacts.

Read `AGENTS.md` before acting. Treat deployment status as network-scoped:

- `EscrowV2` remains the shared escrow in the mounted V3 lifecycle lane.
  `OrchestratorV2` and `OrchestratorV3` are distinct current implementations;
  never infer which one is active from the version number alone.
- `deploy/31_deploy_v3_lifecycle_stack.ts` is mounted by
  `scripts/deployActive.ts` for `localhost`, `hardhat`, Base staging, and Base.
  Base execution is a separately approved whitelist-only deployment that queues
  one Safe registration for the fresh O3 and leaves existing orchestrators in
  place. Lane `32` remains staging-only.
- Source, tests, package ABIs, a mounted script, and checked-in artifacts are not
  proof of live state. Resolve registries, permissions, ownership, deployed
  bytecode, and on-chain wiring before stating what is active on either network.
- Verifier and nullifier cutovers are one-way. Never route a payment method back
  to a verifier whose replay domain cannot observe the current nullifier writes.
- V1 source and deployment artifacts are historical evidence, not an active
  development or compatibility lane. Never route new work through V1.

## Build and test

```bash
yarn
yarn compile
yarn build

# Foundry is the only contract test system.
yarn test
yarn test:deterministic
yarn test:fuzz
yarn test:invariant
forge test --match-path '<test-foundry/path>'

yarn coverage
```

Use the change-aware verification ladder in `AGENTS.md`. Start with the
smallest Foundry target that can disprove the changed invariant. Do not run a
clean build, the full suite, or coverage for documentation-only work.

## Architecture

The V2 flow remains relevant wherever current network state routes through
`OrchestratorV2`:

```text
maker -> EscrowV2.createDeposit
taker -> OrchestratorV2.signalIntent -> EscrowV2 locks funds
attestation-service -> EIP-712 payment attestation
OrchestratorV2.fulfillIntent
  -> PaymentVerifierRegistry resolves the network's configured verifier
  -> verifier validates the attestation and nullifies the payment
  -> EscrowV2 releases funds and fees
```

Important ownership boundaries:

- `EscrowV2` owns deposits, locking, and release.
- `OrchestratorV2` owns intent lifecycle and fee routing.
- `OrchestratorV3` owns the V3 intent lifecycle and snapshots the
  governance-selected `IIntentLifecycleHook` for each intent.
- `IntentLifecycleHookV1` composes whitelist admission with fail-closed
  lifecycle callbacks into `ChargebackPolicy`; `StakeVault`, the chargeback
  verifier, and its dedicated nullifier registry retain their separate
  accounting, proof, and replay boundaries.
- `PaymentVerifierRegistry` owns payment-method-to-verifier routing.
- `OrchestratorRegistry` and `EscrowRegistry` own allowed callers/systems.
- `NullifierRegistry` and `NullifierRegistryV2` are distinct replay domains.
  Never infer a safe rollback between them.
- `MultiAttestationVerifier` owns the configured witness threshold used by the
  current verifier wiring.
- `IntentGuardian`, `AddressGroupRegistry`, and `WhitelistPolicy` remain
  separately owned policy components. The V3 lifecycle lane reuses
  `WhitelistPolicy` through its lifecycle hook; do not collapse those ownership
  boundaries or redeploy a core stack merely to change policy.

`UnifiedPaymentVerifier` is both a Solidity implementation name and, in some
deployment lanes, the implementation behind the
`UnifiedPaymentVerifierV2` deployment artifact. Resolve source, deployment
name, artifact, address, registry routing, and nullifier permissions together;
do not reason from the name alone.

`OrchestratorV3` is not a textual V2 parity scaffold. It deliberately retains
the relayer-gated admission, escrow, fee, registry, and payment boundaries while
replacing the V2 deposit-whitelist-hook path with a snapshotted lifecycle hook
and fail-closed callbacks for signal, cancel/prune, fulfill, and manual release.
Review shared invariants and those explicit deltas separately.

## Code layout

```text
contracts/               Solidity source
  unifiedVerifier/       verifier implementations and bases
  interfaces/            interfaces
  registries/            registry contracts
  hooks/                 pre/post-intent hooks
  mocks/                 test support
test-foundry/
  deterministic/         focused success, revert, deployment, regression tests
  fuzz/                  input-space properties
  invariant/             stateful handlers and invariants
deploy/                  ordered Hardhat Deploy scripts
deployments/             network artifacts, parameters, Safe batches, outputs
scripts/                 deployment and release support
packages/contracts/      @zkp2p/contracts-v2 package
```

Do not embed file, contract, or artifact counts in agent guidance. Derive them
from the current checkout when they matter.

## Deployment source of truth

The active deployment runner is `scripts/deployActive.ts`, which mounts the
current `deploy/*.ts` files. Inspect every mounted script, its `skip` behavior,
network guard, dependencies, and matching tests before a deployment claim.

Current numbered lanes include:

- `00`-`13`: original system and payment-method scripts retained as deployment
  history/current mounted files;
- `14`-`22`: V2 system, periphery, payment methods, oracle, and redeployments;
- `23`: whitelist pre-intent hook redeployment;
- `24`: `MultiAttestationVerifier` deployment and V2 verifier wiring;
- `25`: generic Zelle payment-method configuration;
- `27`: legacy Zelle method removal;
- `28`: `IntentGuardian`;
- `29`: V2 whitelist policy.
- `30`: V3 lifecycle stack for local, Hardhat, and Base staging only.

There is no `26` script. Numbered files are identities, not proof that every
script should execute. Deployment is a separately approved mutation for the
exact network, source SHA, and governance/deployer path.

Use:

```bash
yarn deploy:localhost
yarn deploy:base_staging
yarn deploy:base
yarn etherscan:base_staging
yarn etherscan:base
```

Only run a live command after the `ship-contracts` boundary for that exact
action is approved.

## Package boundary

```bash
yarn pkg:extract
yarn pkg:build
yarn workspace @zkp2p/contracts-v2 verify:release
```

Source ABI exports and network address/runtime exports are different contracts.
The package intentionally exports V3 source ABIs and current Base-staging
lifecycle addresses while Base production may have no corresponding active V3
address. Never invent a zero address, copy a staging address into Base, publish
an inactive address as active, or remove an ABI merely because the contract is
not deployed on every network.

Any publication must use
`.agents/skills/zkp2p-contracts-publish/SKILL.md`; never publish locally or
request an OTP/token.

## Skills

| Skill | Use |
| --- | --- |
| `.claude/skills/audit/SKILL.md` | Read-only full, differential, or focused security review |
| `.claude/skills/ship-contracts/SKILL.md` | Separately approved source, staging, production, export, and release boundaries |
| `.agents/skills/zkp2p-contracts-publish/SKILL.md` | Trusted-workflow RC/stable package release |

## Style

- Solidity: four-space indentation, explicit visibility, custom errors where
  appropriate, and NatSpec on external functions.
- TypeScript: strict mode, CommonJS, and existing `@utils`/`@typechain` aliases.
- Tests: `*.t.sol` under the smallest applicable Foundry layer.
- Deploy scripts: two-digit prefix and concise verb-noun name.
- Commits: conventional prefixes where practical.

Never commit secrets, edit generated artifacts by hand, infer live state from a
stale artifact, add rollback compatibility, or combine source, staging,
production, package, and publication approval into one implied action.
