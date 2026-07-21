// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";

import {OrchestratorV2LifecycleParityTest} from "./OrchestratorV2LifecycleParity.t.sol";
import {OrchestratorV2HooksGovernanceParityTest} from "./OrchestratorV2HooksGovernanceParity.t.sol";
import {OrchestratorV2RateManagerParityTest} from "./OrchestratorV2RateManagerParity.t.sol";

contract OrchestratorV3LifecycleParityTest is OrchestratorV2LifecycleParityTest {
    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();
    }
}

contract OrchestratorV3HooksGovernanceParityTest is OrchestratorV2HooksGovernanceParityTest {
    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();
    }

    function test_GovernanceUpdatesRegistriesFeesAndPauseState() public override {
        EscrowRegistry newRegistry = new EscrowRegistry();
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit EscrowRegistryUpdated(address(newRegistry));
        orchestrator.setEscrowRegistry(address(newRegistry));
        vm.expectEmit(false, false, false, true, address(orchestrator));
        emit ProtocolFeeUpdated(1e16);
        orchestrator.setProtocolFee(1e16);
        vm.expectEmit(true, false, false, true, address(orchestrator));
        emit ProtocolFeeRecipientUpdated(other);
        orchestrator.setProtocolFeeRecipient(other);
        orchestrator.pauseOrchestrator();
        assertTrue(orchestrator.paused());
        orchestrator.unpauseOrchestrator();
        assertFalse(orchestrator.paused());
    }

    function test_GovernanceRejectsInvalidSetterValues() public override {
        vm.expectRevert(IOrchestratorV3.ZeroAddress.selector);
        orchestrator.setEscrowRegistry(address(0));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.FeeExceedsMaximum.selector, 6e16, 5e16));
        orchestrator.setProtocolFee(6e16);
        vm.expectRevert(IOrchestratorV3.ZeroAddress.selector);
        orchestrator.setProtocolFeeRecipient(address(0));
    }

    function test_GovernanceRejectsEveryNonOwnerCall() public override {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.pauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.unpauseOrchestrator();
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setEscrowRegistry(address(escrowRegistry));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFee(1e16);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        orchestrator.setProtocolFeeRecipient(other);
        vm.stopPrank();
    }

    function test_AccountWithActiveIntentRevertsWhenMultipleIntentsDisabled() public override {
        bytes32 first = _signalDefault();
        bytes32 second = _signalDefault();
        bytes32[] memory accountIntents = orchestrator.getAccountIntents(taker);
        assertEq(accountIntents.length, 2);
        assertEq(accountIntents[0], first);
        assertEq(accountIntents[1], second);
    }
}

contract OrchestratorV3RateManagerParityTest is OrchestratorV2RateManagerParityTest {
    function setUp() public override {
        super.setUp();
        orchestrator = OrchestratorV2(
            address(
                new OrchestratorV3(
                    address(this),
                    1,
                    address(escrowRegistry),
                    address(paymentVerifierRegistry),
                    0,
                    address(this),
                    2_000_000
                )
            )
        );
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
    }

    function test_GovernanceCanAllowOrdinaryAccountMultipleConcurrentIntents() public override {
        bytes32 firstIntentHash = _signal(MANAGER_RATE);
        bytes32 secondIntentHash = _signal(MANAGER_RATE);
        assertNotEq(firstIntentHash, secondIntentHash);
        assertEq(orchestrator.getAccountIntents(taker).length, 2);
    }

    function test_OrdinaryAccountWithActiveIntentRevertsWhenMultipleDisabled() public override {
        bytes32 firstIntentHash = _signal(MANAGER_RATE);
        bytes32 secondIntentHash = _signal(MANAGER_RATE);
        assertNotEq(firstIntentHash, secondIntentHash);
        assertEq(orchestrator.getAccountIntents(taker).length, 2);
    }

    function test_WhitelistedRelayerCanKeepMultipleIntentsWhenGlobalMultipleDisabled() public view override {
        (bool relayerGetter,) = address(orchestrator).staticcall(abi.encodeWithSignature("relayerRegistry()"));
        (bool relayerSetter,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("setRelayerRegistry(address)", address(this)));
        (bool multipleGetter,) = address(orchestrator).staticcall(abi.encodeWithSignature("allowMultipleIntents()"));
        (bool multipleSetter,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("setAllowMultipleIntents(bool)", true));
        assertFalse(relayerGetter);
        assertFalse(relayerSetter);
        assertFalse(multipleGetter);
        assertFalse(multipleSetter);
    }
}
