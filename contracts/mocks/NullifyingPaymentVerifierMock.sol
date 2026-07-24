// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { INullifierRegistryV2 } from "../interfaces/INullifierRegistryV2.sol";

/**
 * @title NullifyingPaymentVerifierMock
 * @notice Test verifier that writes a deterministic payment-to-intent binding before returning success.
 * @dev Used to prove that a later lifecycle-settlement revert rolls the verifier write back atomically.
 */
contract NullifyingPaymentVerifierMock is IPaymentVerifier {
    INullifierRegistryV2 public immutable nullifierRegistry;
    bytes32 public immutable paymentMethod;

    constructor(INullifierRegistryV2 _nullifierRegistry, bytes32 _paymentMethod) {
        nullifierRegistry = _nullifierRegistry;
        paymentMethod = _paymentMethod;
    }

    function verifyPayment(
        VerifyPaymentData calldata _verifyPaymentData
    ) external override returns (PaymentVerificationResult memory result) {
        (uint256 releaseAmount,,,, bytes32 intentHash) = abi.decode(
            _verifyPaymentData.paymentProof,
            (uint256, uint256, bytes32, bytes32, bytes32)
        );
        bytes32 paymentId = keccak256(abi.encode(intentHash));
        bytes32 nullifier = keccak256(abi.encodePacked(paymentMethod, paymentId));
        nullifierRegistry.addNullifier(nullifier, intentHash);

        return PaymentVerificationResult({
            success: true,
            intentHash: intentHash,
            releaseAmount: releaseAmount
        });
    }
}
