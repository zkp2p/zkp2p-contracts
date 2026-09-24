// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeReferralFixture} from "../helpers/StakeReferralFixture.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeReferralLifecycleHook} from "contracts/interfaces/IStakeReferralLifecycleHook.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {Vm} from "forge-std/Vm.sol";

contract StakeReferralOrchestratorV3Test is StakeReferralFixture {
    function test_BuyerBackerEarnsL1FromPeerWithUnchangedMakerReferralsAndNetOutput() public {
        bytes32 hash = _signal(taker, _feesParams(5e15, referrer));
        IOrchestratorV3.StakeReferral memory referral = orchestrator.getIntentStakeReferral(hash);
        assertEq(referral.recipient, backer);
        assertEq(referral.feeSource, peer);
        assertEq(referral.fee, L1_FEE);
        assertEq(orchestrator.getIntent(hash).referralFees[0].fee, 5e15);
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 200_000);
        assertEq(token.balanceOf(peer), 50_000);
        assertEq(token.balanceOf(referrer), 200_000);
        assertEq(token.balanceOf(other), 50_000);
        assertEq(token.balanceOf(taker), 49_500_000);
        assertEq(orchestrator.getIntentStakeReferral(hash).recipient, address(0));
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
        vm.warp(block.timestamp + 14 days);
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
        protection.releaseMaturedDisputeProtectionIntent(hash);
        assertEq(vault.freeStake(backer), STAKE);
    }

    function test_ReferralAndStakeOwnerChangesAffectOnlyFutureSignals() public {
        bytes32 first = _signal(taker, _feesParams(5e15, referrer));
        _stake(delegate);
        vm.prank(delegate);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(delegate);
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, 2e15);
        bytes32 second = _signal(taker, _feesParams(5e15, referrer));
        vm.prank(backer);
        vault.setTakerAuthorization(taker, false);
        _fulfill(first, INTENT_AMOUNT, CONVERSION_RATE);
        _fulfill(second, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 200_000);
        assertEq(token.balanceOf(delegate), 100_000);
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
        assertEq(vault.lockedStake(delegate), INTENT_AMOUNT);
    }

    function test_PartialSettlementPreservesExactOriginalRounding() public {
        IOrchestratorV3.SignalIntentParams memory params = _feesParams(5e15 + 1, referrer);
        bytes32 hash = _signal(taker, params);
        uint256 release = 1_000_199;
        _fulfill(hash, release, CONVERSION_RATE);
        uint256 originalFees;
        for (uint256 i; i < params.referralFees.length; ++i) {
            originalFees += release * params.referralFees[i].fee / 1e18;
        }
        assertEq(token.balanceOf(taker), release - originalFees);
        assertEq(token.balanceOf(backer), release * L1_FEE / 1e18);
        assertEq(token.balanceOf(peer), release * params.referralFees[0].fee / 1e18 - release * L1_FEE / 1e18);
        assertEq(vault.lockedStake(backer), release);
    }

    function test_ManualReleasePaysReferralAndCancellationDoesNot() public {
        bytes32 cancelled = _signal(taker, _feesParams(5e15, referrer));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        assertEq(orchestrator.getIntentStakeReferral(cancelled).recipient, address(0));
        assertEq(vault.lockedStake(backer), 0);
        assertEq(token.balanceOf(backer), 0);
        bytes32 settled = _signal(taker, _feesParams(5e15, referrer));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(settled);
        assertEq(token.balanceOf(backer), 200_000);
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
    }

    function test_SameWalletCanEarnSellerL1AndBuyerStakeL1() public {
        bytes32 hash = _signal(taker, _feesParams(5e15, backer));
        vm.recordLogs();
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 backerPayouts;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(orchestrator)
                    && logs[i].topics[0] == keccak256("IntentReferralFeeDistributed(bytes32,address,uint256)")
                    && logs[i].topics[2] == bytes32(uint256(uint160(backer)))
            ) {
                ++backerPayouts;
                assertEq(abi.decode(logs[i].data, (uint256)), 400_000);
            }
        }
        assertEq(backerPayouts, 1);
        assertEq(token.balanceOf(backer), 400_000);
        assertEq(token.balanceOf(taker), 49_500_000);
    }

    function test_MissingOrInsufficientPeerBudgetRollsBackCollateralAndIntent() public {
        for (uint256 i; i < 2; ++i) {
            IOrchestratorV3.SignalIntentParams memory params = _feesParams(L1_FEE - 1, referrer);
            uint256 available = L1_FEE - 1;
            if (i == 0) {
                params.referralFees = _emptyReferralFees();
                available = 0;
            }
            uint256 counter = orchestrator.intentCounter();
            vm.expectRevert(
                abi.encodeWithSelector(
                    IOrchestratorV3.InsufficientStakeReferralBudget.selector, peer, available, L1_FEE
                )
            );
            _signalCall(taker, params);
            assertEq(orchestrator.intentCounter(), counter);
            assertEq(vault.lockedStake(backer), 0);
            assertEq(uint256(protection.getDisputeProtectionIntent(_intentHash(counter)).status), 0);
        }
    }

    function test_ExactPeerBudgetPaysBackerWithoutIncreasingTotalFee() public {
        bytes32 hash = _signal(taker, _feesParams(L1_FEE, referrer));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 200_000);
        assertEq(token.balanceOf(peer), 0);
        assertEq(token.balanceOf(taker), 49_550_000);
    }

    function test_SelfStakeDoesNotEarnReferral() public {
        _stake(taker);
        vm.prank(taker);
        vault.clearStakeOwner();
        bytes32 hash = _signal(taker, _feesParams(5e15, referrer));
        assertEq(orchestrator.getIntentStakeReferral(hash).recipient, address(0));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(peer), 250_000);
        assertEq(token.balanceOf(backer), 0);
    }

    function test_WhitelistOptOutAndZeroWindowDoNotEarnWithoutCollateral() public {
        address[] memory allowed = new address[](1);
        allowed[0] = taker;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        bytes32 whitelisted = _signalDefault();
        assertEq(orchestrator.getIntentStakeReferral(whitelisted).recipient, address(0));
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        vm.prank(depositor);
        protection.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        bytes32 optedOut = _signalDefault();
        assertEq(orchestrator.getIntentStakeReferral(optedOut).recipient, address(0));
        vm.prank(depositor);
        protection.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, true);
        protection.setRiskWindow(METHOD, 0);
        bytes32 windowless = _signalDefault();
        assertEq(orchestrator.getIntentStakeReferral(windowless).recipient, address(0));
        assertEq(vault.lockedStake(backer), 0);
    }

    function test_FailedSettlementRollsBackReferralTransfersAndSnapshotCleanup() public {
        bytes32 hash = _signal(taker, _feesParams(5e15, referrer));
        protection.setLifecycleHookAuthorization(address(hook), false);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(hook))
        );
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 0);
        assertEq(token.balanceOf(peer), 0);
        assertEq(orchestrator.getIntentStakeReferral(hash).recipient, backer);
        assertEq(vault.lockedStake(backer), INTENT_AMOUNT);
    }

    function test_DisputeConsumesBackerPrincipalButDoesNotClawBackEarnedReferral() public {
        bytes32 hash = _signal(taker, _feesParams(5e15, referrer));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        bytes32 paymentId = keccak256("payment");
        nullifiers.addWritePermission(address(this));
        nullifiers.addNullifier(keccak256(abi.encodePacked(METHOD, paymentId)), hash);
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails({
                paymentMethod: METHOD,
                originalPaymentId: paymentId,
                disputeId: keccak256("dispute"),
                paymentAmount: 100,
                paymentCurrency: USD
            })
        );
        protection.submitDispute(
            IDisputeVerifier.DisputeAttestation({
                intentHash: hash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
            })
        );
        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.stakeBalance(backer), STAKE - INTENT_AMOUNT);
        assertEq(token.balanceOf(backer), 200_000);
    }

    function test_ConfigurationIsOwnerOnlyAndRejectsInvalidRateSourceAndHook() public {
        vm.prank(taker);
        vm.expectRevert("Ownable: caller is not the owner");
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, L1_FEE);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.InvalidStakeReferralFee.selector, 5e17 + 1));
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, 5e17 + 1);
        vm.expectRevert(IOrchestratorV3.ZeroAddress.selector);
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), address(0), L1_FEE);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.InvalidLifecycleHook.selector, address(0)));
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(0)), peer, L1_FEE);
    }

    function test_DisablingFutureReferralsPreservesAlreadyEarnableReferral() public {
        bytes32 hash = _signal(taker, _feesParams(5e15, referrer));
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, 0);
        bytes32 disabled = _signalDefault();
        assertEq(orchestrator.getIntentStakeReferral(disabled).recipient, address(0));
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 200_000);
    }

    function test_TenRecipientLimitCountsTheAdditionalBacker() public {
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](10);
        params.referralFees[0] = IReferralFee.ReferralFee(peer, 5e15);
        for (uint256 i = 1; i < 10; ++i) {
            params.referralFees[i] = IReferralFee.ReferralFee(address(uint160(1000 + i)), 1e14);
        }
        vm.expectRevert(abi.encodeWithSelector(IReferralFee.ReferralFeeCountExceedsMaximum.selector, 11, 10));
        _signalCall(taker, params);
        assertEq(vault.lockedStake(backer), 0);

        // Replacing the fully consumed donor does not increase the number of paid recipients.
        params.referralFees[0].fee = L1_FEE;
        bytes32 hash = _signal(taker, params);
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 200_000);
        assertEq(token.balanceOf(peer), 0);
    }

    function test_PeerAsBackerReceivesOneUnchangedDonorPayout() public {
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), backer, L1_FEE);
        IOrchestratorV3.SignalIntentParams memory params = _feesParams(5e15, referrer);
        params.referralFees[0].recipient = backer;
        bytes32 hash = _signal(taker, params);
        _fulfill(hash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(backer), 250_000);
        assertEq(token.balanceOf(taker), 49_500_000);
    }

    function test_FundingSourceChangesDoNotAlterExistingSnapshots() public {
        bytes32 first = _signal(taker, _feesParams(5e15, referrer));
        address newPeer = makeAddr("newPeer");
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), newPeer, L1_FEE);
        IOrchestratorV3.SignalIntentParams memory params = _feesParams(5e15, referrer);
        params.referralFees[0].recipient = newPeer;
        bytes32 second = _signal(taker, params);
        assertEq(orchestrator.getIntentStakeReferral(first).feeSource, peer);
        assertEq(orchestrator.getIntentStakeReferral(second).feeSource, newPeer);
        _fulfill(first, INTENT_AMOUNT, CONVERSION_RATE);
        _fulfill(second, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(token.balanceOf(peer), 50_000);
        assertEq(token.balanceOf(newPeer), 50_000);
        assertEq(token.balanceOf(backer), 400_000);
    }
}
