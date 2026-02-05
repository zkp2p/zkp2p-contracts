feat: Delegated Rate Management V1 — Manager Registry, Escrow Integration, Fee Snapshot Event

Summary
- Introduces a permissionless onchain manager registry (DepositRateManagerRegistryV1) and escrow integration to enable delegated rate management without global onchain loops across deposits.
- Adds a simple per‑fill manager fee (flat bps) that’s snapshotted at signalIntent and emitted as a dedicated event for indexers.
- Preserves depositor safety via effective min‑rate = max(depositor floor, manager min rate); managers can also disable pairs by setting min rate = 0.

Scope (Final State)
- New registry contract: DepositRateManagerRegistryV1
  - ID scheme: bytes32 rateManagerId minted as keccak256(abi.encodePacked(address(this), nextId)). This ensures uniqueness per registry deployment and avoids deliberate collisions; it’s deterministic and indexer‑friendly.
  - RateManagerConfig: { manager, feeRecipient, maxFee, fee, depositHook, name, uri }.
    - maxFee is immutable per id; fee is updatable by manager but must be <= maxFee.
    - depositHook is an optional callable used on depositor opt‑in for custom guardrails.
  - API:
    - createRateManager(config) → bytes32 rateManagerId
    - setRateManagerConfig(id, newManager, newFeeRecipient, newHook, name, uri)
    - setFee(id, newFee ≤ maxFee)
    - setMinRate(id, paymentMethod, currency, minRate)
    - setMinRatesBatch(id, bytes32[] paymentMethods, bytes32[][] currencies, uint256[][] minRates)
  - Events:
    - RateManagerCreated(id, manager, feeRecipient, maxFee, fee, name, uri)
    - RateManagerConfigUpdated(id, manager, feeRecipient, depositHook, name, uri)
    - RateManagerFeeUpdated(id, fee)
    - RateManagerMinRateUpdated(id, paymentMethod, currency, minRate)
    - RateManagerMinRatesBatchUpdated(id, count)
  - Views:
    - isRateManager(id), getRateManager(id), getFee(id) → (recipient, fee), getDepositHook(id), getMinRate(id, pm, curr)

- Escrow integration (Escrow.sol)
  - Per‑deposit manager link: mapping(uint256 depositId → bytes32 rateManagerId).
  - setDepositRateManager(depositId, rateManagerId):
    - Requires registry set and id exists.
    - If depositHook is set on the manager, calls IRateManagerDepositHook.onDepositOptIn(depositor, escrow, depositId) (view; revert to reject).
    - Emits DepositRateManagerUpdated(depositId, depositor, rateManagerId).
  - clearDepositRateManager(depositId): resets id and emits DepositRateManagerUpdated(..., 0x0).
  - getDepositCurrencyMinRate(depositId, pm, currency):
    - Returns 0 if depositor floor is 0.
    - If no manager: returns depositor floor.
    - If manager set: reads manager min rate; returns 0 if manager disabled pair; else returns max(floor, manager).
  - getDepositRateManager(depositId) → bytes32; getDepositManagerFee(depositId) → (recipient, fee).

- Orchestrator (Orchestrator.sol)
  - signalIntent snapshots the manager fee from Escrow into dedicated mappings keyed by intentHash.
  - Emits IntentSignaled first; then emits IntentManagerFeeUpdated(intentHash, recipient, fee) as the final event to ease indexing of net amounts.
  - Pruning removes the snapshot mappings.

- New interface
  - IRateManagerDepositHook with onDepositOptIn(address depositor, address escrow, uint256 depositId) external view.

Rationale
- Bytes32 IDs (keccak(address(this), nextId))
  - Ensures uniqueness tied to the registry deployment, avoids manual salts and deliberate collisions, and remains deterministic for indexers.
- Updatable fee ≤ immutable maxFee
  - Makers can see both fee and cap at delegation time; managers can iterate within safe bounds without redeploying a new id. Avoids protocol‑level caps in Orchestrator to keep responsibilities local to the manager/config.
- Deposit hook as an optional callable
  - Pushes custom guardrails (e.g., min delegation) out of Escrow to keep core minimal and composable. The rate manager itself can implement the hook or point to a dedicated validator contract. View‑only and revert‑on‑failure to maintain safety and determinism.
- No global loops across deposits
  - Managers update a single onchain config and indexers/fetchers fan out offchain; setMinRatesBatch loops only over calldata‑provided pairs.
- Event ordering for indexers
  - Emitting IntentManagerFeeUpdated last lets services derive gross/net without re‑reading state at a blockTag or risking drift.

Security & Safety
- Non‑custodial: managers cannot withdraw funds; Escrow remains the single source of transfer authority.
- Rate safety: manager cannot undercut depositor floors; min rate 0 disables a pair (acts as allowlist).
- Fee safety: fee snapshot at signalIntent; later manager changes don’t affect existing intents; fee always bounded by maxFee.
- External calls: deposit hook is view‑only and reverts to deny opt‑in; follows CEI and avoids stateful callbacks.

