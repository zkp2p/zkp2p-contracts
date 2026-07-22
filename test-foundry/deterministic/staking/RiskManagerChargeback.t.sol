// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

contract RiskManagerChargebackTest is RiskManagerIntegrationFixture {
    event RiskPositionReleased(
        bytes32 indexed intentHash, address indexed stakeOwner, IRiskManager.RiskMode mode, uint256 releasedCoverage
    );
    event ChargebackSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed lp,
        IRiskManager.RiskMode mode,
        uint256 grossReleasedAmount,
        uint256 compensatedAmount,
        bytes32 disputeId
    );

    function _depositAsTaker(uint256 amount) internal {
        vm.prank(taker);
        vault.depositStake(amount);
    }

    function _canonicalPaymentId(bytes32 intentHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("payment", intentHash));
    }

    function _claim(
        bytes32 intentHash,
        uint256 paymentAmount,
        bytes32 disputeId,
        bytes32 originalPaymentId,
        bool bindPayment
    ) internal returns (IRiskManager.ChargebackAttestation memory attestation) {
        bytes32 canonicalPaymentId = _canonicalPaymentId(intentHash);
        if (disputeId == bytes32(0)) disputeId = keccak256(abi.encodePacked("dispute", intentHash));
        if (originalPaymentId == bytes32(0)) originalPaymentId = canonicalPaymentId;
        if (bindPayment) {
            bytes32 canonicalNullifier = keccak256(abi.encodePacked(PAYPAL, canonicalPaymentId));
            if (nullifierRegistry.intentHashByNullifier(canonicalNullifier) == bytes32(0)) {
                nullifierRegistry.addNullifier(canonicalNullifier, intentHash);
            }
        }
        bytes memory data = abi.encode(
            IRiskManager.ChargebackDetails({
                paymentMethod: PAYPAL,
                originalPaymentId: originalPaymentId,
                disputeId: disputeId,
                paymentAmount: paymentAmount,
                paymentCurrency: USD
            })
        );
        attestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data, metadata: ""
        });
    }

    function _expectedTypedDataHash(IRiskManager.ChargebackAttestation memory attestation)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ZKP2P RiskManager"),
                keccak256("1"),
                block.chainid,
                address(manager)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(manager.CHARGEBACK_ATTESTATION_TYPEHASH(), attestation.intentHash, attestation.dataHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function test_ChargebackAuthenticatesTypedDataAndCompensatesExactGrossRelease() public {
        _depositAsTaker(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(intentHash, 500e6);
        bytes32 disputeId = keccak256("chargeback-event-semantics");
        IRiskManager.ChargebackAttestation memory attestation = _claim(intentHash, 500e6, disputeId, bytes32(0), true);
        assertEq(manager.hashChargebackAttestation(attestation), _expectedTypedDataHash(attestation));
        vm.expectEmit(true, true, true, true, address(manager));
        emit ChargebackSettled(intentHash, taker, maker, IRiskManager.RiskMode.STAKE_BACKED, 500e6, 500e6, disputeId);
        manager.submitChargeback(attestation);
        assertEq(vault.claimableCompensation(maker), 500e6);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
    }

    function test_ChargebackRejectsReusedDisputeEvidenceAcrossPositions() public {
        _depositAsTaker(1_000e6);
        bytes32 firstIntent = _signalDefault(taker, 500e6, PAYPAL);
        bytes32 secondIntent = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(firstIntent, 500e6);
        _fulfill(secondIntent, 500e6);
        bytes32 disputeId = keccak256("shared-dispute");
        manager.submitChargeback(_claim(firstIntent, 500e6, disputeId, bytes32(0), true));
        IRiskManager.ChargebackAttestation memory reusedClaim = _claim(secondIntent, 500e6, disputeId, bytes32(0), true);
        vm.expectPartialRevert(IRiskManager.ChargebackEvidenceUsed.selector);
        manager.submitChargeback(reusedClaim);
    }

    function test_ManualReleaseAcceptsWitnessBoundChargebackWithoutPaymentNullifier() public {
        _depositAsTaker(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        vm.prank(maker);
        orchestrator.releaseFundsToPayer(intentHash);
        manager.submitChargeback(_claim(intentHash, 500e6, bytes32(0), bytes32(0), false));
        assertEq(vault.claimableCompensation(maker), 500e6);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
    }

    function test_ProofFulfillmentRejectsUnboundAndMismatchedPaymentIdentifiers() public {
        _depositAsTaker(1_000e6);
        bytes32 unboundIntent = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(unboundIntent, 500e6);
        vm.expectPartialRevert(IRiskManager.InvalidPaymentBinding.selector);
        manager.submitChargeback(_claim(unboundIntent, 500e6, bytes32(0), bytes32(0), false));

        bytes32 mismatchedIntent = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(mismatchedIntent, 500e6);
        IRiskManager.ChargebackAttestation memory mismatchedClaim =
            _claim(mismatchedIntent, 500e6, bytes32(0), keccak256("wrong-payment"), true);
        vm.expectPartialRevert(IRiskManager.InvalidPaymentBinding.selector);
        manager.submitChargeback(mismatchedClaim);
    }

    function test_MaturityReleasesRemainingCoverage() public {
        _depositAsTaker(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(intentHash, 500e6);
        uint64 deadline = manager.getRiskPosition(intentHash).coverageDeadline;
        vm.warp(deadline);
        vm.expectEmit(true, true, false, true, address(manager));
        emit RiskPositionReleased(intentHash, taker, IRiskManager.RiskMode.STAKE_BACKED, 500e6);
        manager.releaseMaturedPosition(intentHash);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_ChargebackRejectsCompensationAtExactCoverageDeadline() public {
        _depositAsTaker(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        _fulfill(intentHash, 500e6);
        IRiskManager.ChargebackAttestation memory attestation = _claim(intentHash, 500e6, bytes32(0), bytes32(0), true);
        uint64 deadline = manager.getRiskPosition(intentHash).coverageDeadline;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.ChargebackWindowClosed.selector, deadline, deadline));
        manager.submitChargeback(attestation);
    }
}
