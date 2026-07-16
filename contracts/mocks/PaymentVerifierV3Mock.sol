// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierV3 } from "../interfaces/IPaymentVerifierV3.sol";

/** @notice Configurable payment-ID-aware verifier used by OrchestratorV3 tests. */
contract PaymentVerifierV3Mock is IPaymentVerifierV3 {
    bool public shouldReturnFalse;
    bytes32 public paymentId;
    bool public useConfiguredPaymentId;

    function setShouldReturnFalse(bool _shouldReturnFalse) external {
        shouldReturnFalse = _shouldReturnFalse;
    }

    function setPaymentId(bytes32 _paymentId) external {
        paymentId = _paymentId;
        useConfiguredPaymentId = true;
    }

    function clearPaymentId() external {
        paymentId = bytes32(0);
        useConfiguredPaymentId = false;
    }

    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) external view override returns (PaymentVerificationResult memory) {
        (uint256 releaseAmount, , , , bytes32 intentHash) = abi.decode(
            _verifyPaymentData.paymentProof,
            (uint256, uint256, bytes32, bytes32, bytes32)
        );
        if (shouldReturnFalse) {
            return PaymentVerificationResult(false, bytes32(0), 0, bytes32(0));
        }
        bytes32 resultPaymentId = useConfiguredPaymentId
            ? paymentId
            : keccak256(abi.encodePacked("payment", intentHash));
        return PaymentVerificationResult(true, intentHash, releaseAmount, resultPaymentId);
    }
}
