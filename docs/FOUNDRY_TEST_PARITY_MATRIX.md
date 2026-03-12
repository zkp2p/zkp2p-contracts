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

| Domain | Hardhat Source | Recommended Foundry Target | Status | Notes |
| --- | --- | --- | --- | --- |
| libs | `test/libs/thresholdSigVerifierUtils.spec.ts` | `test-foundry/unit/ThresholdSigVerifierUtils.t.sol` | Not started |  |
| registries | `test/registries/escrowRegistry.spec.ts` | `test-foundry/unit/EscrowRegistry.t.sol` | Not started |  |
| registries | `test/registries/nullifierRegistry.spec.ts` | `test-foundry/unit/NullifierRegistry.t.sol` | Not started |  |
| registries | `test/registries/orchestratorRegistry.spec.ts` | `test-foundry/unit/OrchestratorRegistry.t.sol` | Not started |  |
| registries | `test/registries/paymentVerifierRegistry.spec.ts` | `test-foundry/unit/PaymentVerifierRegistry.t.sol` | Not started |  |
| registries | `test/registries/postIntentHookRegistry.spec.ts` | `test-foundry/unit/PostIntentHookRegistry.t.sol` | Not started |  |
| registries | `test/registries/relayerRegistry.spec.ts` | `test-foundry/unit/RelayerRegistry.t.sol` | Not started |  |
| unifiedVerifier | `test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts` | `test-foundry/unit/BaseUnifiedPaymentVerifier.t.sol` | Not started |  |
| unifiedVerifier | `test/unifiedVerifier/simpleAttestationVerifier.spec.ts` | `test-foundry/unit/SimpleAttestationVerifier.t.sol` | Not started |  |
| unifiedVerifier | `test/unifiedVerifier/unifiedPaymentVerifier.spec.ts` | `test-foundry/integration/UnifiedPaymentVerifier.t.sol` | Not started |  |
| hooks | `test/hooks/acrossBridgeHook.spec.ts` | `test-foundry/integration/AcrossBridgeHook.t.sol` | Not started |  |
| hooks | `test/hooks/acrossBridgeHookV2.spec.ts` | `test-foundry/integration/AcrossBridgeHookV2.t.sol` | Not started |  |
| hooks | `test/hooks/whitelistPreIntentHook.spec.ts` | `test-foundry/unit/WhitelistPreIntentHook.t.sol` | Not started |  |
| periphery | `test/periphery/protocolViewer.spec.ts` | `test-foundry/integration/ProtocolViewer.t.sol` | Not started |  |
| periphery | `test/periphery/protocolViewerV2.spec.ts` | `test-foundry/integration/ProtocolViewerV2.t.sol` | Not started |  |
| rateManager | `test/rateManager/chainlinkOracleAdapter.spec.ts` | `test-foundry/unit/ChainlinkOracleAdapter.t.sol` | Not started |  |
| rateManager | `test/rateManager/pythOracleAdapter.spec.ts` | `test-foundry/unit/PythOracleAdapter.t.sol` | Not started | Existing rushed Foundry suite can be replaced |
| rateManager | `test/rateManager/rateManagerV1.spec.ts` | `test-foundry/integration/RateManagerV1.t.sol` | Not started |  |
| escrow | `test/escrow/escrow.spec.ts` | `test-foundry/integration/Escrow.t.sol` | Not started | Large source suite; likely split into multiple Solidity test contracts |
| orchestrator | `test/orchestrator/orchestrator.spec.ts` | `test-foundry/integration/Orchestrator.t.sol` | Not started |  |
| orchestrator | `test/orchestrator/preIntentHook.spec.ts` | `test-foundry/integration/PreIntentHook.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.branchCoverage.spec.ts` | `test-foundry/integration/EscrowV2BranchCoverage.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.delegation.spec.ts` | `test-foundry/integration/EscrowV2Delegation.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.getDepositCurrencyMinRate.spec.ts` | `test-foundry/integration/EscrowV2GetDepositCurrencyMinRate.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.legacyCoverage.spec.ts` | `test-foundry/integration/EscrowV2LegacyCoverage.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.oracleRates.spec.ts` | `test-foundry/integration/EscrowV2OracleRates.t.sol` | Not started |  |
| escrowV2 | `test/escrowV2/escrowV2.pythOracle.spec.ts` | `test-foundry/integration/EscrowV2PythOracle.t.sol` | Not started |  |
| orchestratorV2 | `test/orchestratorV2/orchestratorV2.legacyCoverage.spec.ts` | `test-foundry/integration/OrchestratorV2LegacyCoverage.t.sol` | Not started |  |
| orchestratorV2 | `test/orchestratorV2/orchestratorV2.spec.ts` | `test-foundry/integration/OrchestratorV2.t.sol` | Not started |  |
| deploy | `test/deploy/00_system.spec.ts` | `test-foundry/integration/deploy/SystemV1Deployment.t.sol` | Not started |  |
| deploy | `test/deploy/01_unifiedVerifier.spec.ts` | `test-foundry/integration/deploy/UnifiedVerifierDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/02_venmoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/VenmoPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/03_revolutPaymentMethod.spec.ts` | `test-foundry/integration/deploy/RevolutPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/04_cashappPaymentMethod.spec.ts` | `test-foundry/integration/deploy/CashappPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/05_wisePaymentMethod.spec.ts` | `test-foundry/integration/deploy/WisePaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/06_mercadopagoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/MercadopagoPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/07_zellePaymentMethods.spec.ts` | `test-foundry/integration/deploy/ZellePaymentMethodsDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/08_paypalPaymentMethod.spec.ts` | `test-foundry/integration/deploy/PaypalPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/09_monzoPaymentMethod.spec.ts` | `test-foundry/integration/deploy/MonzoPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/10_acrossBridgeHook.spec.ts` | `test-foundry/integration/deploy/AcrossBridgeHookDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/10_n26PaymentMethod.spec.ts` | `test-foundry/integration/deploy/N26PaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/11_alipayPaymentMethod.spec.ts` | `test-foundry/integration/deploy/AlipayPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/12_chimePaymentMethod.spec.ts` | `test-foundry/integration/deploy/ChimePaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/13_luxonPaymentMethod.spec.ts` | `test-foundry/integration/deploy/LuxonPaymentMethodDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/14_v2System.spec.ts` | `test-foundry/integration/deploy/SystemV2Deployment.t.sol` | Not started |  |
| deploy | `test/deploy/15_v2Periphery.spec.ts` | `test-foundry/integration/deploy/V2PeripheryDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/16_v2PaymentMethods.spec.ts` | `test-foundry/integration/deploy/V2PaymentMethodsDeployment.t.sol` | Not started |  |
| deploy | `test/deploy/17_pythOracle.spec.ts` | `test-foundry/integration/deploy/PythOracleDeployment.t.sol` | Not started |  |
| patchCoverage | `test/patchCoverage/patchCoverage.spec.ts` | `test-foundry/integration/PatchCoverage.t.sol` | Not started | Fold into real suites if this is purely artificial coverage scaffolding |

## PR Checklist Template

Use this checklist in each migration PR:

- Hardhat source files touched:
- Foundry target files added:
- Cases extracted into matrix:
- Cases added beyond parity:
- Existing Foundry scaffolding replaced or removed:
- Hardhat files safe to delete:
- CI commands run:
