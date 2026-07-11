# Onchain Risk Migration and Stack Impact

## Deployment safety

`contracts/deploy/26_deploy_onchain_risk_system.ts` is opt-in and skips unless
`DEPLOY_ONCHAIN_RISK=true`. It deploys:

1. `IdentityRegistry`
2. `ReputationRegistry`
3. `StakeVault`
4. `ProtocolRiskManager`
5. `OpenOrchestratorV2` using the `OrchestratorV2` implementation

It reuses the deployed `EscrowV2`, `EscrowRegistry`,
`PaymentVerifierRegistry`, `RelayerRegistry`, and `OrchestratorRegistry`.
Existing deposits remain in place.

The script stores these proposed initial policies with every platform disabled
and the orchestrator paused. Cutover must enable them explicitly:

- all platforms require a registered identity;
- makers are not initially required to register, avoiding an abrupt existing
  deposit outage;
- all signals reserve a 1 USDC bond and slash 50% on abandonment;
- successful takes pay a 0.30% base protocol fee before reputation discount;
- chargebackable platforms reserve 100% base collateral, adjusted by tier;
- minimum reputation is `-100`;
- reversible rails keep at least 100% coverage for a conservative 180-day
  placeholder window; confirm each rail's enforceable dispute window before cutover.

## Staged rollout

### Stage 0: review and audit

- Audit the four new modules and OrchestratorV2 diff.
- Confirm live Attestor signers from deployment state.
- Decide the governance owner/timelock and emergency process.
- Measure current chargeback timing before accepting the proposed curve.
- Benchmark worst-case expired-intent pruning with the live
  `maxIntentsPerDeposit`; lower the shared limit if a full withdrawal does not
  fit the operational gas budget.

### Stage 1: deploy dark

- Deploy modules and the open orchestrator without publishing it to clients.
- Keep the open orchestrator paused; the deployment script pauses it before registry authorization.
- Add the open orchestrator to `OrchestratorRegistry`.
- Provision distinct threshold/ERC-1271 signers for payment proofs, identity,
  and chargebacks; register only the role-specific keys in each registry.
- Verify onchain configs and package ABI output.

### Stage 2: identity and stake UX

- Add identity registration and StakeVault deposit/checkpoint views to clients.
- Add indexed views for identity registrations, reputation changes, platform
  configs, positions, and chargebacks.
- Keep Curator's signed-intent response shape temporarily; clients may pass
  empty legacy signature fields.

### Stage 3: route traffic

- Enumerate deposits with non-zero legacy gating services and notify affected
  makers that the open orchestrator will not enforce those controls; obtain
  acknowledgment or let them withdraw before enabling traffic.
- Point quote/client orchestration to `OpenOrchestratorV2`.
- Enable reviewed platform configs and unpause atomically with the traffic cutover.
- Stop treating Curator tier/cap/cooldown decisions as authoritative.
- Monitor abandonment, bond slashes, stake utilization, and settlement errors.
- Publish the incremental `removeFunds` recovery procedure for makers whose
  deposits contain a large expired-intent batch.
- Treat fulfillment and maker manual release as fail-closed on the snapshotted
  risk module; cancellation is the recovery path if activation cannot complete.

### Stage 4: remove dead backend control plane

- Delete Curator signature gating, tier/cap/cooldown enforcement, and the
  corresponding PeerHQ mutation surfaces after all supported clients have
  moved.
- Keep quote discovery, maker metadata, and other non-authoritative backend
  services independently deployable.

## Compatibility matrix

| Boundary | Impact |
|---|---|
| EscrowV2 custody | No code/storage change; no deposit migration |
| Signal calldata | Existing tuple preserved; two signature fields deprecated |
| Intent events | Existing events preserved; one additive risk snapshot event |
| Post-intent hooks | Preserved |
| Maker pre-intent/whitelist hooks | Legacy zero-risk deployments preserve them; open deployment rejects new non-zero config and does not execute old state |
| Payment verifier | Preserved |
| Protocol fee | Same fee unit and recipient; per-intent discount is additive |
| Indexer | Add entities/handlers for new events before public rollout |
| Curator | Remove authority; retain quote/metadata compatibility during rollout |
| Attestor | Existing identity payload works; add chargeback typed-data generation |
| PeerHQ | Replace DB tier/risk editors with read-only onchain policy views or governance transaction builders |
| Clients/Pay/mobile | Add registration/stake flows and new orchestrator address; existing signal ABI remains usable |

## Package/deploy order

1. Deploy the paused/disabled dark contracts from reviewed source artifacts.
2. Export their network deployment outputs, then publish the additive contracts package/ABIs.
3. Deploy indexer handlers/schema.
4. Add Attestor chargeback generation and client identity/stake UX.
5. Enable platform configs, unpause, and route traffic environment-by-environment.
6. Retire Curator authority after observability confirms parity.

The package ABI extractor reads `deployments/outputs/*Contracts.ts`; therefore
the dark deployment/output export must precede package publication. The paused
orchestrator prevents this ordering from exposing a callable path early.

## Deliberate follow-ups

This PR defines and tests the contract boundary. It does not add the Attestor
chargeback API, indexer entities, Curator deletion migration, client UI, or any
live deployment coordinates. Keeping those follow-ups explicit allows the
contracts to be audited before backend code is removed.
