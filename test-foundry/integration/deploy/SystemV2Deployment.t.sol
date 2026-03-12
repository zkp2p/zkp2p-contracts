// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { EscrowRegistry } from "../../../contracts/registries/EscrowRegistry.sol";
import { NullifierRegistry } from "../../../contracts/registries/NullifierRegistry.sol";
import { OrchestratorRegistry } from "../../../contracts/registries/OrchestratorRegistry.sol";
import { PaymentVerifierRegistry } from "../../../contracts/registries/PaymentVerifierRegistry.sol";
import { RelayerRegistry } from "../../../contracts/registries/RelayerRegistry.sol";
import { EscrowV2 } from "../../../contracts/EscrowV2.sol";
import { OrchestratorV2 } from "../../../contracts/OrchestratorV2.sol";
import { UnifiedPaymentVerifier } from "../../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import { V2DeploymentTestBase } from "../../helpers/V2DeploymentTestBase.sol";

contract SystemV2DeploymentTest is V2DeploymentTestBase {
    OrchestratorRegistry internal orchestratorRegistry;
    EscrowV2 internal escrowV2;
    OrchestratorV2 internal orchestratorV2;
    UnifiedPaymentVerifier internal unifiedPaymentVerifierV2;
    NullifierRegistry internal nullifierRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    EscrowRegistry internal escrowRegistry;
    RelayerRegistry internal relayerRegistry;

    function setUp() public {
        _setUpDeploymentHarness();
        v2SystemResult = _runV2SystemDeployment(false);
        v2PaymentMethodsResult = _runV2PaymentMethodConfiguration(true);

        orchestratorRegistry = OrchestratorRegistry(v2SystemResult.orchestratorRegistry);
        escrowV2 = EscrowV2(v2SystemResult.escrowV2);
        orchestratorV2 = OrchestratorV2(v2SystemResult.orchestratorV2);
        unifiedPaymentVerifierV2 = UnifiedPaymentVerifier(payable(v2SystemResult.unifiedPaymentVerifierV2));
        nullifierRegistry = NullifierRegistry(v1SystemResult.nullifierRegistry);
        paymentVerifierRegistry = PaymentVerifierRegistry(v1SystemResult.paymentVerifierRegistry);
        escrowRegistry = EscrowRegistry(v1SystemResult.escrowRegistry);
        relayerRegistry = RelayerRegistry(v1SystemResult.relayerRegistry);
    }

    function test_runDeploysOrchestratorRegistryWithExpectedOwnershipAndMembership() public {
        assertEq(orchestratorRegistry.owner(), multiSig);
        assertTrue(orchestratorRegistry.isOrchestrator(v1SystemResult.orchestrator));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestratorV2)));
    }

    function test_runDeploysEscrowV2WithExpectedWiringAndConfig() public {
        assertEq(escrowV2.owner(), multiSig);
        assertEq(escrowV2.chainId(), block.chainid);
        assertEq(address(escrowV2.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(escrowV2.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(escrowV2.dustRecipient(), dustRecipient);
        assertEq(escrowV2.dustThreshold(), 100_000);
        assertEq(escrowV2.maxIntentsPerDeposit(), 100);
        assertEq(escrowV2.intentExpirationPeriod(), 1 days);
        assertTrue(escrowRegistry.isWhitelistedEscrow(address(escrowV2)));
    }

    function test_runDeploysOrchestratorV2WithExpectedWiringAndFees() public {
        assertEq(orchestratorV2.owner(), multiSig);
        assertEq(orchestratorV2.chainId(), block.chainid);
        assertEq(address(orchestratorV2.escrowRegistry()), address(escrowRegistry));
        assertEq(address(orchestratorV2.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(address(orchestratorV2.relayerRegistry()), address(relayerRegistry));
        assertEq(orchestratorV2.protocolFee(), 0.01e18);
        assertEq(orchestratorV2.protocolFeeRecipient(), protocolFeeRecipient);
    }

    function test_runDeploysUnifiedPaymentVerifierV2WithExpectedWiringAndOwnershipAfterConfiguration() public {
        assertEq(unifiedPaymentVerifierV2.owner(), multiSig);
        assertEq(address(unifiedPaymentVerifierV2.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(unifiedPaymentVerifierV2.nullifierRegistry()), address(nullifierRegistry));
        assertEq(address(unifiedPaymentVerifierV2.attestationVerifier()), v1UnifiedVerifierResult.simpleAttestationVerifier);
        assertTrue(nullifierRegistry.isWriter(address(unifiedPaymentVerifierV2)));
        assertEq(v2PaymentMethodsResult.configuredCount, 14);
    }
}
