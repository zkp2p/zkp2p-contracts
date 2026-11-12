// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {BondedArbitratorFixture} from "../helpers/BondedArbitratorFixture.sol";
import {BondedArbitrator} from "contracts/BondedArbitrator.sol";
import {IntentSignalPolicyV2} from "contracts/hooks/IntentSignalPolicyV2.sol";
import {IBondedArbitrator} from "contracts/interfaces/IBondedArbitrator.sol";
import {INonPaymentVerifier} from "contracts/interfaces/INonPaymentVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {NonPaymentVerifier} from "contracts/unifiedVerifier/NonPaymentVerifier.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract BondedArbitratorTest is BondedArbitratorFixture {
    event DustToleranceSet(uint256 previousTolerance, uint256 newTolerance);
    event DustShareSet(uint256 previousShareBps, uint256 newShareBps);

    function test_SignalNamesBondedArbitrator() public {
        bytes32 id = _signal(taker, _defaultParams());
        assertEq(orchestrator.getIntent(id).arbitrator, address(arbitrator));
    }

    function test_ReleasePaysRecipientNowAndLocksBond() public {
        bytes32 id = _signal(taker, _defaultParams());
        uint256 before = token.balanceOf(other);

        vm.prank(operator);
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));

        assertEq(token.balanceOf(other) - before, NET);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(vault.lockedStake(treasury), INTENT_AMOUNT);
        assertEq(vault.freeStake(treasury), BOND - INTENT_AMOUNT);
        assertEq(arbitrator.operatorLocked(operator), INTENT_AMOUNT);
        (address owner, uint256 amount, uint64 maturesAt) = vault.locks(arbitrator.lockId(id));
        assertEq(owner, treasury);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, block.timestamp + WINDOW);
    }

    function test_PartialReleaseReturnsRestToDeposit() public {
        bytes32 id = _signal(taker, _defaultParams());
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));
        claim.amount = 30e6;

        vm.prank(operator);
        arbitrator.release(id, 30e6, claim);

        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore + 20e6);
        assertEq(vault.lockedStake(treasury), 30e6);
    }

    function test_DisputeMovesBondToDepositor() public {
        bytes32 id = _release();
        uint64 scannedAt = uint64(block.timestamp + 3 days);
        vm.warp(scannedAt);

        arbitrator.disputeNonPayment(_scan(id, PAYEE, scannedAt));

        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.stakeBalance(treasury), BOND - INTENT_AMOUNT);
        assertEq(vault.lockedStake(treasury), 0);
        assertEq(arbitrator.operatorLocked(operator), 0);
        assertEq(arbitrator.getRelease(id).operator, address(0));
        vm.prank(depositor);
        vault.claim();
        assertEq(vault.claimable(depositor), 0);
    }

    function test_DisputePaysOnlyTheShortfall() public {
        bytes32 id = _release();
        // The buyer sent 30 of the 50 claimed: the maker is owed 20, and 30 returns to the bond owner.
        arbitrator.disputeNonPayment(_scanFull(id, PAYEE, uint64(block.timestamp), 30e6, new bytes32[](0)));

        assertEq(vault.claimable(depositor), 20e6);
        assertEq(vault.stakeBalance(treasury), BOND - 20e6);
        assertEq(vault.lockedStake(treasury), 0);
        assertEq(arbitrator.operatorLocked(operator), 0);
    }

    function test_DisputeRevertsWhenPaymentCovered() public {
        bytes32 id = _release();
        INonPaymentVerifier.NonPaymentAttestation memory scan =
            _scanFull(id, PAYEE, uint64(block.timestamp), INTENT_AMOUNT, new bytes32[](0));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.PaymentCovered.selector, INTENT_AMOUNT, INTENT_AMOUNT));
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputeRevertsWhenShortfallIsDust() public {
        bytes32 id = _release();
        assertEq(arbitrator.dustTolerance(), 0.5e6);
        // The buyer sent 49.50 of the 50 claimed: a 0.50 shortfall is within the default tolerance and is 1%.
        uint256 received = INTENT_AMOUNT - 0.5e6;
        INonPaymentVerifier.NonPaymentAttestation memory scan =
            _scanFull(id, PAYEE, uint64(block.timestamp), received, new bytes32[](0));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.PaymentCovered.selector, received, INTENT_AMOUNT));
        arbitrator.disputeNonPayment(scan);

        // The release stays open: a scan showing a real shortfall still pays it.
        arbitrator.disputeNonPayment(_scanFull(id, PAYEE, uint64(block.timestamp), INTENT_AMOUNT - 1e6, new bytes32[](0)));
        assertEq(vault.claimable(depositor), 1e6);
        assertEq(vault.lockedStake(treasury), 0);
    }

    function test_ReleaseBelowDustToleranceStaysDisputable() public {
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));
        claim.amount = 0.4e6;
        vm.prank(operator);
        arbitrator.release(id, 0.4e6, claim);

        // Nothing arrived: all 0.40 is owed, although that is below the 0.50 tolerance.
        arbitrator.disputeNonPayment(_scan(id, PAYEE, uint64(block.timestamp)));

        assertEq(vault.claimable(depositor), 0.4e6);
        assertEq(vault.stakeBalance(treasury), BOND - 0.4e6);
    }

    function test_DustIsCappedAtAShareOfTheRelease() public {
        // On a 10.00 release, dust is at most 1%: a 0.10 shortfall is forgiven, one base unit more is paid.
        assertEq(arbitrator.dustShareBps(), 100);
        bytes32 covered = _releasePartial(10e6, 10e6);
        INonPaymentVerifier.NonPaymentAttestation memory scan =
            _scanFull(covered, PAYEE, uint64(block.timestamp), 9.9e6, new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.PaymentCovered.selector, 9.9e6, 10e6));
        arbitrator.disputeNonPayment(scan);

        bytes32 paid = _releasePartial(10e6, 10e6);
        arbitrator.disputeNonPayment(_scanFull(paid, PAYEE, uint64(block.timestamp), 9.9e6 - 1, new bytes32[](0)));
        assertEq(vault.claimable(depositor), 0.1e6 + 1);
    }

    function test_DustIsMeasuredOnThePayoutNotTheFiatShortfall() public {
        // 30 released against a 60 claim: a 0.60 fiat shortfall is a 0.30 payout, which is dust.
        bytes32 id = _releasePartial(30e6, 60e6);
        INonPaymentVerifier.NonPaymentAttestation memory scan =
            _scanFull(id, PAYEE, uint64(block.timestamp), 59.4e6, new bytes32[](0));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.PaymentCovered.selector, 59.4e6, 60e6));
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputePaysInFullWhateverTheClaimedAmount() public {
        // The largest claim an operator can enter must not make the payout overflow.
        bytes32 id = _releasePartial(INTENT_AMOUNT, type(uint256).max);

        arbitrator.disputeNonPayment(_scan(id, PAYEE, uint64(block.timestamp)));

        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.stakeBalance(treasury), BOND - INTENT_AMOUNT);
    }

    function test_DisputePaysShortfallJustAboveDust() public {
        bytes32 id = _release();
        uint256 owed = 0.5e6 + 1;
        arbitrator.disputeNonPayment(_scanFull(id, PAYEE, uint64(block.timestamp), INTENT_AMOUNT - owed, new bytes32[](0)));

        assertEq(vault.claimable(depositor), owed);
        assertEq(vault.stakeBalance(treasury), BOND - owed);
        assertEq(vault.lockedStake(treasury), 0);
        assertEq(arbitrator.operatorLocked(operator), 0);
    }

    function test_GovernanceSetsDustTolerance() public {
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.InvalidDustTolerance.selector, 5e6 + 1));
        arbitrator.setDustTolerance(5e6 + 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Ownable: caller is not the owner");
        arbitrator.setDustTolerance(0);
        assertEq(arbitrator.dustTolerance(), 0.5e6);

        vm.expectEmit(false, false, false, true, address(arbitrator));
        emit DustToleranceSet(0.5e6, 5e6);
        arbitrator.setDustTolerance(5e6);
        assertEq(arbitrator.dustTolerance(), 5e6);

        vm.expectEmit(false, false, false, true, address(arbitrator));
        emit DustToleranceSet(5e6, 0);
        arbitrator.setDustTolerance(0);

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.InvalidDustShare.selector, 201));
        arbitrator.setDustShareBps(201);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Ownable: caller is not the owner");
        arbitrator.setDustShareBps(0);
        vm.expectEmit(false, false, false, true, address(arbitrator));
        emit DustShareSet(100, 200);
        arbitrator.setDustShareBps(200);
        assertEq(arbitrator.dustShareBps(), 200);

        // With no tolerance, a one-unit shortfall is paid, as before the tolerance existed.
        bytes32 id = _release();
        arbitrator.disputeNonPayment(_scanFull(id, PAYEE, uint64(block.timestamp), INTENT_AMOUNT - 1, new bytes32[](0)));
        assertEq(vault.claimable(depositor), 1);
    }

    function test_DisputeSkipsPaymentThatBacksAnotherIntent() public {
        bytes32 id = _release();
        // The same buyer's next order is paid and verified through UPV4, which binds its payment id to that intent.
        bytes32 next = _signal(taker, _defaultParams());
        _settle(next, INTENT_AMOUNT, 0);
        bytes32[] memory excluded = new bytes32[](1);
        excluded[0] = _paymentId(next);

        arbitrator.disputeNonPayment(_scanExcluding(id, PAYEE, uint64(block.timestamp), excluded));
        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
    }

    function test_DisputeRevertsWhenSkippingAnUnusedPayment() public {
        bytes32 id = _release();
        bytes32[] memory excluded = new bytes32[](1);
        excluded[0] = keccak256("payment that backs nothing");
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scanExcluding(id, PAYEE, uint64(block.timestamp), excluded);

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnboundExclusion.selector, excluded[0]));
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputeRevertsOnStaleScan() public {
        bytes32 id = _release();
        uint64 scannedAt = uint64(block.timestamp);
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scan(id, PAYEE, scannedAt);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.StaleEvidence.selector, scannedAt));
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputeRevertsForAnotherAccount() public {
        bytes32 id = _release();
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scan(id, keccak256("someone-else"), uint64(block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.ScanMismatch.selector, id));
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputeRevertsForUnsignedScan() public {
        bytes32 id = _release();
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scan(id, PAYEE, uint64(block.timestamp));
        scan.signatures[0] = _sign(0xB0B, scans.hashNonPaymentAttestation(scan));

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        arbitrator.disputeNonPayment(scan);
    }

    function test_DisputeRevertsAfterWindow() public {
        bytes32 id = _release();
        vm.warp(block.timestamp + WINDOW);
        (,, uint64 maturesAt) = vault.locks(arbitrator.lockId(id));
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scan(id, PAYEE, uint64(block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.DisputeWindowClosed.selector, maturesAt));
        arbitrator.disputeNonPayment(scan);
    }

    function test_SettleUnlocksBondAfterWindow() public {
        bytes32 id = _release();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        uint64 maturesAt = uint64(block.timestamp) + WINDOW;
        vm.warp(maturesAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.NotMatured.selector, maturesAt));
        arbitrator.settle(ids);

        vm.warp(maturesAt);
        arbitrator.settle(ids);

        assertEq(vault.lockedStake(treasury), 0);
        assertEq(vault.stakeBalance(treasury), BOND);
        assertEq(arbitrator.operatorLocked(operator), 0);
    }

    function test_AcknowledgeUnlocksBondEarly() public {
        bytes32 id = _release();
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnauthorizedDepositor.selector, address(this)));
        arbitrator.acknowledge(id);

        vm.prank(depositor);
        arbitrator.acknowledge(id);
        assertEq(vault.lockedStake(treasury), 0);
    }

    function test_ReleaseNullifiesNamedPayment() public {
        bytes32 first = _release();
        bytes32 txIdHash = _paymentId(first);
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, txIdHash))), first);
    }

    function test_ReleaseRevertsForDuplicateTransactionIdWithoutStateChanges() public {
        bytes32 first = _release();
        bytes32 txIdHash = _paymentId(first);
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, txIdHash));

        bytes32 second = _signal(taker, _defaultParams());
        uint256 recipientBalance = token.balanceOf(other);
        bytes memory intentBefore = abi.encode(orchestrator.getIntent(second));
        bytes memory depositBefore = abi.encode(escrow.getDeposit(depositId));
        bytes memory firstReleaseBefore = abi.encode(arbitrator.getRelease(first));
        IBondedArbitrator.PaymentClaim memory claim = _claim(txIdHash);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.NullifierAlreadyExists.selector, nullifier));
        arbitrator.release(second, INTENT_AMOUNT, claim);

        assertEq(token.balanceOf(other), recipientBalance);
        assertEq(abi.encode(orchestrator.getIntent(second)), intentBefore);
        assertEq(abi.encode(escrow.getDeposit(depositId)), depositBefore);
        assertEq(abi.encode(arbitrator.getRelease(first)), firstReleaseBefore);
        assertEq(arbitrator.getRelease(second).operator, address(0));
        assertEq(arbitrator.operatorLocked(operator), INTENT_AMOUNT);
        assertEq(vault.lockedStake(treasury), INTENT_AMOUNT);
        assertEq(vault.freeStake(treasury), BOND - INTENT_AMOUNT);
        (address owner, uint256 amount, uint64 maturesAt) = vault.locks(arbitrator.lockId(second));
        assertEq(owner, address(0));
        assertEq(amount, 0);
        assertEq(maturesAt, 0);
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(nullifiers.nullifierByIntentHash(first), nullifier);
        assertEq(nullifiers.nullifierByIntentHash(second), bytes32(0));
    }

    function test_ReleaseSucceedsWithoutPayerHash() public {
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));
        claim.payerHash = bytes32(0);
        uint256 recipientBalance = token.balanceOf(other);

        vm.prank(operator);
        arbitrator.release(id, INTENT_AMOUNT, claim);

        assertEq(token.balanceOf(other) - recipientBalance, NET);
        assertEq(vault.lockedStake(treasury), INTENT_AMOUNT);
        IBondedArbitrator.Release memory released = arbitrator.getRelease(id);
        assertEq(released.operator, operator);
        assertEq(released.claim.payerHash, bytes32(0));
        assertEq(released.claim.txIdHash, claim.txIdHash);
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, claim.txIdHash))), id);
    }

    function test_ReleaseReverts() public {
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnauthorizedOperator.selector, address(this)));
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim.amount = INTENT_AMOUNT - 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.ClaimBelowRelease.selector, INTENT_AMOUNT - 1, INTENT_AMOUNT));
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim.amount = 0;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.ClaimBelowRelease.selector, 0, INTENT_AMOUNT));
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim = _claim(bytes32(0));
        vm.prank(operator);
        vm.expectRevert(IBondedArbitrator.UnidentifiedPayment.selector);
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim.payerHash = bytes32(0);
        vm.prank(operator);
        vm.expectRevert(IBondedArbitrator.UnidentifiedPayment.selector);
        arbitrator.release(id, INTENT_AMOUNT, claim);

        vm.prank(treasury);
        arbitrator.setOperator(operator, INTENT_AMOUNT - 1);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IBondedArbitrator.OperatorCapExceeded.selector, operator, INTENT_AMOUNT, INTENT_AMOUNT - 1)
        );
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));

        arbitrator.setDisputeWindow(METHOD, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.ArbitrationDisabled.selector, METHOD));
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));
    }

    function test_ReleaseRevertsWithoutFreeStake() public {
        vm.prank(treasury);
        vault.withdrawStake(BOND - 10e6);
        bytes32 id = _signal(taker, _defaultParams());

        vm.prank(operator);
        vm.expectRevert();
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));
        assertEq(orchestrator.getIntent(id).owner, taker);
    }

    function test_ReleaseRevertsWithoutBondedArbitrator() public {
        orchestrator.setSignalPolicy(signalPolicy);
        bytes32 id = _signal(taker, _defaultParams());

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.NotArbitrator.selector, id));
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));
    }

    function test_ReleaseRevertsOutsideClaimWindow() public {
        vm.warp(block.timestamp + 40 days);
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));

        claim.paidAfter = uint64(block.timestamp - 30 days - 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.InvalidClaimWindow.selector, claim.paidAfter, block.timestamp));
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim.paidAfter = uint64(block.timestamp + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.InvalidClaimWindow.selector, claim.paidAfter, block.timestamp));
        arbitrator.release(id, INTENT_AMOUNT, claim);

        claim.paidAfter = uint64(block.timestamp - 30 days);
        vm.prank(operator);
        arbitrator.release(id, INTENT_AMOUNT, claim);
    }

    function test_ReleaseRevertsForDepositOutsideStakeToken() public {
        USDCMock otherToken = new USDCMock(1_000_000e6, "Other", "OTHER");
        StakeVaultV2 otherVault = new StakeVaultV2(address(this), otherToken);
        BondedArbitrator otherArbitrator = new BondedArbitrator(address(this), orchestrator, otherVault, nullifiers, scans);
        orchestrator.setSignalPolicy(new IntentSignalPolicyV2(gatingService, whitelist, address(otherArbitrator)));
        otherArbitrator.setDisputeWindow(METHOD, WINDOW);
        otherArbitrator.setBondOwner(treasury, true);
        vm.prank(treasury);
        otherArbitrator.setOperator(operator, 500e6);
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnsupportedToken.selector, address(token)));
        otherArbitrator.release(id, INTENT_AMOUNT, claim);
    }

    function test_ReleaseRevertsAfterBondOwnerRemoved() public {
        bytes32 id = _signal(taker, _defaultParams());
        arbitrator.setBondOwner(treasury, false);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnauthorizedOperator.selector, operator));
        arbitrator.release(id, INTENT_AMOUNT, _claim(_paymentId(id)));
    }

    function test_PauseStopsReleaseButNotDisputeOrSettlement() public {
        bytes32 disputed = _release();
        bytes32 settled = _release();
        bytes32 pending = _signal(taker, _defaultParams());
        arbitrator.pause();

        vm.prank(operator);
        vm.expectRevert("Pausable: paused");
        arbitrator.release(pending, INTENT_AMOUNT, _claim(_paymentId(pending)));

        arbitrator.disputeNonPayment(_scan(disputed, PAYEE, uint64(block.timestamp)));
        vm.warp(block.timestamp + WINDOW);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = settled;
        arbitrator.settle(ids);
        assertEq(vault.lockedStake(treasury), 0);

        arbitrator.unpause();
        vm.prank(operator);
        arbitrator.release(pending, INTENT_AMOUNT, _claim(_paymentId(pending)));
        assertEq(vault.lockedStake(treasury), INTENT_AMOUNT);
    }

    function test_SettleUnlocksSeveralReleases() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = _release();
        ids[1] = _release();
        vm.warp(block.timestamp + WINDOW);

        arbitrator.settle(ids);
        assertEq(vault.lockedStake(treasury), 0);
        assertEq(arbitrator.operatorLocked(operator), 0);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.ReleaseNotFound.selector, ids[0]));
        arbitrator.settle(ids);
    }

    function test_DisputeRevertsWhenExcludingItsOwnPayment() public {
        bytes32 id = _release();
        bytes32 txIdHash = _paymentId(id);
        bytes32[] memory excluded = new bytes32[](1);
        excluded[0] = txIdHash;
        INonPaymentVerifier.NonPaymentAttestation memory scan = _scanExcluding(id, PAYEE, uint64(block.timestamp), excluded);

        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnboundExclusion.selector, txIdHash));
        arbitrator.disputeNonPayment(scan);
    }

    function test_SetOperatorRules() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.UnauthorizedBondOwner.selector, stranger));
        vm.prank(stranger);
        arbitrator.setOperator(operator, 1);

        address otherOwner = makeAddr("otherOwner");
        arbitrator.setBondOwner(otherOwner, true);
        vm.startPrank(otherOwner);
        vm.expectRevert(IBondedArbitrator.ZeroAddress.selector);
        arbitrator.setOperator(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.OperatorTaken.selector, operator, treasury));
        arbitrator.setOperator(operator, 1);
        vm.stopPrank();

        vm.prank(treasury);
        arbitrator.setOperator(operator, 0);
        assertEq(arbitrator.bondOwnerOf(operator), address(0));
        assertEq(arbitrator.operatorCap(operator), 0);
        vm.prank(otherOwner);
        arbitrator.setOperator(operator, 7);
        assertEq(arbitrator.bondOwnerOf(operator), otherOwner);
    }

    function test_GovernanceGuards() public {
        vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.InvalidDisputeWindow.selector, uint64(90 days + 1)));
        arbitrator.setDisputeWindow(METHOD, 90 days + 1);
        vm.expectRevert(IBondedArbitrator.ZeroAddress.selector);
        arbitrator.setBondOwner(address(0), true);
        vm.expectRevert(IBondedArbitrator.ZeroAddress.selector);
        arbitrator.setNonPaymentVerifier(NonPaymentVerifier(address(0)));
        vm.expectRevert(IBondedArbitrator.OwnershipRenunciationDisabled.selector);
        arbitrator.renounceOwnership();

        NonPaymentVerifier replacement = new NonPaymentVerifier(address(this), witnesses);
        arbitrator.setNonPaymentVerifier(replacement);
        assertEq(address(arbitrator.nonPaymentVerifier()), address(replacement));

        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert("Ownable: caller is not the owner");
        arbitrator.setDisputeWindow(METHOD, 1 days);
        vm.expectRevert("Ownable: caller is not the owner");
        arbitrator.pause();
        vm.stopPrank();
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(IBondedArbitrator.ZeroAddress.selector);
        new BondedArbitrator(address(0), orchestrator, vault, nullifiers, scans);
        vm.expectRevert(IBondedArbitrator.ZeroAddress.selector);
        new BondedArbitrator(address(this), orchestrator, vault, nullifiers, NonPaymentVerifier(address(0)));
    }
}
