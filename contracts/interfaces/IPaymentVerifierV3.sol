// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPaymentVerifier } from "./IPaymentVerifier.sol";

/**
 * @title IPaymentVerifierV3
 * @notice Payment verifier result that returns the authenticated provider payment identifier.
 * @dev The input tuple and function selector intentionally match IPaymentVerifier. The additional
 *      return field requires callers to opt into this interface and leaves existing verifier lanes
 *      ABI-compatible with the three-field result.
 */
interface IPaymentVerifierV3 {
    struct PaymentVerificationResult {
        bool success;
        bytes32 intentHash;
        uint256 releaseAmount;
        bytes32 paymentId;
    }

    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) external returns (PaymentVerificationResult memory result);
}
