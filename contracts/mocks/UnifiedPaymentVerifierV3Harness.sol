// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";

/** @notice Legacy-orchestrator-shaped caller used to cover UPV V3's V1 snapshot path. */
contract UnifiedPaymentVerifierV3CallerHarness {
    mapping(bytes32 => IOrchestrator.Intent) internal intents;

    function setIntent(bytes32 _intentHash, IOrchestrator.Intent calldata _intent) external {
        intents[_intentHash] = _intent;
    }

    function getIntent(bytes32 _intentHash) external view returns (IOrchestrator.Intent memory) {
        return intents[_intentHash];
    }

    function verifyPayment(
        IPaymentVerifier _verifier,
        IPaymentVerifier.VerifyPaymentData calldata _data
    ) external returns (IPaymentVerifier.PaymentVerificationResult memory) {
        return _verifier.verifyPayment(_data);
    }
}
