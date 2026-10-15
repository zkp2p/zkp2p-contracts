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

## What is here

| Source | Superseded by | Why it is retired |
| --- | --- | --- |
| `Escrow.sol` | `EscrowV2.sol` | V1 escrow. No new work routes through V1. |
| `Orchestrator.sol` | `OrchestratorV3.sol` | V1 orchestrator, paired with the V1 escrow. |
| `OrchestratorV2.sol` | `OrchestratorV3.sol` | Removed from the Base `OrchestratorRegistry` on 2026-08-27 (Safe nonce 76). |
| `ProtocolViewer.sol`, `interfaces/IProtocolViewer.sol` | `ProtocolViewerV2.sol` | Read helper for the V1 escrow and orchestrator. |
| `registries/PostIntentHookRegistry.sol`, `interfaces/IPostIntentHookRegistry.sol` | none | Only the V1 escrow and orchestrator read it. |
| `unifiedVerifier/UnifiedPaymentVerifier.sol`, `unifiedVerifier/BaseUnifiedPaymentVerifier.sol` | `UnifiedPaymentVerifierV3.sol` | Deployed as `UnifiedPaymentVerifier` and `UnifiedPaymentVerifierV2`. The verifier cutover is one-way: no payment method routes to either, and both lost their nullifier write permission. |
| `external/Uint256ArrayUtils.sol` | none | Imported only by `Escrow.sol`. |

Retirement was checked on Base and Base staging on 2026-10-12. Archiving a
source does not retire its deployments: the Base V1 escrow still holds maker
deposits, the V1 orchestrator is still registered, and `OrchestratorV2` is
still registered on Base staging. Resolve registries and routing on-chain
before stating what is active.

## Not archived, despite a higher-numbered sibling

- `EscrowV2.sol` is the current escrow.
- `UnifiedPaymentVerifierV3.sol` is the verifier every payment method routes
  to on Base. On Base staging, every method has routed to an earlier
  `UnifiedPaymentVerifierV4` deployment since 2026-10-12; this branch changes
  that source, and the new version isn't deployed yet.
- `registries/NullifierRegistry.sol` is the source of the live
  `DisputeNullifierRegistry`.
- `interfaces/IEscrow.sol`, `IOrchestrator.sol`, `IOrchestratorV2.sol`, and
  `IPostIntentHook.sol` are imported by current contracts.

## Source fidelity

Moving a file here rewrote only its relative import paths. For the exact
source behind a deployed address, use the deployment record's metadata or the
Git history of the original path.
