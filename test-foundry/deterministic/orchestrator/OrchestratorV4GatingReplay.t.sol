// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV4Fixture} from "../helpers/OrchestratorV4Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SettlementPolicyMock} from "../../mocks/SettlementPolicyMock.sol";

contract OrchestratorV4GatingReplayTest is OrchestratorV4Fixture {
    function setUp() public override {
        super.setUp();
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
    }

    function test_ReplayRejectedBeforeHookOrLocking() public {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), depositId, preIntentHook);
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);

        params.preIntentHookData = hex"1234";
        _assertReplayRejected(params, intentHash);
        assertEq(preIntentHook.callCount(), 1);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
        assertEq(orchestrator.intentCounter(), 1);
    }

    function test_CancellationDoesNotRestoreAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);

        _assertReplayRejected(params, intentHash);
    }

    function test_FulfillmentDoesNotRestoreAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        _assertReplayRejected(params, intentHash);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_ManualReleaseDoesNotRestoreAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        _assertReplayRejected(params, intentHash);
    }

    function test_ExpiredIntentPruningDoesNotRestoreAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);

        _assertReplayRejected(params, intentHash);
    }

    function test_OrphanCleanupDoesNotRestoreAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        // Remove the escrow's orchestrator link so pruning leaves an orphan.
        vm.store(address(escrow), keccak256(abi.encode(intentHash, uint256(15))), bytes32(0));
        vm.warp(block.timestamp + 3601);
        escrow.pruneExpiredIntents(depositId);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        orchestrator.cleanupOrphanedIntents(hashes);

        _assertReplayRejected(params, intentHash);
    }

    function test_FailedLockCanRetrySameAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 digest = _rawDigest(params);
        vm.mockCallRevert(address(escrow), abi.encodeWithSelector(IEscrow.lockFunds.selector), "lock failed");
        vm.expectRevert(bytes("lock failed"));
        _signalCall(taker, params);
        assertEq(orchestrator.usedGatingDigests(digest), bytes32(0));
        assertEq(orchestrator.intentCounter(), 0);

        vm.clearMockedCalls();
        bytes32 intentHash = _signal(taker, params);
        assertEq(orchestrator.usedGatingDigests(digest), intentHash);
    }

    function test_DifferentCallerCannotConsumeAuthorization() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        vm.expectRevert(IOrchestratorV4.InvalidSignature.selector);
        _signalCall(other, params);
        assertEq(orchestrator.usedGatingDigests(_rawDigest(params)), bytes32(0));

        bytes32 intentHash = _signal(taker, params);
        _assertReplayRejected(params, intentHash);
    }

    function test_NewExpirationAllowsNewAuthorizationAfterCancellation() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 firstDigest = _rawDigest(params);
        bytes32 first = _signal(taker, params);
        vm.prank(taker);
        orchestrator.cancelIntent(first);

        params.signatureExpiration++;
        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 second = _signal(taker, params);
        assertEq(orchestrator.usedGatingDigests(firstDigest), first);
        assertEq(orchestrator.usedGatingDigests(_rawDigest(params)), second);
        assertNotEq(first, second);
    }

    function test_FullFeeAuthorizationPaysFeesAndCannotReplay() public {
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        params.referralFees = new IReferralFee.ReferralFee[](1);
        params.referralFees[0] = IReferralFee.ReferralFee({recipient: referrer, fee: 1e16});
        params.gatingServiceSignature = _gatingSignature(gatingServiceKey, taker, params, params.signatureExpiration);
        bytes32 intentHash = _signal(taker, params);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        assertEq(token.balanceOf(referrer), 500_000);
        assertEq(token.balanceOf(taker), 49_500_000);
        _assertReplayRejected(params, intentHash);
    }

    function test_NonemptyPolicyDataIsPartOfConsumedDigest() public {
        orchestrator.setSettlementPolicy(new SettlementPolicyMock());
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 plainDigest = _rawDigest(params);
        params.data = hex"1234";
        params.gatingServiceSignature = _policyDataSignature(params, params.data);
        bytes32 intentHash = _signal(taker, params);

        assertEq(orchestrator.usedGatingDigests(plainDigest), bytes32(0));
        _assertReplayRejected(params, intentHash);
    }

    function test_ContractSignerCannotReplayWithDifferentSignatureBytes() public {
        vm.etch(gatingService, hex"00");
        vm.mockCall(
            gatingService, abi.encodeWithSelector(IERC1271.isValidSignature.selector), abi.encode(bytes4(0x1626ba7e))
        );
        IOrchestratorV4.SignalIntentParams memory params = _authorizedParams();
        bytes32 intentHash = _signal(taker, params);
        params.gatingServiceSignature = hex"1234";

        _assertReplayRejected(params, intentHash);
    }

    function test_UngatedIdenticalOrdersRemainAllowed() public {
        vm.startPrank(depositor);
        depositId = _createDeposit(address(0), delegate);
        vm.stopPrank();
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        bytes32 first = _signal(taker, params);
        bytes32 second = _signal(taker, params);

        assertNotEq(first, second);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 2 * INTENT_AMOUNT);
        assertEq(orchestrator.usedGatingDigests(_rawDigest(params)), bytes32(0));
    }

    function _authorizedParams() internal view returns (IOrchestratorV4.SignalIntentParams memory) {
        return _gatedParams(depositId, gatingServiceKey, taker, block.timestamp + 1 days);
    }

    function _assertReplayRejected(IOrchestratorV4.SignalIntentParams memory params, bytes32 intentHash) internal {
        bytes32 digest = _rawDigest(params);
        assertEq(orchestrator.usedGatingDigests(digest), intentHash);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.GatingDigestAlreadyUsed.selector, digest));
        _signalCall(taker, params);
    }

    function _rawDigest(IOrchestratorV4.SignalIntentParams memory params) internal view returns (bytes32) {
        bytes memory message = abi.encodePacked(
            address(orchestrator),
            params.escrow,
            params.depositId,
            params.amount,
            taker,
            params.to,
            params.paymentMethod,
            params.fiatCurrency,
            params.conversionRate,
            _referralHash(params.referralFees),
            params.signatureExpiration,
            CHAIN_ID
        );
        if (params.data.length > 0) message = abi.encodePacked(message, keccak256(params.data));
        return keccak256(message);
    }
}
