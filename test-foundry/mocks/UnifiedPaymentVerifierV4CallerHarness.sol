// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";

contract UnifiedPaymentVerifierV4CallerHarness {
    mapping(bytes32 => IOrchestrator.Intent) internal intents;

    /// @notice Sets the intent returned to the verifier.
    function setIntent(bytes32 intentHash, IOrchestrator.Intent calldata intent) external {
        intents[intentHash] = intent;
    }

    /// @notice Returns the configured intent snapshot.
    function getIntent(bytes32 intentHash) external view returns (IOrchestrator.Intent memory) {
        return intents[intentHash];
    }

    /// @notice Calls the verifier and decodes all four result fields.
    function verifyPayment(IPaymentVerifierV2 verifier, IPaymentVerifier.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory)
    {
        return verifier.verifyPayment(data);
    }
}

contract UnifiedPaymentVerifierV4V2CallerHarness {
    mapping(bytes32 => IOrchestratorV2.Intent) internal intents;

    /// @notice Sets the intent returned to the verifier.
    function setIntent(bytes32 intentHash, IOrchestratorV2.Intent calldata intent) external {
        intents[intentHash] = intent;
    }

    /// @notice Returns the configured intent snapshot.
    function getIntent(bytes32 intentHash) external view returns (IOrchestratorV2.Intent memory) {
        return intents[intentHash];
    }

    /// @notice Calls the verifier and decodes all four result fields.
    function verifyPayment(IPaymentVerifierV2 verifier, IPaymentVerifier.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory)
    {
        return verifier.verifyPayment(data);
    }

    /// @notice Exposes the selector used to identify a V2-shaped orchestrator.
    function getDepositPreIntentHook(address, uint256) external pure returns (address) {
        return address(0);
    }
}
