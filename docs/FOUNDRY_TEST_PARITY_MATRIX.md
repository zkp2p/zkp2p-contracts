# Foundry Test Parity Matrix

**Status:** Draft  
**Created:** 2026-03-12  
**Branch:** `foundry-main`

## Purpose

This file is the migration control surface for the Hardhat-to-Foundry rewrite.

Rules:

- A Hardhat test file may not be deleted until its parity row is complete.
- "Parity complete" means the Hardhat behavioral cases have been extracted and represented in Foundry.
- Foundry ports may improve structure and add cases, but they may not silently reduce behavioral coverage.

## Status Legend

- `Not started`: no case extraction yet
- `Mapped`: target Foundry file selected
- `Cases extracted`: Hardhat cases listed and reviewed
- `Ported`: Foundry test exists and covers listed cases
- `Verified`: Foundry test passes in CI and Hardhat source can be removed
- `Archived`: source file intentionally retained or archived with rationale

## Suggested Target Layout

- `test-foundry/unit/`: single-contract and small-scope deterministic suites
- `test-foundry/integration/`: multi-contract lifecycle and deploy-flow deterministic suites
- `test-foundry/fuzz/`: fuzz/property suites
- `test-foundry/invariant/`: invariants
- `test-foundry/fork/`: fork/network-specific suites

## Matrix

Current baseline:

- 49 of 49 Hardhat test files are mapped to recommended Foundry targets.
- 0 unmapped files remain.
- Detailed case extraction is still pending and will be filled in during porting.

