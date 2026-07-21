// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVaultLegacyFixture} from "../helpers/StakeVaultLegacyFixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {Vm} from "forge-std/Vm.sol";

contract StakeVaultDeferredParityTest is StakeVaultLegacyFixture {
    event StakeReserved(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed controller,
        uint256 amount,
        uint256 totalReserved,
        uint64 releaseTime
    );
    event DeferredStakeFunded(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        uint64 releaseTime
    );
    event DeferredStakeSlashed(
        bytes32 indexed intentHash,
        address indexed staker,
        address indexed maker,
        uint256 slashedGrossAmount,
        uint256 cancelledFeeAmount
    );
    event DeferredStakeReleased(
        bytes32 indexed intentHash,
        address indexed staker,
        uint256 releasedGrossAmount,
        uint256 vestedFeeAmount,
        uint256 netStakeReleased
    );

    function _fees(address protocol, uint256 protocolAmount, address referrer, uint256 referrerAmount)
        internal
        pure
        returns (IIntentRiskHook.FeeAllocation[] memory fees)
    {
        fees = new IIntentRiskHook.FeeAllocation[](2);
        fees[0] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.PROTOCOL, recipient: protocol, amount: protocolAmount
        });
        fees[1] = IIntentRiskHook.FeeAllocation({
            feeType: IIntentRiskHook.FeeType.REFERRAL, recipient: referrer, amount: referrerAmount
        });
    }

    function _authorize(bytes32 intentHash, uint64 releaseTime) internal {
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, releaseTime);
    }

    function _fund(bytes32 intentHash, uint256 gross, uint64 releaseTime, IIntentRiskHook.FeeAllocation[] memory fees)
        internal
    {
        token.transfer(address(vault), gross);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, gross, releaseTime, fees);
    }

    function test_DeferredTerminalEventsNameAmountsByAccountingOutcome() public {
        bytes32 slashedIntent = keccak256("terminal-slashed");
        _authorize(slashedIntent, 0);
        _fund(slashedIntent, 100e6, 0, _fees(recipient, 2e6, maker, 1e6));
        vm.expectEmit(true, true, true, true, address(vault));
        emit DeferredStakeSlashed(slashedIntent, staker, maker, 100e6, 3e6);
        vm.prank(controller);
        vault.slashDeferredStake(slashedIntent, maker);

        bytes32 releasedIntent = keccak256("terminal-released");
        uint64 releaseTime = uint64(block.timestamp + DAY);
        _authorize(releasedIntent, releaseTime);
        _fund(releasedIntent, 100e6, releaseTime, _fees(recipient, 2e6, maker, 1e6));
        vm.warp(releaseTime);
        vm.expectEmit(true, true, false, true, address(vault));
        emit DeferredStakeReleased(releasedIntent, staker, 100e6, 3e6, 97e6);
        vm.prank(controller);
        vault.releaseDeferredStake(releasedIntent);
    }

    function test_DeferredFundingConvertsGrossToFullyReservedRecipientStake() public {
        bytes32 intentHash = keccak256("deferred");
        uint64 releaseTime = uint64(block.timestamp + DAY);
        _authorize(intentHash, releaseTime);
        token.transfer(address(vault), 100e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit StakeReserved(intentHash, staker, controller, 100e6, 100e6, releaseTime);
        vm.expectEmit(true, true, false, true, address(vault));
        emit DeferredStakeFunded(intentHash, staker, 100e6, 3e6, 97e6, releaseTime);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 100e6, releaseTime, _fees(maker, 2e6, recipient, 1e6));
        IStakeVault.DeferredStake memory deferredStake = vault.getDeferredStake(intentHash);
        assertEq(deferredStake.grossAmount, 100e6);
        assertEq(deferredStake.feeAmount, 3e6);
        assertEq(vault.stakeBalance(staker), 100e6);
        assertEq(vault.reservedStake(staker), 100e6);
        assertEq(vault.freeStake(staker), 0);
        assertEq(vault.totalDeferredFees(), 3e6);
        assertEq(vault.totalLiabilities(), 100e6);
        assertEq(vault.getDeferredFeeAllocations(intentHash).length, 2);
    }

    function test_DeferredFundingRejectsMissingBackingTokens() public {
        bytes32 intentHash = keccak256("deferred");
        _authorize(intentHash, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientUnaccountedTokens.selector, 0, 1e6));
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 1e6, 0, new IIntentRiskHook.FeeAllocation[](0));
    }

    function test_DeferredFundingRejectsZeroOwnerAndGrossAmount() public {
        bytes32 intentHash = keccak256("invalid-deferred-funding-inputs");
        _authorize(intentHash, 0);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, address(0), 1e6, 0, new IIntentRiskHook.FeeAllocation[](0));

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 0, 0, new IIntentRiskHook.FeeAllocation[](0));
    }

    function test_DeferredFundingRejectsDuplicateAndWrongOwner() public {
        bytes32 fundedIntent = keccak256("duplicate-deferred-funding");
        _authorize(fundedIntent, 0);
        _fund(fundedIntent, 100e6, 0, new IIntentRiskHook.FeeAllocation[](0));
        token.transfer(address(vault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeAlreadyFunded.selector, fundedIntent, 100e6));
        vm.prank(controller);
        vault.recordDeferredStake(fundedIntent, staker, 100e6, 0, new IIntentRiskHook.FeeAllocation[](0));

        bytes32 wrongOwnerIntent = keccak256("wrong-deferred-owner");
        _authorize(wrongOwnerIntent, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeOwnerMismatch.selector, staker, maker));
        vm.prank(controller);
        vault.recordDeferredStake(wrongOwnerIntent, maker, 1e6, 0, new IIntentRiskHook.FeeAllocation[](0));
    }

    function test_DeferredFundingRejectsExistingReservation() public {
        bytes32 intentHash = keccak256("deferred-reservation-conflict");
        _deposit(10e6);
        _authorize(intentHash, 0);
        _reserve(intentHash, 1e6, 0);
        token.transfer(address(vault), 1e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ReservationAlreadyExists.selector, intentHash));
        vm.prank(controller);
        vault.recordDeferredStake(intentHash, staker, 1e6, 0, new IIntentRiskHook.FeeAllocation[](0));
    }

    function test_DeferredFundingRejectsInvalidFeePlan() public {
        bytes32 zeroRecipientIntent = keccak256("zero-deferred-fee-recipient");
        _authorize(zeroRecipientIntent, 0);
        IIntentRiskHook.FeeAllocation[] memory zeroRecipient = _fees(address(0), 1e6, maker, 0);
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.recordDeferredStake(zeroRecipientIntent, staker, 2e6, 0, zeroRecipient);

        bytes32 excessiveFeeIntent = keccak256("excessive-deferred-fee");
        _authorize(excessiveFeeIntent, 0);
        IIntentRiskHook.FeeAllocation[] memory excessiveFee = _fees(maker, 2e6, recipient, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidDeferredFeeTotal.selector, 2e6, 2e6));
        vm.prank(controller);
        vault.recordDeferredStake(excessiveFeeIntent, staker, 2e6, 0, excessiveFee);
    }

    function test_DeferredMaturityVestsFeesAndLeavesReusableNetStake() public {
        bytes32 intentHash = keccak256("deferred");
        uint64 releaseTime = uint64(block.timestamp + DAY);
        _authorize(intentHash, releaseTime);
        _fund(intentHash, 100e6, releaseTime, _fees(maker, 2e6, recipient, 1e6));
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.DeferredStakeNotMature.selector, releaseTime, uint64(block.timestamp))
        );
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);
        vm.warp(releaseTime);
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);
        assertEq(vault.stakeBalance(staker), 97e6);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.freeStake(staker), 97e6);
        assertEq(vault.claimableFees(maker), 2e6);
        assertEq(vault.claimableFees(recipient), 1e6);
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(vault.totalLiabilities(), 100e6);
        vault.withdrawFeeClaimFor(maker);
        vault.withdrawFeeClaimFor(recipient);
        assertEq(token.balanceOf(maker), 2e6);
        assertEq(token.balanceOf(recipient), 1e6);
        assertEq(vault.totalLiabilities(), 97e6);
    }

    function test_FeeOwnerCanWithdrawClaimToChosenRecipient() public {
        bytes32 intentHash = keccak256("owner-fee-withdrawal");
        _authorize(intentHash, uint64(block.timestamp));
        _fund(intentHash, 100e6, uint64(block.timestamp), _fees(maker, 2e6, recipient, 1e6));
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);

        uint256 balanceBefore = token.balanceOf(recipient);
        vm.prank(maker);
        vault.withdrawFeeClaim(recipient);
        assertEq(token.balanceOf(recipient), balanceBefore + 2e6);
        assertEq(vault.claimableFees(maker), 0);
    }

    function test_FeeClaimsRejectZeroAddressesAndEmptyBalance() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.withdrawFeeClaimFor(address(0));

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(maker);
        vault.withdrawFeeClaim(address(0));

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(maker);
        vault.withdrawFeeClaim(recipient);
    }

    function test_DeferredFeesAggregateDuplicateRecipients() public {
        bytes32 intentHash = keccak256("duplicate-fee-recipient");
        uint64 releaseTime = uint64(block.timestamp + DAY);
        _authorize(intentHash, releaseTime);
        _fund(intentHash, 100e6, releaseTime, _fees(maker, 2e6, maker, 1e6));
        vm.warp(releaseTime);
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);
        assertEq(vault.claimableFees(maker), 3e6);
        assertEq(vault.totalClaimableFees(), 3e6);
        assertEq(vault.stakeBalance(staker), 97e6);
        assertEq(vault.totalLiabilities(), 100e6);
    }

    function test_DeferredFundingDropsZeroRoundedFeeAllocations() public {
        bytes32 intentHash = keccak256("zero-rounded-deferred-fee");
        uint64 releaseTime = uint64(block.timestamp + DAY);
        _authorize(intentHash, releaseTime);
        _fund(intentHash, 100e6, releaseTime, _fees(maker, 0, recipient, 1e6));
        IIntentRiskHook.FeeAllocation[] memory stored = vault.getDeferredFeeAllocations(intentHash);
        assertEq(stored.length, 1);
        assertEq(stored[0].recipient, recipient);
        assertEq(vault.getDeferredStake(intentHash).feeAmount, 1e6);
        vm.warp(releaseTime);
        vm.recordLogs();
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 vestedSignature = keccak256("DeferredFeeVested(bytes32,address,uint8,uint256,uint256)");
        uint256 vestedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics.length > 0 && logs[i].topics[0] == vestedSignature)
            {
                vestedCount++;
            }
        }
        assertEq(vestedCount, 1);
        assertEq(vault.claimableFees(maker), 0);
        assertEq(vault.claimableFees(recipient), 1e6);
    }

    function test_DeferredSlashCreditsGrossAndCancelsContingentFees() public {
        bytes32 intentHash = keccak256("deferred");
        _authorize(intentHash, 0);
        _fund(intentHash, 100e6, 0, _fees(recipient, 2e6, maker, 0));
        vm.prank(controller);
        vault.slashDeferredStake(intentHash, maker);
        assertEq(vault.getDeferredStake(intentHash).grossAmount, 0);
        assertEq(vault.stakeBalance(staker), 0);
        assertEq(vault.reservedStake(staker), 0);
        assertEq(vault.claimableCompensation(maker), 100e6);
        assertEq(vault.claimableFees(recipient), 0);
        assertEq(vault.totalDeferredFees(), 0);
        assertEq(vault.totalLiabilities(), 100e6);
    }

    function test_DeferredAuthorizationRejectsReservationsPause() public {
        vault.setStakeOperationsPaused(false, true);
        vm.expectRevert(StakeVault.StakeActionPaused.selector);
        vm.prank(controller);
        vault.authorizeDeferredStake(keccak256("deferred"), staker, 0);
    }

    function test_DeferredAuthorizationRejectsZeroStakerAndDuplicate() public {
        bytes32 intentHash = keccak256("invalid-deferred-authorization");
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, address(0), 0);

        _authorize(intentHash, 0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeAlreadyExists.selector, intentHash));
        vm.prank(controller);
        vault.authorizeDeferredStake(intentHash, staker, 0);
    }

    function test_DeferredAuthorizationRejectsExitingStaker() public {
        _deposit(1e6);
        vm.prank(staker);
        vault.requestExit();
        vm.expectRevert(abi.encodeWithSelector(StakeVault.AlreadyExiting.selector, staker));
        vm.prank(controller);
        vault.authorizeDeferredStake(keccak256("deferred"), staker, 0);
    }

    function test_DeferredAuthorizationCanBeReleasedBeforeFunding() public {
        bytes32 intentHash = keccak256("released-authorization");
        _authorize(intentHash, uint64(block.timestamp + DAY));
        vm.prank(controller);
        vault.releaseDeferredStakeAuthorization(intentHash);
        assertEq(vault.getDeferredStake(intentHash).staker, address(0));
    }

    function test_DeferredAuthorizationReleaseRejectsMissingFundedAndWrongController() public {
        bytes32 missingIntent = keccak256("missing-authorization");
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeNotFound.selector, missingIntent));
        vm.prank(controller);
        vault.releaseDeferredStakeAuthorization(missingIntent);

        bytes32 fundedIntent = keccak256("funded-authorization");
        _authorize(fundedIntent, uint64(block.timestamp + DAY));
        _fund(fundedIntent, 100e6, uint64(block.timestamp + DAY), new IIntentRiskHook.FeeAllocation[](0));
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeAlreadyFunded.selector, fundedIntent, 100e6));
        vm.prank(controller);
        vault.releaseDeferredStakeAuthorization(fundedIntent);

        bytes32 wrongControllerIntent = keccak256("wrong-controller-authorization");
        _authorize(wrongControllerIntent, uint64(block.timestamp + DAY));
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedPositionController.selector, maker, controller));
        vm.prank(maker);
        vault.releaseDeferredStakeAuthorization(wrongControllerIntent);
    }

    function test_DeferredTerminalCallsRejectMissingPositionsAndZeroMaker() public {
        bytes32 intentHash = keccak256("missing-deferred-terminal");
        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeNotFound.selector, intentHash));
        vm.prank(controller);
        vault.releaseDeferredStake(intentHash);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.slashDeferredStake(intentHash, address(0));

        vm.expectRevert(abi.encodeWithSelector(StakeVault.DeferredStakeNotFound.selector, intentHash));
        vm.prank(controller);
        vault.slashDeferredStake(intentHash, maker);
    }

    function test_PreAuthorizedDeferredStakeFundsWhileReservationsPaused() public {
        bytes32 intentHash = keccak256("deferred");
        _authorize(intentHash, DAY);
        vault.setStakeOperationsPaused(false, true);
        _fund(intentHash, 100e6, 2 * DAY, new IIntentRiskHook.FeeAllocation[](0));
        assertEq(vault.getDeferredStake(intentHash).grossAmount, 100e6);
    }
}
