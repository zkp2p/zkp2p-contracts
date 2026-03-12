// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IPreIntentHook } from "../../contracts/interfaces/IPreIntentHook.sol";
import { IReferralFee } from "../../contracts/interfaces/IReferralFee.sol";
import { ReentrantHookSetterMock } from "../../contracts/mocks/ReentrantHookSetterMock.sol";
import { ReentrantReleaseEscrowMock } from "../../contracts/mocks/ReentrantReleaseEscrowMock.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { OrchestratorV2LegacyTestBase } from "../helpers/OrchestratorV2LegacyTestBase.sol";

contract OrchestratorV2LegacyHooksAndReleaseTest is OrchestratorV2LegacyTestBase {
    event IntentPruned(bytes32 indexed intentHash);
    event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease);
    event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed feeRecipient, uint256 feeAmount);
    event ReentryAttempted(bool success);
    event EscrowRegistryUpdated(address indexed escrowRegistry);
    event ProtocolFeeUpdated(uint256 protocolFee);
    event ProtocolFeeRecipientUpdated(address indexed protocolFeeRecipient);
    event AllowMultipleIntentsUpdated(bool allowMultiple);
    event RelayerRegistryUpdated(address indexed relayerRegistry);

    function setUp() public {
        _setUpOrchestratorV2LegacyHarness();
    }

    function test_cancelIntentCancelsIntentAndUnlocksEscrowFunds() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.expectEmit(true, false, false, false);
        emit IntentPruned(intentHash);

        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);

        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_cancelIntentRevertsWhenIntentDoesNotExist() public {
        bytes32 missingIntentHash = bytes32("missing");

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missingIntentHash));
        orchestrator.cancelIntent(missingIntentHash);
    }

    function test_cancelIntentRevertsWhenCallerIsNotIntentOwner() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCaller.selector, other, taker));
        orchestrator.cancelIntent(intentHash);
    }

    function test_signalIntentExecutesBothPreAndWhitelistHooks() public {
        IReferralFee.ReferralFee[] memory referralFees = _twoReferralFees(referrer, 0.003e18, other, 0.002e18);

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), defaultDepositId, preIntentHookMock);
        vm.prank(depositor);
        orchestrator.setDepositWhitelistHook(address(escrow), defaultDepositId, whitelistHookMock);

        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = referralFees;
        _signalIntent(taker, params);

        bytes32 referralFeesHash = _hashReferralFees(referralFees);
        assertEq(preIntentHookMock.callCount(), 1);
        assertEq(whitelistHookMock.callCount(), 1);
        assertEq(preIntentHookMock.lastReferralFeesCount(), 2);
        assertEq(whitelistHookMock.lastReferralFeesCount(), 2);
        assertEq(preIntentHookMock.lastReferralFeesHash(), referralFeesHash);
        assertEq(whitelistHookMock.lastReferralFeesHash(), referralFeesHash);
    }

    function test_signalIntentBlocksHookReentryIntoSetDepositPreIntentHook() public {
        ReentrantHookSetterMock reentrantHookSetter = new ReentrantHookSetterMock(address(orchestrator));
        reentrantHookSetter.setReplacementHook(preIntentHookMock);

        uint256 hookDepositId = _createDepositWithDelegate(address(0), address(reentrantHookSetter));

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), hookDepositId, reentrantHookSetter);

        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.depositId = hookDepositId;
        _signalIntent(taker, params);

        assertTrue(reentrantHookSetter.reentryAttempted());
        assertFalse(reentrantHookSetter.reentrySucceeded());
        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), hookDepositId)), address(reentrantHookSetter));
    }

    function test_releaseFundsToPayerReleasesFundsFromDepositorToTaker() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.expectEmit(true, true, true, true);
        emit IntentFulfilled(intentHash, taker, 50e6, true);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_releaseFundsToPayerAppliesProtocolAndReferralFees() public {
        vm.prank(owner);
        orchestrator.setProtocolFee(0.01e18);

        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = _singleReferralFee(referrer, 0.005e18);
        bytes32 intentHash = _signalIntent(taker, params);

        uint256 protocolBefore = usdc.balanceOf(protocolFeeRecipient);
        uint256 referrerBefore = usdc.balanceOf(referrer);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        assertGt(usdc.balanceOf(protocolFeeRecipient), protocolBefore);
        assertGt(usdc.balanceOf(referrer), referrerBefore);
    }

    function test_releaseFundsToPayerSplitsReferralFeesAcrossRecipients() public {
        IReferralFee.ReferralFee[] memory referralFees = _twoReferralFees(referrer, 0.003e18, other, 0.002e18);
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = referralFees;
        bytes32 intentHash = _signalIntent(taker, params);

        uint256 referrerBefore = usdc.balanceOf(referrer);
        uint256 otherBefore = usdc.balanceOf(other);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        assertEq(usdc.balanceOf(referrer) - referrerBefore, (50e6 * 0.003e18) / 1e18);
        assertEq(usdc.balanceOf(other) - otherBefore, (50e6 * 0.002e18) / 1e18);
    }

    function test_releaseFundsToPayerEmitsReferralFeeEventsForEachRecipient() public {
        IReferralFee.ReferralFee[] memory referralFees = _twoReferralFees(referrer, 0.003e18, other, 0.002e18);
        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.referralFees = referralFees;
        bytes32 intentHash = _signalIntent(taker, params);

        vm.expectEmit(true, true, true, true);
        emit IntentReferralFeeDistributed(intentHash, referrer, (50e6 * 0.003e18) / 1e18);
        vm.expectEmit(true, true, true, true);
        emit IntentReferralFeeDistributed(intentHash, other, (50e6 * 0.002e18) / 1e18);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_releaseFundsToPayerRevertsWhenIntentDoesNotExist() public {
        bytes32 missingIntentHash = bytes32("missing");

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.IntentNotFound.selector, missingIntentHash));
        orchestrator.releaseFundsToPayer(missingIntentHash);
    }

    function test_releaseFundsToPayerRevertsWhenCallerIsNotDepositor() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.UnauthorizedCaller.selector, other, depositor));
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_releaseFundsToPayerBlocksEscrowTriggeredReentrantReleaseCalls() public {
        ReentrantReleaseEscrowMock reentrantEscrow =
            new ReentrantReleaseEscrowMock(address(usdc), address(orchestrator), depositor, payeeDetails);

        vm.prank(owner);
        escrowRegistry.addEscrow(address(reentrantEscrow));
        vm.prank(owner);
        usdc.transfer(address(reentrantEscrow), 100e6);

        IOrchestratorV2.SignalIntentParams memory params = _buildSignalIntentParams(taker);
        params.escrow = address(reentrantEscrow);
        params.depositId = 0;
        bytes32 intentHash = _signalIntent(taker, params);

        reentrantEscrow.setReentryIntent(intentHash, true);

        vm.expectEmit(false, false, false, true, address(reentrantEscrow));
        emit ReentryAttempted(false);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
    }

    function test_pruneExpiredIntentsPrunesIntentWhenCalledByEscrow() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(defaultDepositId);

        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_cleanupOrphanedIntentsCleansUpOrphanedIntent() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        _clearIntentOrchestrator(intentHash);

        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(defaultDepositId);

        assertEq(orchestrator.getIntent(intentHash).owner, taker);

        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = intentHash;
        orchestrator.cleanupOrphanedIntents(intentHashes);

        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
    }

    function test_cleanupOrphanedIntentsSkipsUnknownIntentHashes() public {
        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = bytes32("unknown-intent");

        orchestrator.cleanupOrphanedIntents(intentHashes);
    }

    function test_cleanupOrphanedIntentsDoesNotPruneActiveIntents() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = intentHash;
        orchestrator.cleanupOrphanedIntents(intentHashes);

        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }

    function test_pruneIntentsIgnoresZeroHashesAndNonEscrowCallers() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        bytes32[] memory intentHashes = new bytes32[](2);
        intentHashes[0] = bytes32(0);
        intentHashes[1] = intentHash;

        vm.prank(other);
        orchestrator.pruneIntents(intentHashes);

        assertEq(orchestrator.getIntent(intentHash).owner, taker);
    }

    function test_governanceUpdatesRegistriesAndFeeConfiguration() public {
        EscrowRegistry newEscrowRegistry = new EscrowRegistry();
        RelayerRegistry newRelayerRegistry = new RelayerRegistry();

        vm.expectEmit(true, false, false, true);
        emit EscrowRegistryUpdated(address(newEscrowRegistry));
        vm.prank(owner);
        orchestrator.setEscrowRegistry(address(newEscrowRegistry));

        vm.expectEmit(false, false, false, true);
        emit ProtocolFeeUpdated(0.01e18);
        vm.prank(owner);
        orchestrator.setProtocolFee(0.01e18);

        vm.expectEmit(true, false, false, true);
        emit ProtocolFeeRecipientUpdated(other);
        vm.prank(owner);
        orchestrator.setProtocolFeeRecipient(other);

        vm.expectEmit(false, false, false, true);
        emit AllowMultipleIntentsUpdated(true);
        vm.prank(owner);
        orchestrator.setAllowMultipleIntents(true);

        vm.expectEmit(true, false, false, true);
        emit RelayerRegistryUpdated(address(newRelayerRegistry));
        vm.prank(owner);
        orchestrator.setRelayerRegistry(address(newRelayerRegistry));

        vm.prank(owner);
        orchestrator.pauseOrchestrator();
        assertTrue(orchestrator.paused());

        vm.prank(owner);
        orchestrator.unpauseOrchestrator();
        assertFalse(orchestrator.paused());
    }

    function test_governanceSettersRevertForInvalidValues() public {
        vm.prank(owner);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setEscrowRegistry(address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        orchestrator.setProtocolFee(0.06e18);

        vm.prank(owner);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setProtocolFeeRecipient(address(0));

        vm.prank(owner);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setRelayerRegistry(address(0));
    }

    function test_governanceFunctionsRevertForNonOwnerCallers() public {
        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.pauseOrchestrator();

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.unpauseOrchestrator();

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setAllowMultipleIntents(true);

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setEscrowRegistry(address(escrowRegistry));

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setProtocolFee(0.01e18);

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setProtocolFeeRecipient(other);

        vm.prank(other);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setRelayerRegistry(address(relayerRegistry));
    }

    function test_gettersReturnAccountIntentAndMinAtSignalSnapshot() public {
        bytes32 intentHash = _signalIntent(taker, _buildSignalIntentParams(taker));

        bytes32[] memory accountIntentHashes = orchestrator.getAccountIntents(taker);
        assertEq(accountIntentHashes.length, 1);
        assertEq(accountIntentHashes[0], intentHash);
        assertEq(orchestrator.getIntentMinAtSignal(intentHash), 10e6);
    }

    function _createDepositWithDelegate(
        address intentGatingService,
        address depositDelegate
    ) internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 500e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(intentGatingService, payeeDetails, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: depositDelegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }
}