| Domain | Hardhat Source | Recommended Foundry Target | Status | Notes |
| --- | --- | --- | --- | --- |
| libs | `test/libs/thresholdSigVerifierUtils.spec.ts` | `test-foundry/unit/ThresholdSigVerifierUtils.t.sol` | Ported | 22 Foundry tests preserve signature ordering, threshold edges, malformed signatures, and duplicate-witness cases |
| registries | `test/registries/escrowRegistry.spec.ts` | `test-foundry/unit/EscrowRegistry.t.sol` | Ported | 8 Foundry tests preserve constructor, whitelist management, accept-all toggles, and revert coverage |
| registries | `test/registries/nullifierRegistry.spec.ts` | `test-foundry/unit/NullifierRegistry.t.sol` | Ported | 10 Foundry tests preserve constructor, writer permissions, nullifier insertion, and revert coverage |
| registries | `test/registries/orchestratorRegistry.spec.ts` | `test-foundry/unit/OrchestratorRegistry.t.sol` | Ported | 8 Foundry tests preserve owner gating, add/remove flows, and custom-error coverage |
| registries | `test/registries/paymentVerifierRegistry.spec.ts` | `test-foundry/unit/PaymentVerifierRegistry.t.sol` | Ported | 21 Foundry tests preserve constructor, add/remove, currency management, views, and complex scenario coverage |
| registries | `test/registries/postIntentHookRegistry.spec.ts` | `test-foundry/unit/PostIntentHookRegistry.t.sol` | Ported | 7 Foundry tests preserve hook allowlisting, list views, and revert coverage |
| registries | `test/registries/relayerRegistry.spec.ts` | `test-foundry/unit/RelayerRegistry.t.sol` | Ported | 6 Foundry tests preserve relayer allowlisting and revert coverage |
| unifiedVerifier | `test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts` | `test-foundry/unit/BaseUnifiedPaymentVerifier.t.sol` | Ported | 13 Foundry tests preserve constructor wiring, attestation verifier rotation, payment-method add/remove flows, and view coverage |
| unifiedVerifier | `test/unifiedVerifier/simpleAttestationVerifier.spec.ts` | `test-foundry/unit/SimpleAttestationVerifier.t.sol` | Ported | 12 Foundry tests preserve constructor, witness rotation, valid verification, and malformed-signature coverage |
| unifiedVerifier | `test/unifiedVerifier/unifiedPaymentVerifier.spec.ts` | `test-foundry/integration/UnifiedPaymentVerifier.t.sol` | Ported | 19 Foundry tests preserve attestation success, `PaymentVerified`, nullifier replay protection, all snapshot mismatch branches, release capping, and signature/data-tamper failures |
| hooks | `test/hooks/acrossBridgeHook.spec.ts` | `test-foundry/integration/AcrossBridgeHook.t.sol` | Ported | 18 Foundry tests preserve constructor guards, bridge execution, fallback paths, relay parameters, rescue flows, and native receive handling |
| hooks | `test/hooks/acrossBridgeHookV2.spec.ts` | `test-foundry/integration/AcrossBridgeHookV2.t.sol` | Ported | 19 Foundry tests preserve registry authorization, fulfill-hook length checks, bridge/fallback behavior, relay parameters, rescue flows, and native receive handling |
| hooks | `test/hooks/whitelistPreIntentHook.spec.ts` | `test-foundry/unit/WhitelistPreIntentHook.t.sol` | Ported | 18 Foundry tests preserve whitelist management, delegate authorization, hook-slot configuration, dual-hook coexistence, and `signalIntent` gating coverage |
| periphery | `test/periphery/protocolViewer.spec.ts` | `test-foundry/integration/ProtocolViewer.t.sol` | Ported | 12 Foundry tests preserve constructor guards, deposit and payment-method views, prunable liquidity accounting, batch deposit lookups, single and batch intent views, and account-intent enumeration |
| periphery | `test/periphery/protocolViewerV2.spec.ts` | `test-foundry/integration/ProtocolViewerV2.t.sol` | Ported | 12 Foundry tests preserve escrow-address deposit views, delegated and fallback rate resolution, batch deposit lookups, zero-address guards, and single/batch/account intent lookups |
| rateManager | `test/rateManager/chainlinkOracleAdapter.spec.ts` | `test-foundry/unit/ChainlinkOracleAdapter.t.sol` | Ported | 11 Foundry tests preserve config normalization, direct and inverted rates, constant-rate fallback, malformed config defense, and invalid oracle response handling |
| rateManager | `test/rateManager/pythOracleAdapter.spec.ts` | `test-foundry/unit/PythOracleAdapter.t.sol` | Ported | 16 Foundry tests preserve config validation, direct and inverted rates across exponent ranges, and invalid oracle/config branches |
| rateManager | `test/rateManager/rateManagerV1.spec.ts` | `test-foundry/integration/RateManagerV1.t.sol` | Ported | 25 Foundry tests preserve manager creation, fee and config mutation rules, batch and single rate writes, min-liquidity opt-in gating, escrow access control, explicit escrow whitelisting, and owner-only registry updates |
| escrow | `test/escrow/escrow.spec.ts` | `test-foundry/integration/Escrow.t.sol` | Mapped | Large source suite; likely split into multiple Solidity test contracts |
| orchestrator | `test/orchestrator/orchestrator.spec.ts` | `test-foundry/integration/Orchestrator.t.sol` | Mapped |  |
| orchestrator | `test/orchestrator/preIntentHook.spec.ts` | `test-foundry/integration/PreIntentHook.t.sol` | Mapped |  |
| escrowV2 | `test/escrowV2/escrowV2.branchCoverage.spec.ts` | `test-foundry/integration/EscrowV2BranchCoverage.t.sol` | Mapped |  |
| escrowV2 | `test/escrowV2/escrowV2.delegation.spec.ts` | `test-foundry/integration/EscrowV2Delegation.t.sol` | Ported | 20 Foundry tests preserve delegated manager set/clear flows, opt-in and reentrancy behavior, effective-rate fallback rules, stale-oracle handling, and delegated manager-fee lookup behavior |
| escrowV2 | `test/escrowV2/escrowV2.getDepositCurrencyMinRate.spec.ts` | `test-foundry/integration/EscrowV2GetDepositCurrencyMinRate.t.sol` | Ported | 12 Foundry tests preserve fixed-floor vs oracle-floor selection, negative spreads, stale-oracle halts, deactivate/reactivate flows, and mixed fixed/oracle lifecycle edge cases |
| escrowV2 | `test/escrowV2/escrowV2.legacyCoverage.spec.ts` | `test-foundry/integration/EscrowV2LegacyCoverage.t.sol` | Mapped |  |
| escrowV2 | `test/escrowV2/escrowV2.oracleRates.spec.ts` | `test-foundry/integration/EscrowV2OracleRates.t.sol` | Mapped |  |
| escrowV2 | `test/escrowV2/escrowV2.pythOracle.spec.ts` | `test-foundry/integration/EscrowV2PythOracle.t.sol` | Mapped |  |
| orchestratorV2 | `test/orchestratorV2/orchestratorV2.legacyCoverage.spec.ts` | `test-foundry/integration/OrchestratorV2LegacyCoverage.t.sol` | Mapped |  |
| orchestratorV2 | `test/orchestratorV2/orchestratorV2.spec.ts` | `test-foundry/integration/OrchestratorV2.t.sol` | Ported | 4 Foundry tests preserve delegated effective-rate enforcement, manager-fee snapshotting, max-fee rejection, and manager-fee deduction on fulfill |
| deploy | `test/deploy/00_system.spec.ts` | `test-foundry/integration/deploy/SystemV1Deployment.t.sol` | Ported | 7 Foundry tests preserve V1 deployment wiring, ownership transfer modes, viewer wiring, and existing-USDC vs mock-USDC branches |
| deploy | `test/deploy/01_unifiedVerifier.spec.ts` | `test-foundry/integration/deploy/UnifiedVerifierDeployment.t.sol` | Ported | 5 Foundry tests preserve witness wiring, multisig ownership transfer, unified verifier dependency wiring, nullifier writer permissions, and the optional no-transfer/no-writer branch |
| deploy | `test/deploy/02_venmoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/VenmoPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/03_revolutPaymentMethod.spec.ts` | `test-foundry/integration/deploy/RevolutPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/04_cashappPaymentMethod.spec.ts` | `test-foundry/integration/deploy/CashappPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/05_wisePaymentMethod.spec.ts` | `test-foundry/integration/deploy/WisePaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/06_mercadopagoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/MercadopagoPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/07_zellePaymentMethods.spec.ts` | `test-foundry/integration/deploy/ZellePaymentMethodsDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/08_paypalPaymentMethod.spec.ts` | `test-foundry/integration/deploy/PaypalPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/09_monzoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/MonzoPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/10_acrossBridgeHook.spec.ts` | `test-foundry/integration/deploy/AcrossBridgeHookDeployment.t.sol` | Ported | 7 Foundry tests preserve hook wiring, registry whitelisting, mock-vs-existing spoke pool selection, missing-spoke-pool reverts, and optional registration plus ownership-transfer branches |
| deploy | `test/deploy/10_n26PaymentMethod.spec.ts` | `test-foundry/integration/deploy/N26PaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/11_alipayPaymentMethod.spec.ts` | `test-foundry/integration/deploy/AlipayPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/12_chimePaymentMethod.spec.ts` | `test-foundry/integration/deploy/ChimePaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/13_luxonPaymentMethod.spec.ts` | `test-foundry/integration/deploy/LuxonPaymentMethodDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/14_v2System.spec.ts` | `test-foundry/integration/deploy/SystemV2Deployment.t.sol` | Mapped |  |
| deploy | `test/deploy/15_v2Periphery.spec.ts` | `test-foundry/integration/deploy/V2PeripheryDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/16_v2PaymentMethods.spec.ts` | `test-foundry/integration/deploy/V2PaymentMethodsDeployment.t.sol` | Mapped |  |
| deploy | `test/deploy/17_pythOracle.spec.ts` | `test-foundry/integration/deploy/PythOracleDeployment.t.sol` | Mapped |  |
| patchCoverage | `test/patchCoverage/patchCoverage.spec.ts` | `test-foundry/integration/PatchCoverage.t.sol` | Mapped | Fold into real suites if this is purely artificial coverage scaffolding |

## PR Checklist Template

Use this checklist in each migration PR:

- Hardhat source files touched:
- Foundry target files added:
- Cases extracted into matrix:
- Cases added beyond parity:
- Existing Foundry scaffolding replaced or removed:
- Hardhat files safe to delete:
- CI commands run:
