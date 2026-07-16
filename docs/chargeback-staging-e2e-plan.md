# Staging Chargeback E2E Plan

## Goal and safety boundary

Prove on Base staging that a fake, locally signed payment attestation can fulfill an
`OrchestratorV3` intent and that a separately signed dispute for the same verified payment can call
`RiskManager.submitChargeback`, slash the exact gross USDC release, and compensate the LP.

The first pass is deliberately contract-only:

- read the intent hash and all assertions from transaction receipts and contract views;
- do not call Curator, the attestation service, or Indexer;
- do not persist or print private keys;
- do not write payment or dispute evidence to the repository;
- do not reuse a payment witness as a chargeback witness;
- do not deploy to production or represent this staging pass as launch approval.

Public chargeback rollout remains blocked after this test until production witness governance has
delayed two-step changes and verifier/witness epoch snapshotting, and a real provider-authenticated
E2E passes.

## Why a versioned staging migration is required

The checked-in Base staging records predate the merged chargeback format:

| Component | Recorded staging address | Compatibility observation |
| --- | --- | --- |
| `OrchestratorV3` | `0x79dE2123eE792e77165b2E6E65A54B745E8A734E` | Not reusable: merged HEAD changed `getIntentSettlement` to include the manual-release flag |
| `StakeVault` | `0x5c570D2be2bFD8960B2B9F8d2D3C8148A1e24C5f` | Controller is the old RiskManager |
| `RiskManager` | `0x57E4b9046EA5ABCe1fc688b77D846aE67222b998` | Old `(chainId,riskManager,orchestrator,...,nonce,window)` attestation ABI |
| shared `MultiAttestationVerifier` | `0x9855a39aC5975069632e91160d8712CBfF19e864` | Payment verifier and old RiskManager both use this mutable 1-of-2 set |
| `UnifiedPaymentVerifierV2` | `0x7750f8Cc276f21B7Db1477FA044Bf3FD4951Bf20` | Does not expose `getPaymentDetailsHash` |
| `EscrowV2` | `0x77e8f808FE201075e0bD651CD46fdF239fc83265` | Reusable; uses `OrchestratorRegistry` |
| `PaymentVerifierRegistry` | `0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc` | Reusable with a run-scoped method |
| `OrchestratorRegistry` | `0xfA6384EB6176cfEC049540526A3d2126C3666d8A` | Reusable |
| `NullifierRegistry` | `0x3FFd04f7909a16d3476263A1f4ce413A089dCc69` | Reusable after granting the new UPV write permission |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Stake and escrow token |

Read-only checks on 2026-07-16 confirmed the old RiskManager, StakeVault, and shared verifier are
owned by `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929`; the vault controller is the old RiskManager; and the
shared verifier is threshold 1 with witnesses `0x6664...f19a` and `0x4ab9...2927`.

Do not rerun deploy step 26. It intentionally refuses to overwrite named non-local records. Add a
separately named, Base-staging-only deploy step (next available number is currently 28), for example
`deploy/28_deploy_chargeback_e2e_staging.ts`, guarded by both:

```text
network == base_staging
DEPLOY_CHARGEBACK_E2E=true
```

Use versioned deployment names so historical records remain intact:

```text
PaymentAttestationVerifierChargebackE2E
UnifiedPaymentVerifierChargebackE2E
ChargebackAttestationVerifierE2E
StakeVaultChargebackE2E
RiskManagerChargebackE2E
```

Deploy versioned `BoundedCall`, `PostIntentHookExecutor`, and `OrchestratorV3ChargebackE2E`, then
register that orchestrator. The recorded OrchestratorV3 predates the three-value
`getIntentSettlement` interface used by the merged RiskManager. Do not silently replace the canonical
`OrchestratorV3` deployment record.

### Vault controller choice

For an immediate isolated test, deploy a fresh versioned StakeVault with controller zero, deploy the
new RiskManager, and call `initializeController(newRiskManager)` once. This avoids moving the existing
vault or inheriting its reservations.

For a persistent staging migration using the existing vault, the only safe sequence is:

