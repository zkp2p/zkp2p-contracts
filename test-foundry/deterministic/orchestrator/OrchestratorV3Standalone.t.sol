// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

import {OrchestratorV2LifecycleTest} from "./OrchestratorV2Lifecycle.t.sol";
import {OrchestratorV2HooksGovernanceTest} from "./OrchestratorV2HooksGovernance.t.sol";
import {OrchestratorV2RateManagerTest} from "./OrchestratorV2RateManager.t.sol";

contract OrchestratorV3LifecycleTest is OrchestratorV2LifecycleTest {
    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();
    }
}

contract OrchestratorV3HooksGovernanceTest is OrchestratorV2HooksGovernanceTest {
    event IntentFulfilled(
        bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool manual
    );

    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();
    }

    function _usesStandaloneV3Format() internal pure override returns (bool) {
        return true;
    }

    function test_DepositorSetsWhitelistHookAndEmits() public override {
        vm.prank(depositor);
        (bool success,) = address(orchestrator).call(
            abi.encodeWithSignature(
                "setDepositWhitelistHook(address,uint256,address)",
                address(escrow),
                depositId,
                address(whitelistHook)
            )
        );
        assertFalse(success);
    }

    function test_SetDepositWhitelistHookRejectsWhenReentrancyGuardIsEntered() public override {
        vm.prank(depositor);
        (bool success,) = address(orchestrator).call(
            abi.encodeWithSignature(
                "setDepositWhitelistHook(address,uint256,address)",
                address(escrow),
                depositId,
                address(whitelistHook)
            )
        );
        assertFalse(success);
    }

    function test_SignalExecutesBothHooksWithReferralFeeContext() public override {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        IReferralFee.ReferralFee[] memory fees = _twoReferralFees();
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.referralFees = fees;
        _signal(taker, params);
        assertEq(preIntentHook.callCount(), 1);
        assertEq(preIntentHook.lastReferralFeesCount(), 2);
        assertEq(preIntentHook.lastReferralFeesHash(), _referralHash(fees));
    }

    function test_HookGettersExposeIndependentConfiguredHooks() public override {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), depositId)), address(preIntentHook));
        (bool success,) = address(orchestrator).staticcall(
            abi.encodeWithSignature("getDepositWhitelistHook(address,uint256)", address(escrow), depositId)
        );
        assertFalse(success);
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

    function test_GatingRejectsReusedSignature() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        _signal(taker, params);
        vm.expectPartialRevert(IOrchestratorV3.GatingSignatureAlreadyUsed.selector);
        _signalCall(taker, params);
    }

    function test_GatingAcceptsFreshSignatureWithDifferentExpiration() public {
        uint256 gatedDepositId = _newGatedDeposit();
        IOrchestratorV2.SignalIntentParams memory first =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 1 days);
        _signal(taker, first);
        IOrchestratorV2.SignalIntentParams memory second =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, block.timestamp + 2 days);
        assertNotEq(_signal(taker, second), bytes32(0));
    }

    function test_GatingRejectsUnsignedPostIntentHook() public {
        uint256 gatedDepositId = _newGatedDeposit();
        uint256 expiration = block.timestamp + 1 days;
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, expiration);
        params.postIntentHook = postIntentHook;
        vm.expectRevert(IOrchestratorV3.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_GatingRejectsUnsignedData() public {
        uint256 gatedDepositId = _newGatedDeposit();
        uint256 expiration = block.timestamp + 1 days;
        IOrchestratorV2.SignalIntentParams memory params =
            _gatedParams(gatedDepositId, gatingServiceKey, taker, expiration);
        params.data = "different data";
        vm.expectRevert(IOrchestratorV3.InvalidSignature.selector);
        _signalCall(taker, params);
    }

    function test_ManualReleaseRoutesNetThroughConfiguredPostIntentHook() public {
        orchestrator.setProtocolFee(1e16);
        IOrchestratorV2.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(other);
        bytes32 intentHash = _signal(taker, params);
        uint256 recipientBefore = token.balanceOf(other);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(intentHash, address(postIntentHook), 49.5e6, true);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(other) - recipientBefore, 49.5e6);
    }

    function test_ManualReleaseWithoutPostIntentHookTransfersDirectlyToIntentRecipient() public {
        bytes32 intentHash = _signalDefault();
        uint256 recipientBefore = token.balanceOf(taker);
        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit IntentFulfilled(intentHash, taker, INTENT_AMOUNT, true);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(taker) - recipientBefore, INTENT_AMOUNT);
    }
}

contract OrchestratorV3RateManagerTest is OrchestratorV2RateManagerTest {
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
