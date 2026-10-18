// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4} from "contracts/OrchestratorV4.sol";
import {IWhitelistPolicy} from "contracts/interfaces/IWhitelistPolicy.sol";
import {IIntentSettlementPolicy} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {SettlementPolicyMock} from "../../mocks/SettlementPolicyMock.sol";
import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";

contract OrchestratorV4LifecycleTest is OrchestratorV4Fixture {
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool manual);

    SettlementPolicyMock internal policyMock;

    function setUp() public override {
        super.setUp();
        policyMock = new SettlementPolicyMock();
    }

    function test_SignalWithoutPolicySnapshotsZeroAddress() public {
        bytes32 intentHash = _signalDefault();
        assertEq(address(orchestrator.getIntentSettlementPolicy(intentHash)), address(0));
    }

    function test_SignalWithPolicySnapshotsPolicy() public {
        orchestrator.setSettlementPolicy(IIntentSettlementPolicy(address(policyMock)));

        bytes32 intentHash = _signalDefault();

        assertEq(address(orchestrator.getIntentSettlementPolicy(intentHash)), address(policyMock));
    }

    function test_SettlementCallsPolicyAndFundsFlowNormally() public {
        verifier.setExtensionData(abi.encode(uint256(1)));
        orchestrator.setSettlementPolicy(policyMock);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        bytes32 intentHash = _signal(taker, params);
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 referrerBefore = token.balanceOf(referrer);
        uint256 otherBefore = token.balanceOf(other);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        assertEq(policyMock.settlementCalls(), 1);
        IIntentSettlementPolicy.SettlementContext memory context = policyMock.getLastSettlementContext();
        assertEq(context.intentHash, intentHash);
        assertEq(context.token, address(token));
        assertEq(context.depositor, depositor);
        assertEq(context.taker, taker);
        assertEq(context.recipient, taker);
        assertEq(context.escrow, address(escrow));
        assertEq(context.depositId, depositId);
        assertEq(context.paymentMethod, METHOD);
        assertEq(context.releaseAmount, INTENT_AMOUNT);
        assertEq(context.netAmount, INTENT_AMOUNT - 250_000);
        assertEq(context.data, "");
        assertEq(context.extensionData, abi.encode(uint256(1)));
        assertFalse(context.isManualRelease);
        assertEq(token.balanceOf(referrer) - referrerBefore, 150_000);
        assertEq(token.balanceOf(other) - otherBefore, 100_000);
        assertEq(token.balanceOf(taker) - recipientBefore, INTENT_AMOUNT - 250_000);
    }

    function test_FulfillBelowDepositMinimumSettlesVerifiedAmountAndReturnsRemainder() public {
        uint256 releaseAmount = 5e6;
        bytes32 intentHash = _signalDefault();
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        _fulfill(intentHash, releaseAmount, CONVERSION_RATE);

        assertEq(token.balanceOf(taker) - recipientBefore, releaseAmount);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore + INTENT_AMOUNT - releaseAmount);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_SettlementRevertFailsClosed() public {
        orchestrator.setSettlementPolicy(policyMock);
        policyMock.setRevertOnCallback(true);
        bytes32 intentHash = _signalDefault();
        vm.expectRevert(bytes("risk settlement failed"));
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
    }

    function test_ManualReleaseRoutesThroughPolicyToRecipient() public {
        orchestrator.setSettlementPolicy(policyMock);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.referralFees = _twoReferralFees();
        params.to = delegate;
        bytes32 intentHash = _signal(taker, params);
        uint256 recipientBefore = token.balanceOf(taker);
        uint256 hookRecipientBefore = token.balanceOf(delegate);
        uint256 netAmount = INTENT_AMOUNT - 250_000;
        vm.expectEmit(true, true, true, true);
        emit IntentFulfilled(intentHash, delegate, netAmount, true);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(policyMock.settlementCalls(), 1);
        (,,,,,,,,,, bytes memory policyData, bytes memory extensionData, bool isManualRelease) = policyMock.lastSettlementContext();
        assertEq(policyData, "");
        assertEq(extensionData, "");
        assertTrue(isManualRelease);
        assertEq(token.balanceOf(taker), recipientBefore);
        assertEq(token.balanceOf(delegate) - hookRecipientBefore, netAmount);
        assertEq(postIntentHook.lastPostIntentHookData(), "");
    }

    function test_GovernancePolicySetterValidatesOwnerAndCode() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(other);
        orchestrator.setSettlementPolicy(policyMock);
        orchestrator.setSettlementPolicy(policyMock);
        assertEq(address(orchestrator.settlementPolicy()), address(policyMock));
        orchestrator.setSettlementPolicy(IIntentSettlementPolicy(address(0)));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.InvalidSettlementPolicy.selector, other));
        orchestrator.setSettlementPolicy(IIntentSettlementPolicy(other));
    }

    function test_DepositWhitelistSelectorsNoLongerExist() public view {
        (bool setter,) = address(orchestrator)
            .staticcall(
                abi.encodeWithSignature(
                    "setDepositWhitelistHook(address,uint256,address)", address(escrow), depositId, address(0)
                )
            );
        (bool getter,) = address(orchestrator)
            .staticcall(abi.encodeWithSignature("getDepositWhitelistHook(address,uint256)", address(escrow), depositId));
        assertFalse(setter);
        assertFalse(getter);
    }

    function test_IntentMinAtSignalGetterNoLongerExists() public view {
        (bool success,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("getIntentMinAtSignal(bytes32)", bytes32(0)));
        assertFalse(success);
    }
    function test_SignalDoesNotCallPolicy() public {
        orchestrator.setSettlementPolicy(policyMock);
        vm.mockCallRevert(address(policyMock), bytes(""), bytes("policy called"));
        bytes32 id = _signalDefault();
        assertEq(address(orchestrator.getIntentSettlementPolicy(id)), address(policyMock));
    }

    function test_CancelAndPruneDoNotCallPolicyAndClearSnapshot() public {
        orchestrator.setSettlementPolicy(policyMock);
        bytes32 cancelled = _signalDefault();
        bytes32 expired = _signalDefault();
        vm.mockCallRevert(address(policyMock), bytes(""), bytes("policy called"));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        assertEq(orchestrator.getIntent(cancelled).owner, address(0));
        assertEq(orchestrator.getIntent(expired).owner, address(0));
        assertEq(address(orchestrator.getIntentSettlementPolicy(cancelled)), address(0));
        assertEq(address(orchestrator.getIntentSettlementPolicy(expired)), address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
    }

    function test_OrphanCleanupDoesNotCallPolicyAndClearsSnapshot() public {
        orchestrator.setSettlementPolicy(policyMock);
        bytes32 id = _signalDefault();
        vm.store(address(escrow), keccak256(abi.encode(id, uint256(15))), bytes32(0));
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        vm.mockCallRevert(address(policyMock), bytes(""), bytes("policy called"));
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        orchestrator.cleanupOrphanedIntents(ids);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(address(orchestrator.getIntentSettlementPolicy(id)), address(0));
    }

    function test_PolicyReplacementOnlyAffectsNewIntents() public {
        orchestrator.setSettlementPolicy(policyMock);
        bytes32 first = _signalDefault();
        SettlementPolicyMock next = new SettlementPolicyMock();
        next.setDeferralVault(address(next));
        orchestrator.setSettlementPolicy(next);
        bytes32 second = _signalDefault();
        _fulfill(first, INTENT_AMOUNT, CONVERSION_RATE);
        _fulfill(second, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(policyMock.settlementCalls(), 1);
        assertEq(next.settlementCalls(), 1);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(next)), INTENT_AMOUNT);
    }

    function test_ZeroPolicySnapshotPaysNowAfterPolicyEnabled() public {
        bytes32 id = _signalDefault();
        policyMock.setRevertOnCallback(true);
        orchestrator.setSettlementPolicy(policyMock);
        _fulfill(id, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(policyMock.settlementCalls(), 0);
    }

    function test_WhitelistAdmissionAppliesWithZeroPolicyAndUsesTakerNotRecipient() public {
        address[] memory allowed = new address[](1);
        allowed[0] = other;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.to = other;
        relayerRegistry.addRelayer(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker));
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), 0);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
        allowed[0] = taker;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        bytes32 id = _signal(taker, params);
        assertEq(orchestrator.getIntent(id).owner, taker);
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        _signal(other, params);
    }

    function test_ConstructorRequiresDeployedWhitelist() public {
        vm.expectRevert(IOrchestratorV4.ZeroAddress.selector);
        new OrchestratorV4(address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry), address(relayerRegistry), 0, protocolFeeRecipient, IWhitelistPolicy(address(0)));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.InvalidWhitelistPolicy.selector, other));
        new OrchestratorV4(address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry), address(relayerRegistry), 0, protocolFeeRecipient, IWhitelistPolicy(other));
    }

}