1. pause admission and inventory all reservations controlled by the old RiskManager;
2. old vault owner calls `proposeController(newRiskManager)`;
3. wait the configured 172,800-second controller delay;
4. the new RiskManager calls `acceptVaultController()`;
5. verify old positions retain the controller recorded in each reservation and remain resolvable;
6. unpause only after reconciliation checks pass.

Never bypass the controller delay or strand old reservations. This persistent migration is not needed
for the isolated E2E.

## Temporary witnesses

The single-key shortcut is incompatible with the agreed trust separation. Generate fileless,
ephemeral wallets in memory and expose only their public addresses:

- three payment witnesses, used only by `PaymentAttestationVerifierChargebackE2E` at threshold 2;
- three distinct chargeback witnesses, used only by `ChargebackAttestationVerifierE2E` at threshold 2;
- a distinct recoverable staging taker for a meaningful maker/taker balance test. Supply its key
  only through `CHARGEBACK_E2E_TAKER_PRIVATE_KEY`; never print, copy into the repo, or commit it.

The two witness sets must be disjoint and must also be disjoint from the existing payment witness set.
Sign the positive payment and chargeback attestations with two witnesses from their respective sets.
The unused third witness in each domain proves both thresholds are genuinely 2-of-3. Do not use the
`0x84` deployer as a witness unless a staging-only waiver is explicitly recorded; doing so weakens
independence.

After all positions are terminal:

1. remove the temporary run-scoped payment method from the registry;
2. remove the new UPV's NullifierRegistry write permission;
3. pause the test RiskManager's admission;
4. remove each temporary witness only while maintaining the verifier's current threshold invariant,
   or leave the isolated verifier ownerless/disabled according to the approved cleanup transaction;
5. sweep only the test-funded ETH above the recoverable taker's starting balance back to `0x84`,
   discard the in-memory witness wallets, and retain no signed evidence.

Immediate witness mutation is acceptable only for this isolated staging fixture. It remains a launch
blocker for public use.

## Deployment preflight

The deployment/test runner must fail before sending a transaction unless all checks pass:

1. provider chain ID is exactly 8453;
2. the configured signer address is exactly
   `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929` without printing its private key;
3. signer ETH and USDC balances cover deployment, escrow liquidity, and stake with a safety margin;
4. every recorded dependency has runtime code and its owner/controller/registry wiring matches the
   expected snapshot;
5. the existing UPV is confirmed incompatible and is not selected for a chargebackable admission;
6. the new payment and chargeback verifier addresses differ, witness sets are disjoint, and the
   chargeback verifier reports exactly three witnesses and threshold two;
7. the new UPV implements `getPaymentDetailsHash(address,bytes32)`;
8. the selected Orchestrator is registered, and EscrowV2 recognizes its registry;
9. Venmo's production-like registry entry is not changed in the isolated pass.

Record public deployment addresses, deployment transaction hashes, owners, constructor args,
verifier witness addresses, thresholds, registry entries, and block numbers. Standard deployment
artifacts may be committed under `deployments/base_staging`; never commit generated keys, signatures,
raw evidence, session data, or test-result artifacts.

## Isolated test fixture

Use a run-scoped method so the first pass cannot interrupt real staging Venmo:

```text
runId = keccak256(deployment block + public test nonce)
paymentMethod = keccak256("venmo-chargeback-e2e:" + runId)
USD = keccak256("USD")
payeeId = keccak256("chargeback-e2e-payee:" + runId)
originalPaymentId = keccak256("chargeback-e2e-payment:" + runId)
disputeId = keccak256("chargeback-e2e-dispute:" + runId)
```

Configure the new UPV for `paymentMethod`. Add the method to `PaymentVerifierRegistry` with USD and
the new UPV. Grant only the new UPV NullifierRegistry write permission. Configure the new RiskManager:

```text
enabled = true
chargebackable = true
deferredPayoutEnabled = false
reserveBps = 10000
riskWindow = 3600 seconds for the positive path
griefingCliff = 900 seconds
griefingPenaltyBpsPerHour = 10
freeTakeCount = 0
freeTakeAmount = 0
```

