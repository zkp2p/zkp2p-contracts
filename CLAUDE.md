# CLAUDE.md

## Project

ZKP2P contracts is the canonical Solidity 0.8.18 repository for the protocol's
on-chain escrow, orchestration, verifier, registry, policy, deployment, and npm
package artifacts.

Read `AGENTS.md` before acting. Treat deployment status as network-scoped:

- `EscrowV2` remains the shared escrow in the mounted V3 lifecycle lane and
  `OrchestratorV3` is the current orchestrator source. `OrchestratorV2` is
  archived under `contracts/archive/`: it left the Base `OrchestratorRegistry`
  on 2026-08-27 and is still registered on Base staging. Never infer which
  deployment is active from a version number alone.
- `deploy/30_deploy_v3_lifecycle_stack.ts` is mounted by
  `scripts/deployActive.ts` for `localhost`, `hardhat`, Base staging, and Base.
  Base execution is a separately approved whitelist-only deployment that queues
  one Safe registration for the fresh O3 and leaves existing orchestrators in
  place. Lane `31` is frozen; its mounted wrapper is verification-only on live networks.
- Source, tests, package ABIs, a mounted script, and checked-in artifacts are not
  proof of live state. Resolve registries, permissions, ownership, deployed
  bytecode, and on-chain wiring before stating what is active on either network.
- Verifier and nullifier cutovers are one-way. Never route a payment method back
  to a verifier whose replay domain cannot observe the current nullifier writes.
- V1 source and deployment artifacts are historical evidence, not an active
  development or compatibility lane. Never route new work through V1. V1
  sources live in `contracts/archive/`.
- `contracts/archive/` holds superseded sources that stay compiled only because
  executed lanes deploy them on local networks and tests exercise them. Never
  edit them or base new work on them; `contracts/archive/README.md` lists what
  is there and what deliberately is not.

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
yarn test:smoke
forge test --match-path '<test-foundry/path>'