Integration Notes (Indexer/UI)
- Indexers: consume RateManager* events (create/config/fee/minrate updates), Escrow’s DepositRateManagerUpdated, and Orchestrator’s IntentManagerFeeUpdated for fee snapshots.
- Maker UI: show manager name/URI, fee and maxFee, and inform that manager can disable pairs.
- Taker UI: display gross vs net (protocol + referrer + manager fees).

Testing
- test/orchestrator/delegatedRateManagement.spec.ts covers:
  - Effective min‑rate = max(floor, manager).
  - Manager allowlist behavior via rate=0.
  - Manager fee transfer on fulfillment.

Detailed Testing Plan (Hardhat, iterative)

- Style guide
  - Mirror existing Escrow/Orchestrator suites: for each external function, write success (state + events) and each failure path individually.
  - Prefer minimal fixtures; reset state between tests; assert storage diffs where relevant.

- A) Registry: DepositRateManagerRegistryV1
  - createRateManager
    - success: emits RateManagerCreated with computed id = keccak(address(this), nextId), stores config exact.
    - failure: manager=0, feeRecipient=0 when fee>0, maxFee > GLOBAL_MAX_MANAGER_FEE, fee > maxFee.
  - setRateManagerConfig (onlyManager)
    - success: updates manager, feeRecipient, depositHook, name, uri; emits RateManagerConfigUpdated.
    - failure: caller != manager; newManager=0; fee>0 but feeRecipient=0 (preexisting fee>0); unknown id.
  - setFee (onlyManager)
    - success: updates fee ≤ maxFee; emits RateManagerFeeUpdated.
    - failure: caller != manager; newFee > maxFee; newFee>0 while feeRecipient=0.
  - setMinRate (onlyManager)
    - success: writes exact minRate; emits RateManagerMinRateUpdated.
    - failure: caller != manager; paymentMethod=0; currency=0.
  - setMinRatesBatch (onlyManager)
    - success: multiple pm with currency/rate vectors; emits per‑pair updated and batch count; mismatched inner vectors rejected.
    - failure: array length mismatches; invalid pm/currency.
  - views: isRateManager/getRateManager/getFee/getDepositHook/getMinRate
    - baseline: return zeroed values for unknown id; return stored config for existing id.

- B) Escrow: Delegation + effective min rate
  - setDepositRateManager
    - success: depositor only; registry set; id exists; optional depositHook called (use a mock that records the call); emits DepositRateManagerUpdated.
    - failure: caller != depositor; id=0x0; registry not set; id not found; depositHook reverts.
  - clearDepositRateManager
    - success: clears id; emits DepositRateManagerUpdated with 0x0.
    - failure: caller != depositor.
  - getDepositCurrencyMinRate
    - floor=0 → 0 regardless of manager.
    - no manager → floor.
    - manager set, rate=0 → 0 (allowlist off).
    - manager set, rate>floor → manager.
    - manager set, rate<floor → floor.
    - failure: registry not set when manager id present → revert RateManagerRegistryNotSet.
  - getDepositManagerFee/getDepositRateManager: return exact registry fee tuple and stored id.

- C) Orchestrator: Fee snapshot + ordering
  - signalIntent
    - success: stores intentManagerFee* from Escrow at signal; emits IntentSignaled then IntentManagerFeeUpdated (verify event order and values).
    - success: zero recipient/fee → emits fee event with zeros; mappings set accordingly.
    - behavior: changing manager fee after signal does not affect the stored mappings.
  - fulfillIntent / releaseFundsToPayer path
    - success: manager fee deducted from releaseAmount; check transfers and emitted IntentFulfilled amount equals net.
    - interactions: combine with protocol fee and referrer fee; assert totals and recipients.
  - pruneIntents
    - success: removes fee mappings; subsequent reads return zero.

- D) Integration flows
  - End‑to‑end: create deposit → set floor → opt‑in manager (with hook) → set manager min rate → signal → fulfill → assert fee distributions and min‑rate constraints.
  - Allowlist off: manager rate=0 → signal reverts with CurrencyNotSupported.
  - Update fee ≤ maxFee between signals → old intents use old snapshot; new intents use new fee (assert via events).

- E) Negative/edge cases
  - Registry: attempt to set fee above maxFee; batch with empty inner arrays; very large batch sizes (gas sanity within block limits).
  - Escrow: attempt to opt‑in when deposit not found; when deposit not accepting intents (should still allow opt‑in; just linking manager id).
  - Orchestrator: ensure no cap check on manager fee (cap enforced at registry); extremely small/large conversion rates; zero‑amount intents prevented by existing checks.

- F) Future (follow‑up)
  - Foundry fuzz: min‑rate invariants (effective min ≥ floor; allowlist = 0) and fee accounting invariants across random fulfillments.
  - Invariants: no funds lost, fee sums equal deducted value, manager cannot undercut floors.

Out‑of‑Scope in this PR
- ProtocolViewer extensions to surface manager info (can be added later).
- Performance fees or market‑oracle‑based accounting.
- Any global min‑delegation logic in Escrow (achievable via depositHook if needed).

Spec Reference
- Delegated Rate Management V1 spec (internal doc) aligns with this final design; this PR reflects the 80/20 MVP decisions (bytes32 ids; fee≤maxFee; optional deposit hook; final event ordering).