This run-scoped method exercises the identical bytes32 binding path without changing the canonical
Venmo registry entry. A final maintenance-window test using `keccak256("venmo")` is a separate gate:
snapshot its old verifier/currencies, replace it only for the bounded test window, and restore the
exact snapshot after fulfillment. That pass can disrupt attestations whose EIP-712 verifying contract
still points to the old UPV, so it requires explicit staging coordination.

### USDC, stake, and deposit fallback

Use small but non-dust values; for example:

```text
escrow deposit = 0.30 USDC = 300_000
intent/released amount = 0.20 USDC = 200_000
fiat payment amount = 20 USD cents
conversion rate = 1e18
```

First search on-chain only for an active `0x84` EscrowV2 deposit that supports the run-scoped method,
USD, at least 0.20 USDC liquidity, a 1e18-or-lower minimum conversion rate, and no gating service. A
pre-existing deposit will normally not support a fresh run-scoped method, so the expected fallback is:

1. `0x84` approves EscrowV2 for 0.30 USDC;
2. `0x84` calls `createDeposit` with USDC, range `{min: 200_000, max: 200_000}`,
   `[paymentMethod]`, zero gating service, `payeeId`, USD at minimum rate `1e18`, no delegate,
   no guardian, and `retainOnEmpty = true`;
3. read `depositId` from `DepositReceived`, not from Indexer;
4. `0x84` calls `OrchestratorV3.setDepositRiskHook(escrow, depositId, newRiskManager)`.

Chargebackable admission also requires stake. `0x84` approves the fresh StakeVault and calls
`depositStakeFor(taker, 200_000)`. The distinct taker is mandatory because StakeVault rejects a stake
owner authorizing itself, and it keeps the fulfillment recipient and compensated LP balances
independently observable. Fund the taker with only enough incremental ETH for the run and sweep only
that excess during cleanup, preserving its starting balance.

## Signal the intent

The recoverable staging taker calls `signalIntent` on the selected OrchestratorV3 with:

```text
escrow = recorded EscrowV2
depositId = DepositReceived.depositId
amount = 200_000
to = taker
paymentMethod = run-scoped paymentMethod
fiatCurrency = USD
conversionRate = 1e18
referralFees = []
gatingServiceSignature = 0x
signatureExpiration = 0
postIntentHook = address(0)
preIntentHookData = 0x
data = 0x
```

Read `intentHash` and signal timestamp from the `IntentSignaled` receipt and confirm:

- `getIntentRiskHook(intentHash) == newRiskManager`;
- RiskManager position is `PENDING`, payment method and LP are correct, mode is `STAKE_BACKED`, and
  the initial reservation is sufficient;
- StakeVault reservation controller is the new RiskManager;
- RiskManager snapshotted the new UPV selected by the registry.

## Fake payment attestation and fulfillment

Build `PaymentDetails` and `IntentSnapshot` directly from the on-chain intent:

```text
PaymentDetails = (
  method: paymentMethod,
  payeeId: intent.payeeId,
  amount: 20,
  currency: USD,
  timestamp: intent.timestamp * 1000,
  paymentId: originalPaymentId
)

IntentSnapshot = (
  intentHash,
  amount: 200_000,
  paymentMethod,
  fiatCurrency: USD,
  payeeDetails: intent.payeeId,
  conversionRate: 1e18,
  signalTimestamp: intent.timestamp,
  timestampBuffer: 0
)
```

Encode the signed data exactly as:

```solidity
abi.encode(
  tuple(bytes32 method,bytes32 payeeId,uint256 amount,bytes32 currency,uint256 timestamp,bytes32 paymentId),
  tuple(bytes32 intentHash,uint256 amount,bytes32 paymentMethod,bytes32 fiatCurrency,bytes32 payeeDetails,uint256 conversionRate,uint256 signalTimestamp,uint256 timestampBuffer)
)
```

Set `dataHash = keccak256(data)` and `releaseAmount = 200_000`. Two payment witnesses sign:

```text
EIP-712 domain:
  name = "UnifiedPaymentVerifier"
  version = "1"
  chainId = 8453
  verifyingContract = new UnifiedPaymentVerifierChargebackE2E

PaymentAttestation:
  bytes32 intentHash
  uint256 releaseAmount
  bytes32 dataHash
```

ABI-encode the proof as:

```solidity
abi.encode(tuple(
  bytes32 intentHash,
  uint256 releaseAmount,
  bytes32 dataHash,
  bytes[] signatures,
  bytes data,
  bytes metadata
))
```

Use the two payment signatures and `metadata = 0x`. Anyone may call
`OrchestratorV3.fulfillIntent({paymentProof,intentHash,verificationData:0x,postIntentHookData:0x})`.

Positive fulfillment assertions:

- `PaymentVerified` contains the exact method, USD cents, payment ID, and payee ID;
- payment nullifier `keccak256(abi.encodePacked(paymentMethod, originalPaymentId))` is consumed;
- `getPaymentDetailsHash(orchestrator,intentHash)` equals
  `keccak256(abi.encode(paymentMethod,originalPaymentId,200,USD))`;
- RiskManager position becomes `SETTLED` with `releasedAmount = reservedAmount = 200_000`;
- `paymentDetailsHash` equals the UPV commitment;
- `coverageDeadline = settledAt + 3600`, with the deadline excluded;
- taker receives the gross release and the LP has not yet received chargeback compensation.

The important unit assertion is that `paymentAmount = 20` is fiat minor units while
`releasedAmount = 200_000` is six-decimal USDC. They are bound through the verifier commitment, not
compared numerically.

## Fake chargeback attestation

Encode:

```text
ChargebackDetails = (
  paymentMethod,
  originalPaymentId,
  disputeId,
  paymentAmount: 200,
  paymentCurrency: USD
)
data = abi.encode(ChargebackDetails)
dataHash = keccak256(data)
```

Two chargeback witnesses sign exactly:

```text
EIP-712 domain:
  name = "ZKP2P RiskManager"
  version = "1"
  chainId = 8453
  verifyingContract = new RiskManagerChargebackE2E

ChargebackAttestation:
  bytes32 intentHash
  bytes32 dataHash
```

Call:

```text
submitChargeback({
  intentHash,
  dataHash,
  signatures: [signatureA, signatureB],
  data,
  metadata: 0x
})
```

Signature order is not material, but signers must be unique. Assert:

- `ChargebackSettled` names the exact intent, LP, gross/compensated amount `200_000`, and dispute;
- position status is `SLASHED`, `slashedAmount = 200_000`, and `reservedAmount = 0`;
- the StakeVault reservation is gone, stake balance fell by exactly 0.20 USDC, and
  `claimableCompensation(lp)` rises by 0.20 USDC; then the LP calls `withdrawCompensation` and its
  wallet balance rises by that exact amount;
- `usedChargebackNullifiers(keccak256(abi.encodePacked(paymentMethod,disputeId))) == true`;
- the attestation's 20 cents never controls the token compensation amount; the stored gross release
  does.

## Negative matrix

Each case needs its own position unless noted, because a successful chargeback is terminal.

| Case | Construction | Expected result |
| --- | --- | --- |
| One signature | Valid data, only one chargeback signature | threshold verifier rejects |
| Duplicate signer | Same valid signature twice | unique-signer threshold rejects |
| Wrong chain | Sign otherwise-valid value with a different domain chain ID | attestation verification rejects |
| Wrong RiskManager | Sign with a different verifying contract | attestation verification rejects |
| Wrong intent | Sign for a different intent or submit against a different settled position | status/binding rejection; no slash |
| Wrong payment method | Re-encode and sign details with another method | `InvalidAttestation`; no slash |
| Wrong original payment ID | Re-encode and sign a different payment ID | `InvalidAttestation`; no slash |
| Wrong fiat amount | Use 201 cents with a valid chargeback signature | `InvalidAttestation`; no slash |
| Wrong fiat currency | Re-encode with a different currency | `InvalidAttestation`; no slash |
| Data tamper | Keep signed `dataHash` but change `data` | `InvalidAttestation`; no slash |
| Same position replay | Submit the successful envelope again | terminal-position rejection |
| Global dispute replay | Settle a second payment, sign its correct details with the already-used dispute ID | `ChargebackEvidenceUsed`; no slash |
| Payment replay | Fulfill another intent using the same original payment ID | NullifierRegistry rejects |
| Manual release | Signal a separate covered intent, then LP calls `releaseFundsToPayer` | payment commitment stays zero and chargeback cannot settle |
| Deadline | Admit/fulfill a separate position after snapshotting a short risk window, wait until `block.timestamp >= coverageDeadline` | `ChargebackWindowClosed`; no slash |