yarn coverage
```

Use the change-aware verification ladder in `AGENTS.md`. Start with the
smallest Foundry target that can disprove the changed invariant. Do not run a
clean build, the full suite, or coverage for documentation-only work.

## Architecture

The V2 flow remains relevant wherever current network state still routes
through the archived `OrchestratorV2`:

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

- `OrchestratorV4` is OrchestratorV3 plus deferred settlement, and is not a proxy.
- `DisputeProtectionPolicyV2` and `IntentLifecycleHookV2` serve only OrchestratorV4; OrchestratorV3 keeps `DisputeProtectionPolicy` and `IntentLifecycleHookV1`.
- `UnifiedPaymentVerifierV4` returns signed extension bytes without decoding them and serves both OrchestratorV3 and OrchestratorV4.
- `EscrowV2` owns deposits, locking, and release.
- `OrchestratorV2` owns intent lifecycle and fee routing.
- `OrchestratorV3` owns the V3 intent lifecycle and snapshots the
  governance-selected `IIntentLifecycleHook` for each intent.
- `IntentLifecycleHookV1` composes whitelist admission with fail-closed
  lifecycle callbacks into `DisputeProtectionPolicy`; `StakeVault`, the dispute
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
  archive/               superseded sources, still compiled for executed lanes and tests
  unifiedVerifier/       verifier implementations and bases
  interfaces/            interfaces
  registries/            registry contracts
  hooks/                 pre/post-intent hooks
  mocks/                 doubles that deploy lanes or Hardhat deployment tests load, and Safe-batch guards
test-foundry/
  mocks/                 test doubles used only by Foundry tests
  deterministic/         focused success, revert, deployment, regression tests
  fuzz/                  input-space properties
  invariant/             stateful handlers and invariants
  smoke/                 opt-in, environment-gated cross-repo tests excluded from coverage
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
- `29`: V2 whitelist policy (immutable, still mounted);
- `30`: V3 lifecycle stack (immutable; mounted through its active wrapper);
- `31`: immutable V3 payment-binding history; mounted wrapper verifies live networks and delegates local deployment;
- `32`: dispute lifecycle stack (immutable, retired) and the unrelated
  deposit-creation guard;
- `33`: IntentGuardian fee update;
- `34`: opt-in dispute stack (immutable, retired; its Base trio was superseded by lanes 39/40);
- `35`: Mercury payment method (Base staging only);
- `36`: `WhitelistPolicyMethodScoped` (immutable, executed on both networks,
  still mounted behind its canonical-record skip);
- `37`: method-scoped dispute lifecycle stack (immutable, executed on both
  networks; retired on live networks, mounted through a localhost-only
  wrapper);
- `38`: method-scoped dispute activation via vault rotation (immutable,
  retired unexecuted on Base; superseded by lanes 39/40);
- `39` (immutable): method-scoped stack on a dedicated `StakeVaultMethodScoped`
  (deploy-only on live networks; deploys and activates locally);
- `40` (immutable): dedicated-vault activation (tag-only; staging EOA steps,
  one guarded Base cutover batch, deferred predecessor writer removal);
- `41`: generic UPI/INR payment method (tag-only, Base staging only);
- `42` (immutable): dispute risk-window retirement (tag-only on live networks;
  zeroes the `RETIRED_DISPUTABLE_PAYMENT_METHODS` windows on the lane-39
  policy; Base executed via the Safe 2026-08-28, staging via the deployer
  2026-09-02; still mounted, skips while every retired window reads zero).
- `43`: Base-staging-only X Money payment-method preparation and execution.
- `44` (immutable): `FxRateStore` plus the INR/USD and CNY/USD `FxRateFeed`s. It
  is one shared feed set on Base and skips `base_staging`. On Base it runs only
  under its tag with `ENABLE_BASE_FX_RATE_FEEDS_DEPLOYMENT=true`. It seeds both
  feeds, then hands ownership to `MULTI_SIG.base`. It was executed on Base on
  2026-10-01 from `88be796` and is still mounted; tagged reruns only verify.

- `45`: cascade stack and O4 deploy-only preparation, retargeted in source and not executed on either
  network. Deploys zero-delay `StakeVaultV2`, `DisputeProtectionPolicyV2`, `IntentLifecycleHookV2`,
  UPV4 and O4; sets O4's HookV2, matches O3's other configuration and hands ownership to the Safe on Base. O4 remains
  unregistered. Only the pinned superseded staging UPV4 address/runtime may be deleted and redeployed at
  a fresh address; pre-cutover binding checks use that pin independently of the mutable record.
  Historical staging deployment: 2026-10-11 from `f9eab7f`; replacement stake-owner trio: 2026-10-13 from
  `285bc5c`, with UPV4 unchanged. The first trio is abandoned, with no protected intent, stake or live permission.
- `46`: cascade activation, retargeted in source and not executed on either network. O3 keeps its August
  hook on Base/local; staging restores it first. Adds the cascade dispute writer, routes all methods to
  fresh UPV4, makes it the sole NRV2 writer and registers O4 last. Existing dispute writers remain passive.
  Every PENDING stale-policy intent blocks verifier rotation and later actions, regardless of stake mode.
  The cascade policy protects stake-token settlements with a nonzero attested window; it has no per-method
  windows, admissions pause, or per-deposit opt-out. Lanes 45/46 neither configure nor verify those removed fields.
  Staging order is lane 45 (reports stale intents), lane 46 `ENABLE_` with both `CONFIRM_` flags, then
  lane 46 `PREPARE_` expecting `active`; keep one build and avoid untagged runs until recording merges.
  Downstream readiness means new-domain UPV4 attestations with a 448-byte payload and signed extension
  words for both orchestrators and O4 client
  routing. RelayerRegistry is shared across orchestrators. Base emits an unsigned guarded atomic batch
  ending in `addOrchestrator(O4)`, with no O3 call; the postcondition runs only in the fork simulation.
  Historical activation: 2026-10-12 from `a6970aa` (32 actions); replacement activation: 2026-10-13 from
  `285bc5c` (add writer, switch O3 hook, remove abandoned writer). The two replacement runs took ten
  transactions, nonces 16340–16349; block 52531092 reduced to `active`. Their temporary executor was
  deleted and the lanes then restored to `314298e`, before this cascade retargeting. The August writer,
  UPV4 and all 14 routes/currencies/order were unchanged. Base has executed neither lane.
  Recording must save the five fresh records and address/runtime pins, update the committed-record test
  when staging UPV4's JSON changes, restore staging aliases/evidence/predecessor identities to main's
  August O3 selection, regenerate outputs with the O4 stack by name and update docs. Base records pins
  after lane 45 before lane-46 preparation and flips `BYPASS_PAYMENT_BINDING_RECORDED.base` after activation.
  Canonical aliases describe O3; O4 uses `StakeVaultV2` and its other records by name. Current staging
  aliases/evidence remain bypass until recording; local aliases are MethodScopedStaked. Each live step,
  recording PR and later RC publication needs separate approval. Restart localhost before a second full deploy.

There is no `26` script. Numbered files are identities, not proof that every
script should execute. A numbered script is immutable after any production
execution; successors get the next unused lane and new deployment names, and
retirement lives in `deployments/immutableDeploymentLanes.ts`. Deployment is a
separately approved mutation for the exact network, source SHA, and
governance/deployer path.

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
The package exports the currently selected (latest) addresses for each network,
and consumers treat them as the addresses to use. It does not export activation
status or rollout timing; operators complete rollout only after every multisig
executes. Never invent a zero address, copy a staging address into Base, or
remove an ABI merely because the contract is not deployed on every network.

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

## Code Style

Follow the precision rules in [AGENTS.md](AGENTS.md#coding-style--naming-conventions).

### UPV4 return compatibility

UPV4 accepts the same 448-byte `abi.encode(PaymentDetails, IntentSnapshot)` payload as UPV3,
followed by optional signed extension bytes. The entire `data`, including the extension, is
covered by `dataHash` and witness signatures. UPV4 returns the extension untouched and uninterpreted.
Extension fields occupy dedicated 32-byte words: word 0 is `disputeWindow` (uint256 seconds),
word 1 is the attested `conditionsHash`, and words 2+ are reserved and ignored by the current hook.
Non-manual HookV2 settlement requires a complete word 0 (`MissingDisputeWindow()` otherwise),
rejects windows above 365 days with `InvalidDisputeWindow(window)`, and treats zero as pay now.
A missing complete word 1 reads as zero. O4 settlement payloads are at least 480 bytes, or 512 bytes
with conditions. The 448-byte prefix and opaque UPV4 return remain unchanged for O3.
Attestors must sign seconds in word 0; the former balance-funded boolean no longer has that meaning.

The fully static result preserves the V1 `success`, `intentHash`, `releaseAmount` prefix,
then returns the uncapped `attestedReleaseAmount`, verified `PaymentDetails`, and signed/validated
`IntentSnapshot`. Dynamic extension bytes are a separate
trailing return value; unsigned metadata is never returned. O3 reads the V1 prefix with or without
extension bytes. O4 forwards the raw extension and opaque `intent.data` saved before pruning to
its snapshotted IntentLifecycleHookV2. The hook is stateless by design: per-intent data lives only in O4,
and the hook interprets it because governance can replace hooks for future intents while O4
is not upgradeable. Manual release forwards the saved data and an empty extension; the hook skips the
attestation comparison and extension validation and returns pay now without calling the policy.

IOrchestratorV4 keeps V3's `Intent` field order with `postIntentHook` removed entirely:
`owner, to, escrow, depositId, amount, timestamp, paymentMethod, fiatCurrency, conversionRate, payeeId, referralFees, data`.
`SignalIntentParams` keeps V3's fields in order except `postIntentHook`;
`FulfillIntentParams` keeps V3's fields except `postIntentHookData`. O4 has no post-intent-hook execution.
`data` is the opaque lifecycle hook payload and is stored only in `Intent.data`. Non-empty data requires
a mounted lifecycle hook (`LifecycleHookDataRequiresHook`) and a deposit payment-method gating service
(`LifecycleHookDataRequiresGatingService`). O4 appends `keccak256(data)` to the gating message; empty
data preserves the plain V3 packed message byte-for-byte. Read it through `getIntent(intentHash).data`
until pruning; there is no separate hook-data mapping or getter. Fees are unchanged. The net payout goes
to the lifecycle hook's deferral vault or directly to `intent.to`. Settlement preserves O3's order:
escrow unlock, protocol/referral/manager fee transfers, lifecycle hook, then net payout. O4 passes the
depositor and token read before unlock to the hook, so settlement works even when escrow deletes an
exhausted deposit. The policy does not read escrow at settlement. UPV4 checks O4's ERC-165 interface
before the V2 probe and decodes `IOrchestratorV4.Intent`; O3 and older decode paths stay unchanged.
ProtocolViewerV2 is unchanged and decodes only the V2/V3 `Intent` layout, so it cannot serve O4 intents;
read O4 intents directly with `OrchestratorV4.getIntent`.

IntentLifecycleHookV2 is stateless. At signal, a deposit's enabled whitelist is a pure admission gate:
non-members are rejected, and nonzero conditions require a gating service. Signal never calls the
policy or checks the deposit token, hook authorization, or a risk window. Cancellation is an unrestricted
no-op, retained for future hooks; O4 still invokes the snapshotted callback on cancel, escrow prune and
orphan cleanup.

`SettlementContext` is `{ intentHash, token, depositor, taker, recipient, escrow, depositId, paymentMethod,
releaseAmount, netAmount, data, extensionData, isManualRelease }`. O4 reads intent fields before pruning:
`taker = intent.owner`, `recipient = intent.to`, and `data = intent.data`; `depositor = deposit.depositor`
and `token = address(deposit.token)` come from its pre-unlock deposit read. The hook retains escrow/depositId
for whitelist checks and passes depositor/token and the intent identities and amounts to the policy's
`onIntentSettled(SettleParams)`, including the attested `uint64 riskWindow` and `bypass` set only for
whitelisted takers. A whitelisted taker means the deposit/payment-method whitelist is enabled and
`isTakerAllowed` returns true for the taker, not the recipient. Registered relayer takers follow the same
rule: relayer registration alone does not bypass collateral. The hook does not query the relayer registry;
O4 still uses it for its own admission gating. Whitelist state is read live at settlement. Disabling it or
removing the taker after signal restores collateral for nonzero windows. Manual release and window zero
return pay now without calling the policy; zero-window settlement still validates conditions.

Lanes 45/46 use bypass batch manifest version 6, which omits fresh-policy windows and admissions pause.
Historical O3 predecessor checks remain separate; old manifest versions are rejected.

DisputeProtectionPolicyV2 has no signal/cancel records, per-method windows, admissions pause, or
per-deposit opt-outs. It uses the supplied depositor and token without reading escrow. A non-stake-token
deposit pays now with no record or policy event. Whitelist bypass emits `DisputeProtectionIntentSettled`
with source `BYPASS` and no storage writes. Otherwise the policy snapshots the attested window, locks gross
stake (`STAKE`) or defers the net payout (`DEFERRED_PAYOUT`), and sets `releaseEligibleAt = now + window`.
It rejects windows above its `MAX_RISK_WINDOW` (365 days) as defence in depth. Statuses remain `NONE`,
`AWAITING_FUNDING`, `SETTLED`, `RELEASED`, and `DISPUTED`. Collateral ordinals remain `NONE=0`, `BYPASS=1`,
`STAKE=2`, `DEFERRED_PAYOUT=3`; `MANUAL_RELEASE` is removed. The settled event includes all participant
identities, method, window, collateral source, stake owner, amounts and eligibility time, with no manual
flag. O4's `IntentFulfilled` carries `isManualRelease`. Only matured collateral releases emit
`DisputeProtectionIntentReleased`. No Opened or Cancelled event is emitted.

IntentLifecycleHookV2 reads `bytes32(data)`: clients send empty data for no conditions or
`abi.encodePacked(conditionsHash)` for a raw 32-byte hash. Empty and all-zero data are unconditioned;
shorter data is right-padded and longer data uses its first word, with no length or version decoding.
The conditions version belongs inside the attestor-side hash preimage. Each intent's data is interpreted
only by its snapshotted hook. After the whitelist admission check, a nonzero hash requires a
gating service (`ConditionsRequireGatingService`); O4 separately requires a gating service for any
non-empty data and verifies its signature covering the data hash. Settlement compares extension word 1
with the expected hash symmetrically, unless manually released. A mismatch reverts with
`ConditionsNotAttested(intentHash)`. IIntentLifecycleHookV2 contains only the four lifecycle callbacks:
`onIntentSignaled`, `onIntentCancelled`, `settleIntent` and `onDeferredPayoutFunded`. Its ERC-165
interface id is the XOR of exactly those four selectors; O4 validates it when configuring the hook.

The cross-repo attestor smoke remains gated by `ATTESTOR_POLICY_SMOKE_ROOT`. Its expected signed payload
contains a dispute window in word 0: zero for pay now and the attested window for protected settlements.

### Deferred lifecycle compatibility

OrchestratorV4 accepts zero or a hook advertising IIntentLifecycleHookV2 through standard ERC-165.
The configuration-time check rejects a wrong hook with InvalidLifecycleHook: a V1 hook would
otherwise revert at signal because V2 uses onIntentSignaled(bytes32,bytes) and a V2-only
SettlementContext selector, so no intent would be stranded. For the same reason, OrchestratorV3
cannot successfully signal or snapshot IntentLifecycleHookV2. The shared V1/V2
onIntentCancelled(bytes32) selector is only called for intents snapshotted with that hook.

IntentLifecycleHookV2 checks the caller's orchestrator-registry membership without querying
ERC-165. Registering an orchestrator is a governance assertion that it honours the deferral vault
returned by settleIntent. O4 and the hook still advertise IERC165 and their own interfaces and
reject 0xffffffff; the protocol interface ids exclude supportsInterface.
OrchestratorV3 and IntentLifecycleHookV1 remain unchanged.
