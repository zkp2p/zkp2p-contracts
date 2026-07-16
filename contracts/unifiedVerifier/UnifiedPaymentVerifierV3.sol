// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { BaseUnifiedPaymentVerifier } from "./BaseUnifiedPaymentVerifier.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { INullifierRegistry } from "../interfaces/INullifierRegistry.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierV3 } from "../interfaces/IPaymentVerifierV3.sol";

/**
 * @title UnifiedPaymentVerifierV3
 * @notice Returns the payment identifier already authenticated inside signed PaymentDetails.
 * @dev The payment-attestation type is unchanged. EIP-712 chain and verifier-address binding remains
 *      in the domain separator; only the verification result gains `paymentId`.
 */
contract UnifiedPaymentVerifierV3 is IPaymentVerifierV3, BaseUnifiedPaymentVerifier {
    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        INullifierRegistry _nullifierRegistry,
        IAttestationVerifier _attestationVerifier
    ) BaseUnifiedPaymentVerifier(_orchestratorRegistry, _nullifierRegistry, _attestationVerifier) { }

    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) external override onlyOrchestrator returns (PaymentVerificationResult memory result) {
        (bytes32 intentHash, uint256 releaseAmount, bytes32 paymentId) = _verifyPayment(_verifyPaymentData);
        return PaymentVerificationResult({
            success: true,
            intentHash: intentHash,
            releaseAmount: releaseAmount,
            paymentId: paymentId
        });
    }
}
