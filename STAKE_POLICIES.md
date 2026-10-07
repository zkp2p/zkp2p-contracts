# Proof-settled stake policies

Implements the contracts scope of the [7 October specification](https://docs.google.com/document/d/1aUM9907Olumn89yT3bDKY7F3QzDwXRqUROdRi9rpoBg/edit). Deploy fresh `DisputeProtectionPolicyV2` and `IntentLifecycleHookV2`; reuse O3, Escrow, UPV3, its witness verifier, the vault, and both replay registries. V2 is implemented directly in `contracts/hooks/DisputeProtectionPolicy.sol`; `contracts/legacy/DisputeProtectionPolicy.sol` freezes the predecessor source for immutable deployment lanes and migration tests. This change exports source ABIs only and does not change active addresses or deployment lanes.

| Policy ID preimage | Kind | Window | Initial no-stake admission |
| --- | --- | --- | --- |
| `venmo_personal` | DEFAULT | Saved admission default | No |
| `paypal_personal` | DEFAULT | Saved admission default | No |
| `venmo_goods_and_services` | OVERRIDE | 90 days | No |
| `paypal_goods_and_services` | OVERRIDE | 90 days | No |
| `venmo_balance` | OVERRIDE | Zero | Disabled until separately qualified |

IDs and payment methods are `keccak256` of the exact strings. DEFAULT rules store zero; configure the two DPP defaults to 14 days. Rule method/kind/window cannot change after registration. The no-stake flag controls new admission only.

Ordinary protected admission records the personal policy and locks the full intent amount. The owner calls `selectPaymentPolicy(hash, id)` only when the authenticated proof's tag differs. A first positive selection on an unstaked order takes current admission permissions and locks the full amount. Further switches retain the original stake owner and saved default. Selecting balance alone never releases stake.

An initial balance signal carries exactly `abi.encode(keccak256("payment_policy"), keccak256("venmo_balance"))` in `intent.data`. It requires direct payout, enabled protection and policy admission, and current whitelist membership when enabled. Ordinary whitelisted/open admission remains unchanged.

The attestor appends connector-derived `additionalData` bytes after the unchanged 448-byte payment/snapshot prefix. The signed `dataHash` covers all bytes; UPV3 verifies that hash without interpreting the extension. This hook requires exactly 32 additional bytes matching the selected policy ID (480 bytes total) and delegates signature verification to the captured witness verifier. The HTTP API, EIP-712 schema and UPV3 contract do not change.

Proof settlement uses the saved DEFAULT or immutable OVERRIDE. Positive holds resize to verified gross release; zero unlocks the entire original lock and emits both settlement and release. Manual settlement uses the saved default. In DPPv2, `riskWindow` means that saved default; derive the applied hold from settlement time and `releaseEligibleAt`.

## Preparing the existing-vault handover

1. Deploy DPPv2 with the existing vault, dispute verifier, dispute registry, and exact predecessor policy. Deploy the new hook with the retained orchestrator registry and whitelist. Complete governance ownership, authorize the new hook, set the two 14-day defaults, bind the existing UPV3/current witness verifier with `initializePaymentVerifier`, and register the five rules above with all no-stake flags false.
2. Propose DPPv2 through `vault.proposeController`. Read `controllerChangeDelay`; do not assume a duration. The predecessor remains authoritative during the delay.
3. Pause predecessor admissions. Settle or cancel/prune every protected PENDING order, including expired orders. Settled locks can remain. Have each depositor reapply its current `(escrow, depositId, method)` opt-outs to DPPv2. Governance cannot impersonate depositors.
4. Build Hardhat artifacts with `yarn compile`, then run `yarn ts-node scripts/prepareStakePolicyCutover.ts configuration.json`. Configuration fields are `rpcUrl`, `chainId`, `governance`, `predecessor`, `predecessorDeploymentTransaction`, `successor`, `successorDeploymentTransaction`, `vault`, `disputeVerifier`, `disputeRegistry`, `upv`, `witnessVerifier`, `oldHook`, `newHook`, and `orchestrator`. Deployment transactions must be the direct policy creation transactions.
5. The script only reads. It pins one block, scans complete predecessor admissions and opt-out history from deployment receipts, checks each lock, rejects missing opt-outs or pending orders, verifies current wiring and elapsed delay, and emits inventory plus five unsigned calls: accept controller, grant new dispute writer, install checker, install future hook, retire old writer. Re-run immediately before execution. The output is a snapshot, not an on-chain execution guard or approval to execute.
6. Coordinate consumer readiness before governance executes. Route reads, releases and disputes to DPPv2, including predecessor settlements. Keep old hooks and originating O3s authorized for remaining ordinary callbacks. Record actual deployment/address changes separately after execution. Do not rotate back after adoption.

DPPv2 reads local records first and otherwise exposes predecessor history. Only release/dispute may adopt a SETTLED record, with exact vault owner, amount and maturity and only while DPPv2 is controller. It copies once; local terminal state wins forever. Existing stake, delegation, authorizations and claims stay in the same vault.

## Verification and release gates

```sh
forge test --match-contract StakePoliciesTest
yarn test:stake-policy-cutover
# After yarn compile, start a fresh local Anvil in another terminal:
# anvil --port 8547 --silent
node scripts/stake-policy-cutover.rehearsal.cjs
# Both owner repositories must have their dependencies installed:
ATTESTOR_POLICY_SMOKE_ROOT=/absolute/path/to/attestation-service \
  forge test --match-test test_ServiceSignedProofSmoke
```

The cross-repository smoke uses the actual attestor transformer, encoder and signer, then fulfills through real O3/UPV3/hook/DPP/vault contracts. Provider responses and the signer are synthetic. Local tests do not qualify live Venmo evidence, Nitro TLS/KMS, deployed wiring, or downstream consumers.

Merge both PRs, publish the contracts ABI package, qualify tagged-proof parity, and deploy the attestor before activating protected policy orders. The attestor package does not change. Prepare SDK/Curator/Pay/web/mobile/relayer/indexer and release/dispute jobs in their owners; those changes are outside these two PRs. Qualify authenticated balance evidence in live Nitro and consumer flows before enabling fresh no-stake admission. Base production and staging share chain ID 8453: verify the complete service/O3/UPV3/hook/DPP/vault bundle, not chain ID alone.
