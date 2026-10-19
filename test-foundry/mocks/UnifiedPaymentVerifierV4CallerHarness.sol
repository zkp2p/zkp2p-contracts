// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
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

    /// @notice Calls the verifier and decodes the static result and signed settlement data bytes.
    function verifyPayment(IPaymentVerifierV2 verifier, IPaymentVerifierV2.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory, bytes memory)
    {
        return verifier.verifyPayment(data);
    }
}

contract UnifiedPaymentVerifierV4V4CallerHarness is ERC165 {
    mapping(bytes32 => IOrchestratorV4.Intent) internal intents;

    function setIntent(bytes32 intentHash, IOrchestratorV4.Intent calldata intent) external {
        intents[intentHash] = intent;
    }

    function getIntent(bytes32 intentHash) external view returns (IOrchestratorV4.Intent memory) {
        return intents[intentHash];
    }

    function verifyPayment(IPaymentVerifierV2 verifier, IPaymentVerifierV2.VerifyPaymentData calldata data)
        external returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory, bytes memory)
    {
        return verifier.verifyPayment(data);
    }

    // An O4 that also answered this V2 probe must still be read as O4: the verifier checks ERC-165 first.
    function getDepositPreIntentHook(address, uint256) external pure returns (address) {
        return address(0);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IOrchestratorV4).interfaceId || super.supportsInterface(interfaceId);
    }
}
