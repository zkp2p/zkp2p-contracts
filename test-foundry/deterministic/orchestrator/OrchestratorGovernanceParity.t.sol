// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorLegacyFixture} from "../helpers/OrchestratorLegacyFixture.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";

contract OrchestratorGovernanceParityTest is OrchestratorLegacyFixture {
    event AllowMultipleIntentsUpdated(bool allowMultiple);
    event PostIntentHookRegistryUpdated(address indexed postIntentHookRegistry);
    event RelayerRegistryUpdated(address indexed relayerRegistry);
    event EscrowRegistryUpdated(address indexed escrowRegistry);
    event ProtocolFeeUpdated(uint256 protocolFee);
    event ProtocolFeeRecipientUpdated(address indexed protocolFeeRecipient);

    uint256 internal constant MAX_PROTOCOL_FEE = 0.1e18;
    string internal constant OWNABLE_ERROR = "Ownable: caller is not the owner";

    function test_SetEscrowRegistryUpdatesAddress() public {
        orchestrator.setEscrowRegistry(onRamper);
        assertEq(address(orchestrator.escrowRegistry()), onRamper);
    }

    function test_SetEscrowRegistryEmitsUpdate() public {
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit EscrowRegistryUpdated(onRamper);
        orchestrator.setEscrowRegistry(onRamper);
    }

    function test_SetEscrowRegistryRejectsNonOwner() public {
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setEscrowRegistry(onRamper);
    }

    function test_SetEscrowRegistryRejectsZeroAddress() public {
        vm.expectRevert(IOrchestrator.ZeroAddress.selector);
        orchestrator.setEscrowRegistry(address(0));
    }

    function test_SetProtocolFeeUpdatesFee() public {
        orchestrator.setProtocolFee(0.02e18);
        assertEq(orchestrator.protocolFee(), 0.02e18);
    }

    function test_SetProtocolFeeEmitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit ProtocolFeeUpdated(0.02e18);
        orchestrator.setProtocolFee(0.02e18);
    }

    function test_SetProtocolFeeRejectsNonOwner() public {
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setProtocolFee(0.02e18);
    }

    function test_SetProtocolFeeRejectsAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IOrchestrator.FeeExceedsMaximum.selector, 0.11e18, MAX_PROTOCOL_FEE));
        orchestrator.setProtocolFee(0.11e18);
    }

    function test_SetProtocolFeeAcceptsMaximum() public {
        orchestrator.setProtocolFee(MAX_PROTOCOL_FEE);
        assertEq(orchestrator.protocolFee(), MAX_PROTOCOL_FEE);
    }

    function test_SetProtocolFeeRecipientUpdatesRecipient() public {
        assertEq(orchestrator.protocolFeeRecipient(), feeRecipient);
        orchestrator.setProtocolFeeRecipient(onRamper);
        assertEq(orchestrator.protocolFeeRecipient(), onRamper);
    }

    function test_SetProtocolFeeRecipientEmitsUpdate() public {
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit ProtocolFeeRecipientUpdated(onRamper);
        orchestrator.setProtocolFeeRecipient(onRamper);
    }

    function test_SetProtocolFeeRecipientRejectsZeroAddress() public {
        vm.expectRevert(IOrchestrator.ZeroAddress.selector);
        orchestrator.setProtocolFeeRecipient(address(0));
    }

    function test_SetProtocolFeeRecipientRejectsNonOwner() public {
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setProtocolFeeRecipient(onRamper);
    }

    function test_SetPostIntentHookRegistryUpdatesRegistry() public {
        PostIntentHookRegistry newRegistry = new PostIntentHookRegistry();
        assertNotEq(address(orchestrator.postIntentHookRegistry()), address(newRegistry));
        orchestrator.setPostIntentHookRegistry(address(newRegistry));
        assertEq(address(orchestrator.postIntentHookRegistry()), address(newRegistry));
    }

    function test_SetPostIntentHookRegistryEmitsUpdate() public {
        PostIntentHookRegistry newRegistry = new PostIntentHookRegistry();
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit PostIntentHookRegistryUpdated(address(newRegistry));
        orchestrator.setPostIntentHookRegistry(address(newRegistry));
    }

    function test_SetPostIntentHookRegistryRejectsZeroAddress() public {
        vm.expectRevert(IOrchestrator.ZeroAddress.selector);
        orchestrator.setPostIntentHookRegistry(address(0));
    }

    function test_SetPostIntentHookRegistryRejectsNonOwner() public {
        PostIntentHookRegistry newRegistry = new PostIntentHookRegistry();
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setPostIntentHookRegistry(address(newRegistry));
    }

    function test_SetRelayerRegistryUpdatesRegistry() public {
        RelayerRegistry newRegistry = new RelayerRegistry();
        assertNotEq(address(orchestrator.relayerRegistry()), address(newRegistry));
        orchestrator.setRelayerRegistry(address(newRegistry));
        assertEq(address(orchestrator.relayerRegistry()), address(newRegistry));
    }

    function test_SetRelayerRegistryEmitsUpdate() public {
        RelayerRegistry newRegistry = new RelayerRegistry();
        vm.expectEmit(true, false, false, false, address(orchestrator));
        emit RelayerRegistryUpdated(address(newRegistry));
        orchestrator.setRelayerRegistry(address(newRegistry));
    }

    function test_SetRelayerRegistryRejectsZeroAddress() public {
        vm.expectRevert(IOrchestrator.ZeroAddress.selector);
        orchestrator.setRelayerRegistry(address(0));
    }

    function test_SetRelayerRegistryRejectsNonOwner() public {
        RelayerRegistry newRegistry = new RelayerRegistry();
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setRelayerRegistry(address(newRegistry));
    }

    function test_SetAllowMultipleIntentsEnablesFlag() public {
        orchestrator.setAllowMultipleIntents(true);
        assertTrue(orchestrator.allowMultipleIntents());
    }

    function test_SetAllowMultipleIntentsEmitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit AllowMultipleIntentsUpdated(true);
        orchestrator.setAllowMultipleIntents(true);
    }

    function test_SetAllowMultipleIntentsDisablesFlag() public {
        orchestrator.setAllowMultipleIntents(true);
        orchestrator.setAllowMultipleIntents(false);
        assertFalse(orchestrator.allowMultipleIntents());
    }

    function test_SetAllowMultipleIntentsRejectsNonOwner() public {
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.setAllowMultipleIntents(true);
    }

    function test_PauseOrchestratorSetsPaused() public {
        orchestrator.pauseOrchestrator();
        assertTrue(orchestrator.paused());
    }

    function test_PauseOrchestratorRejectsNonOwner() public {
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.pauseOrchestrator();
    }

    function test_UnpauseOrchestratorClearsPaused() public {
        orchestrator.pauseOrchestrator();
        orchestrator.unpauseOrchestrator();
        assertFalse(orchestrator.paused());
    }

    function test_UnpauseOrchestratorRejectsNonOwner() public {
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes(OWNABLE_ERROR));
        vm.prank(onRamper);
        orchestrator.unpauseOrchestrator();
    }
}
