// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPaymentVerifierRegistry } from "./IPaymentVerifierRegistry.sol";

/**
 * @title IPaymentEvidenceVerifier
 * @notice Exposes the immutable evidence commitment produced while verifying an intent payment.
 */
interface IPaymentEvidenceVerifier {
    /** @notice Returns payment details committed while the named orchestrator verified the intent. */
    function getPaymentDetailsHash(
        address _orchestrator,
        bytes32 _intentHash
    ) external view returns (bytes32);
}

/** @notice Narrow Orchestrator surface used to snapshot a payment verifier at admission. */
interface IOrchestratorPaymentVerifier {
    function paymentVerifierRegistry() external view returns (IPaymentVerifierRegistry);
}
