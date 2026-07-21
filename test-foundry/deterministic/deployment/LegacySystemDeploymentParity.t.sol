// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "contracts/Escrow.sol";
import {Orchestrator} from "contracts/Orchestrator.sol";
import {ProtocolViewer} from "contracts/ProtocolViewer.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";

contract LegacySystemDeploymentParityTest is Test {
    uint256 internal constant PROTOCOL_FEE = 0.001e18;
    uint256 internal constant DUST_THRESHOLD = 0.1e6;
    uint256 internal constant MAX_INTENTS = 100;
    uint256 internal constant INTENT_EXPIRATION = 1 days;

    Escrow internal escrow;
    Orchestrator internal orchestrator;
    NullifierRegistry internal nullifierRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    PostIntentHookRegistry internal postIntentHookRegistry;
    RelayerRegistry internal relayerRegistry;
    ProtocolViewer internal protocolViewer;
    EscrowRegistry internal escrowRegistry;

    function setUp() public {
        paymentVerifierRegistry = new PaymentVerifierRegistry();
        postIntentHookRegistry = new PostIntentHookRegistry();
        relayerRegistry = new RelayerRegistry();
        nullifierRegistry = new NullifierRegistry();
        escrowRegistry = new EscrowRegistry();
        escrow = new Escrow(
            address(this),
            block.chainid,
            address(paymentVerifierRegistry),
            address(this),
            DUST_THRESHOLD,
            MAX_INTENTS,
            INTENT_EXPIRATION
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestrator = new Orchestrator(
            address(this),
            block.chainid,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            PROTOCOL_FEE,
            address(this)
        );
        escrow.setOrchestrator(address(orchestrator));
        protocolViewer = new ProtocolViewer(address(escrow), address(orchestrator));
    }

    function test_EscrowRegistryDeploymentSetsOwner() public view {
        assertEq(escrowRegistry.owner(), address(this));
    }

    function test_EscrowDeploymentSetsOwner() public view {
        assertEq(escrow.owner(), address(this));
    }

    function test_EscrowDeploymentSetsPaymentVerifierRegistry() public view {
        assertEq(address(escrow.paymentVerifierRegistry()), address(paymentVerifierRegistry));
    }

    function test_EscrowDeploymentWiresOrchestrator() public view {
        assertEq(address(escrow.orchestrator()), address(orchestrator));
    }

    function test_EscrowDeploymentSetsChainId() public view {
        assertEq(escrow.chainId(), block.chainid);
    }

    function test_EscrowDeploymentWhitelistsEscrow() public view {
        assertTrue(escrowRegistry.isWhitelistedEscrow(address(escrow)));
    }

    function test_EscrowDeploymentSetsDustRecipient() public view {
        assertEq(escrow.dustRecipient(), address(this));
    }

    function test_EscrowDeploymentSetsDustThreshold() public view {
        assertEq(escrow.dustThreshold(), DUST_THRESHOLD);
    }

    function test_EscrowDeploymentSetsMaximumIntents() public view {
        assertEq(escrow.maxIntentsPerDeposit(), MAX_INTENTS);
    }

    function test_EscrowDeploymentSetsIntentExpiration() public view {
        assertEq(escrow.intentExpirationPeriod(), INTENT_EXPIRATION);
    }

    function test_OrchestratorDeploymentSetsOwner() public view {
        assertEq(orchestrator.owner(), address(this));
    }

    function test_OrchestratorDeploymentSetsChainId() public view {
        assertEq(orchestrator.chainId(), block.chainid);
    }

    function test_OrchestratorDeploymentSetsProtocolFeeAndRecipient() public view {
        assertEq(orchestrator.protocolFee(), PROTOCOL_FEE);
        assertEq(orchestrator.protocolFeeRecipient(), address(this));
    }

    function test_OrchestratorDeploymentWiresPostIntentHookRegistry() public view {
        assertEq(address(orchestrator.postIntentHookRegistry()), address(postIntentHookRegistry));
    }

    function test_OrchestratorDeploymentWiresRelayerRegistry() public view {
        assertEq(address(orchestrator.relayerRegistry()), address(relayerRegistry));
    }

    function test_OrchestratorDeploymentWiresEscrowRegistry() public view {
        assertEq(address(orchestrator.escrowRegistry()), address(escrowRegistry));
    }

    function test_NullifierRegistryDeploymentSetsOwner() public view {
        assertEq(nullifierRegistry.owner(), address(this));
    }

    function test_PaymentVerifierRegistryDeploymentSetsOwner() public view {
        assertEq(paymentVerifierRegistry.owner(), address(this));
    }

    function test_PostIntentHookRegistryDeploymentSetsOwner() public view {
        assertEq(postIntentHookRegistry.owner(), address(this));
    }

    function test_RelayerRegistryDeploymentSetsOwner() public view {
        assertEq(relayerRegistry.owner(), address(this));
    }

    function test_ProtocolViewerDeploymentWiresEscrowAndOrchestrator() public view {
        assertEq(address(protocolViewer.escrowContract()), address(escrow));
        assertEq(address(protocolViewer.orchestrator()), address(orchestrator));
    }
}
