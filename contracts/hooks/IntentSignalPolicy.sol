// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IIntentSignalPolicy } from "../interfaces/IIntentSignalPolicy.sol";
import { IOrchestratorV4 } from "../interfaces/IOrchestratorV4.sol";
import { IWhitelistPolicyV2 } from "../interfaces/IWhitelistPolicyV2.sol";
import { ReferralFeeLib } from "../lib/ReferralFeeLib.sol";

/**
 * @title IntentSignalPolicy
 * @notice OrchestratorV4 signal policy. Admits a taker through the deposit's whitelist with the gating service's
 * signature, and names the arbitrator of the group the taker signals through.
 * @dev The signature covers the payer commitment, so only the gating service can vouch that the committed payer
 * belongs to the taker. Configuration is immutable; governance changes it by selecting a new policy on the orchestrator.
 */
contract IntentSignalPolicy is IIntentSignalPolicy {
    using ECDSA for bytes32;
    using SignatureChecker for address;

    /* ============ Errors ============ */

    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);
    error SignatureExpired(uint256 expiration, uint256 currentTime);
    error InvalidSignature();

    /* ============ State Variables ============ */

    address public immutable gatingService;                 // Signer whose signature every intent needs
    IWhitelistPolicyV2 public immutable whitelistPolicy;    // Per-deposit taker whitelists and their groups

    /* ============ Constructor ============ */

    constructor(address _gatingService, IWhitelistPolicyV2 _whitelistPolicy) {
        gatingService = _gatingService;
        whitelistPolicy = _whitelistPolicy;
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
        returns (bool takerWhitelisted, address arbitrator)
    {
        // With the whitelist off, anyone may signal and groupId is ignored; a group taker gets its group's arbitrator.
        if (whitelistPolicy.enabled(_params.escrow, _params.depositId)) {
            takerWhitelisted = whitelistPolicy.isWhitelisted(_params.escrow, _params.depositId, _taker, _params.groupId);
            if (!takerWhitelisted) {
                revert TakerNotWhitelisted(_params.escrow, _params.depositId, _params.paymentMethod, _taker);
            }
            if (_params.groupId != bytes32(0)) arbitrator = whitelistPolicy.groupRegistry().groupArbitrator(_params.groupId);
        }

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