For the deadline case, public Base cannot use `evm_increaseTime`. Snapshot a 60-second test-only risk
window for that one run-scoped method/position, restore the one-hour policy immediately for future
admissions, and wait for the on-chain deadline. Also run the exact boundary with local/fork time travel
before staging.

After every failed transaction, assert LP balance, StakeVault stake/reservation, position status,
`slashedAmount`, and the dispute nullifier are unchanged.

## Script shape and commands

The implementation should add a versioned deploy script plus a single state-aware runner, not a test
that assumes Indexer state:

```text
deploy/28_deploy_chargeback_e2e_staging.ts
scripts/chargeback-staging-e2e.ts
test/deploy/28_chargebackE2EStaging.spec.ts
```

The runner should have explicit modes:

```text
preflight   # reads only; emits no secrets
setup       # deploys/configures the isolated fixture
positive    # signal -> fake payment -> fulfill -> fake chargeback
negative    # independent negative positions
cleanup     # disables admission and removes temporary registry/permission state
verify      # reads terminal state and cleanup invariants
```

Suggested gates and execution:

```bash
yarn compile
npx hardhat test test/deploy/28_chargebackE2EStaging.spec.ts
CHARGEBACK_E2E_MODE=preflight npx hardhat run scripts/chargeback-staging-e2e.ts --network base_staging
DEPLOY_CHARGEBACK_E2E=true npx hardhat deploy --network base_staging --tags ChargebackE2E
CHARGEBACK_E2E_MODE=positive npx hardhat run scripts/chargeback-staging-e2e.ts --network base_staging
CHARGEBACK_E2E_TAKER_PRIVATE_KEY="$STAGING_TAKER_PRIVATE_KEY" CHARGEBACK_E2E_MODE=negative npx hardhat run scripts/chargeback-staging-e2e.ts --network base_staging
CHARGEBACK_E2E_MODE=cleanup npx hardhat run scripts/chargeback-staging-e2e.ts --network base_staging
CHARGEBACK_E2E_MODE=verify npx hardhat run scripts/chargeback-staging-e2e.ts --network base_staging
yarn etherscan:base_staging
```

`CHARGEBACK_E2E_MODE` is a non-secret control value. `CHARGEBACK_E2E_TAKER_PRIVATE_KEY` is secret and
must remain environment-only. The script must require a unique public run ID and refuse to reuse
payment/dispute identifiers from a previous run.

The setup/cleanup path must be resumable from on-chain state after interruption. The positive and
negative flows are intentionally one-shot per unique run identifier; if either is interrupted after
admission, recover the public intent from emitted events and take it terminal before cleanup. Cleanup
must query every position emitted by the isolated RiskManager and refuse to disable dependencies while
any position is pending or settled. Before each configuration write, read and compare the expected
current value. Never automatically remove a registry entry, witness, or permission that the current
run did not create.

## Evidence and final verdict

Report only public coordinates:

- git branch and commit;
- chain ID and deployment block;
- new contract addresses and deployment transaction hashes;
- `depositId`, `intentHash`, payment/chargeback transaction hashes;
- public witness addresses and thresholds;
- before/after USDC and StakeVault accounting;
- positive and negative result table;
- cleanup transaction hashes and final registry/permission state.

Do not commit stdout, JSON test reports, generated signatures, raw payment/dispute payloads, or any
private key. A green fake-attestation E2E proves the contract authorization bridge, not provider
truthfulness, key governance safety, or production readiness.
