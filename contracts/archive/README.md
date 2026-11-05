# Archived contract sources

Everything in this directory has been superseded. It is not the current
protocol. Do not edit these files, extend them, or copy them as the starting
point for new work; the current implementations are one level up in
`contracts/`.

## Why these still compile

The top-level `archive/` directory is outside the compilation root. These files
cannot move there yet:

- Deployment lanes that already ran in production are immutable, and several of
  them deploy these contracts by artifact name on `localhost` and `hardhat`
  (`00`, `01`, `14`, and the configuration lanes built on them).
  `yarn deploy:localhost` replays that history.
- The deterministic Foundry suite and the coverage baseline still exercise them.

A file can move to the top-level `archive/` once no mounted lane deploys it and
no retained test imports it.

## Retirement inventory

| Source | Superseded by | Why it is retired |
| --- | --- | --- |
| `Escrow.sol` | `EscrowV2.sol` | V1 escrow. No new work routes through V1. |
| `Orchestrator.sol` | `OrchestratorV3.sol` | V1 orchestrator, paired with the V1 escrow. |
| `OrchestratorV2.sol` | `OrchestratorV3.sol` | Removed from the Base `OrchestratorRegistry` on 2026-08-27 (Safe nonce 76). |
| `../OrchestratorV3.sol` (source retained in place) | `OrchestratorV4.sol` | Removed from Base-staging `OrchestratorRegistry` on 2026-11-05, block 53549246, tx `0xadb0b597468f34fa684e21409ee736dcc7779170722ecaacf8032efb052d85cc`. Base removal is prepared for Safe `0x0bC26FF515411396DD588Abd6Ef6846E04470227` nonce 94; **TODO: production execution tx hash (pending execution)**. |
| `ProtocolViewer.sol`, `interfaces/IProtocolViewer.sol` | `ProtocolViewerV2.sol` | Read helper for the V1 escrow and orchestrator. |
| `registries/PostIntentHookRegistry.sol`, `interfaces/IPostIntentHookRegistry.sol` | none | Only the V1 escrow and orchestrator read it. |
| `unifiedVerifier/UnifiedPaymentVerifier.sol`, `unifiedVerifier/BaseUnifiedPaymentVerifier.sol` | `UnifiedPaymentVerifierV3.sol` | Deployed as `UnifiedPaymentVerifier` and `UnifiedPaymentVerifierV2`. The verifier cutover is one-way: no payment method routes to either, and both lost their nullifier write permission. |
| `external/Uint256ArrayUtils.sol` | none | Imported only by `Escrow.sol`. |

The older rows were checked on Base and Base staging on 2026-10-12; the O3 row
records the 2026-11-05 retirement. Archiving a source does not retire its
deployments: the Base V1 escrow still holds maker
deposits, the V1 orchestrator is still registered, and `OrchestratorV2` is
still registered on Base staging. Resolve registries and routing on-chain
before stating what is active.

O3 source and tests stay in place for this non-breaking retirement. Its public package
ABIs, artifacts, addresses, events, and historical intent/payment reads remain available.
The Base removal batch is `deployments/outputs/safe-batches/base_orchestratorv3_retirement.json`.
Record the execution hash above before releasing package metadata that expects O3 absent.
Do not remove the legacy gating signer: it is shared with the V1 `/v2/verify` path.

## Not archived, despite a higher-numbered sibling

- `EscrowV2.sol` is the current escrow.
- `UnifiedPaymentVerifierV3.sol` is the verifier every payment method routes
  to.
- `registries/NullifierRegistry.sol` is the source of the live
  `DisputeNullifierRegistry`.
- `interfaces/IEscrow.sol`, `IOrchestrator.sol`, `IOrchestratorV2.sol`, and
  `IPostIntentHook.sol` are imported by current contracts.

## Source fidelity

Moving a file here rewrote only its relative import paths. For the exact
source behind a deployed address, use the deployment record's metadata or the
Git history of the original path.
