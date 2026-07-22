// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract V2SystemDeploymentTest is Test {
    uint256 internal constant DUST_THRESHOLD = 0.1e6;
    uint256 internal constant MAX_INTENTS = 100;
    uint256 internal constant INTENT_EXPIRATION = 1 hours;
    uint256 internal constant PROTOCOL_FEE = 0.001e18;

    address internal legacyOrchestrator;
    EscrowRegistry internal escrowRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    RelayerRegistry internal relayerRegistry;
    NullifierRegistry internal nullifierRegistry;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    UnifiedPaymentVerifier internal verifier;

    function setUp() public {
        legacyOrchestrator = makeAddr("legacyOrchestrator");
        escrowRegistry = new EscrowRegistry();
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        relayerRegistry = new RelayerRegistry();
        nullifierRegistry = new NullifierRegistry();
        AttestationVerifierMock attestationVerifier = new AttestationVerifierMock();
        escrow = new EscrowV2(
            address(this),
            block.chainid,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            DUST_THRESHOLD,
            MAX_INTENTS,
            INTENT_EXPIRATION
        );
        orchestrator = new OrchestratorV2(
            address(this),
            block.chainid,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            PROTOCOL_FEE,
            address(this)
        );
        verifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(nullifierRegistry)),
            IAttestationVerifier(address(attestationVerifier))
        );
        orchestratorRegistry.addOrchestrator(legacyOrchestrator);
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        escrowRegistry.addEscrow(address(escrow));
        nullifierRegistry.addWritePermission(address(verifier));
        nullifierRegistry.removeWritePermission(address(verifier));
    }

    function test_OrchestratorRegistryDeploymentSetsOwner() public view {
        assertEq(orchestratorRegistry.owner(), address(this));
    }

    function test_OrchestratorRegistryRegistersV1() public view {
        assertTrue(orchestratorRegistry.isOrchestrator(legacyOrchestrator));
    }

    function test_OrchestratorRegistryRegistersV2() public view {
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestrator)));
    }

    function test_EscrowV2DeploymentSetsOwner() public view {
        assertEq(escrow.owner(), address(this));
    }

    function test_EscrowV2DeploymentSetsChainId() public view {
        assertEq(escrow.chainId(), block.chainid);
    }

    function test_EscrowV2DeploymentWiresOrchestratorRegistry() public view {
        assertEq(address(escrow.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_EscrowV2DeploymentWiresPaymentVerifierRegistry() public view {
        assertEq(address(escrow.paymentVerifierRegistry()), address(paymentVerifierRegistry));
    }

    function test_EscrowV2DeploymentSetsDustRecipient() public view {
        assertEq(escrow.dustRecipient(), address(this));
    }

    function test_EscrowV2DeploymentSetsDustThreshold() public view {
        assertEq(escrow.dustThreshold(), DUST_THRESHOLD);
    }

    function test_EscrowV2DeploymentSetsMaximumIntents() public view {
        assertEq(escrow.maxIntentsPerDeposit(), MAX_INTENTS);
    }

    function test_EscrowV2DeploymentSetsIntentExpiration() public view {
        assertEq(escrow.intentExpirationPeriod(), INTENT_EXPIRATION);
    }

    function test_EscrowV2DeploymentWhitelistsEscrow() public view {
        assertTrue(escrowRegistry.isWhitelistedEscrow(address(escrow)));
    }

    function test_OrchestratorV2DeploymentSetsOwner() public view {
        assertEq(orchestrator.owner(), address(this));
    }

    function test_OrchestratorV2DeploymentSetsChainId() public view {
        assertEq(orchestrator.chainId(), block.chainid);
    }

    function test_OrchestratorV2DeploymentWiresEscrowRegistry() public view {
        assertEq(address(orchestrator.escrowRegistry()), address(escrowRegistry));
    }

    function test_OrchestratorV2DeploymentWiresPaymentVerifierRegistry() public view {
        assertEq(address(orchestrator.paymentVerifierRegistry()), address(paymentVerifierRegistry));
    }

    function test_OrchestratorV2DeploymentWiresRelayerRegistry() public view {
        assertEq(address(orchestrator.relayerRegistry()), address(relayerRegistry));
    }

    function test_OrchestratorV2DeploymentSetsProtocolFee() public view {
        assertEq(orchestrator.protocolFee(), PROTOCOL_FEE);
    }

    function test_OrchestratorV2DeploymentSetsProtocolFeeRecipient() public view {
        assertEq(orchestrator.protocolFeeRecipient(), address(this));
    }

    function test_UnifiedPaymentVerifierV2DeploymentSetsOwner() public view {
        assertEq(verifier.owner(), address(this));
    }

    function test_UnifiedPaymentVerifierV2DeploymentWiresOrchestratorRegistry() public view {
        assertEq(address(verifier.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_UnifiedPaymentVerifierV2DeploymentWiresNullifierRegistry() public view {
        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
    }

    function test_RetiredV2VerifierLegacyNullifierPermissionIsRevoked() public view {
        assertFalse(nullifierRegistry.isWriter(address(verifier)));
    }
}
