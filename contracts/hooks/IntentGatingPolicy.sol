// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IIntentSignalPolicy } from "../interfaces/IIntentSignalPolicy.sol";
import { IOrchestratorV4 } from "../interfaces/IOrchestratorV4.sol";
import { ReferralFeeLib } from "../lib/ReferralFeeLib.sol";

/**
 * @title IntentGatingPolicy
 * @notice OrchestratorV4 signal policy that requires the gating service's signature on every intent.
 * @dev The signature covers the payer commitment, so only the gating service can vouch that the committed payer
 * belongs to the taker. Rotate the gating service by selecting a new policy on the orchestrator.
 */
contract IntentGatingPolicy is IIntentSignalPolicy {
    using ECDSA for bytes32;
    using SignatureChecker for address;

    /* ============ Errors ============ */

    error SignatureExpired(uint256 expiration, uint256 currentTime);
    error InvalidSignature();

    /* ============ State Variables ============ */

    /// @notice Signer whose signature every intent needs.
    address public immutable gatingService;

    /* ============ Constructor ============ */

    constructor(address _gatingService) {
        gatingService = _gatingService;
    }

    /* ============ External Functions ============ */

    /**
     * @inheritdoc IIntentSignalPolicy
     * @dev Verifies O3's gating message for the calling orchestrator, with the payer commitment appended.
     */
    function validateSignalIntent(address _taker, IOrchestratorV4.SignalIntentParams calldata _params)
        external
        view
        override
    {
        if (block.timestamp > _params.signatureExpiration) {
            revert SignatureExpired(_params.signatureExpiration, block.timestamp);
        }

        bytes memory message = abi.encodePacked(
            msg.sender,
            _params.escrow,
            _params.depositId,
            _params.amount,
            _taker,
            _params.to,
            _params.paymentMethod,
            _params.fiatCurrency,
            _params.conversionRate,
            ReferralFeeLib.hashReferralFees(_params.referralFees),
            _params.signatureExpiration,
            block.chainid,
            _params.payerCommitment
        );

        bytes32 verifierPayload = keccak256(message).toEthSignedMessageHash();
        if (!gatingService.isValidSignatureNow(verifierPayload, _params.gatingServiceSignature)) {
            revert InvalidSignature();
        }
    }
}
