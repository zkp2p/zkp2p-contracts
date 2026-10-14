// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IPaymentVerifier} from "./IPaymentVerifier.sol";

interface IPaymentVerifierV2 {
    struct PaymentVerificationResultV2 {
        bool success;
        bytes32 intentHash;
        uint256 releaseAmount;
        bool balanceFunded; // Attestation-signed: payment was funded from the payer's platform balance.
    }

    /// @notice Verifies a payment and returns its attestation-signed balance funding flag.
    function verifyPayment(IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData)
        external
        returns (PaymentVerificationResultV2 memory result);
}
