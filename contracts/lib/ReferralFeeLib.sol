// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "../interfaces/IReferralFee.sol";

/**
 * @title ReferralFeeLib
 * @notice Hashes and validates the ordered referral fee configuration attached to an intent.
 * @dev Referral terms are rates expressed in 1e18 precise units. Validation is intentionally quadratic to reject
 *      duplicate recipients, but the array is capped at ten entries so the upper bound remains small and predictable.
 */
library ReferralFeeLib {
    /// @dev Maximum combined referral fee rate: 50% in 1e18 precise units.
    uint256 internal constant MAX_REFERRER_FEE = 5e17;      // 50% max total referral fee

    /// @dev Maximum number of independently paid referral recipients on one intent.
    uint256 internal constant MAX_REFERRAL_FEE_RECIPIENTS = 10;

    /**
     * @notice Produces the order-sensitive commitment used by intent gating signatures.
     * @dev Each entry commits to recipient and fee rate. Hashing the ordered array of entry hashes preserves ordering and
     *      array boundaries, so reordering, adding, removing, or modifying any referral changes the final commitment.
     * @param _referralFees Ordered referral fee configuration supplied during intent signaling.
     * @return Commitment included in the EIP-712 intent-gating digest.
     */
    function hashReferralFees(IReferralFee.ReferralFee[] calldata _referralFees) internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](_referralFees.length);

        for (uint256 i = 0; i < _referralFees.length; ++i) {
            feeHashes[i] = keccak256(abi.encode(_referralFees[i].recipient, _referralFees[i].fee));
        }

        return keccak256(abi.encode(feeHashes));
    }

    /**
     * @notice Validates recipient identity, rate, uniqueness, count, and aggregate referral rate.
     * @dev Every entry requires a non-zero recipient and non-zero fee rate. Recipients must be unique, the array may
     *      contain at most ten entries, and the sum of all rates may not exceed 50%.
     * @param _referralFees Ordered referral fee configuration to validate before intent admission.
     */
    function validateReferralFees(IReferralFee.ReferralFee[] calldata _referralFees) internal pure {
        if (_referralFees.length > MAX_REFERRAL_FEE_RECIPIENTS) {
            revert IReferralFee.ReferralFeeCountExceedsMaximum(_referralFees.length, MAX_REFERRAL_FEE_RECIPIENTS);
        }

        uint256 totalReferralFee;
        for (uint256 i = 0; i < _referralFees.length; ++i) {
            IReferralFee.ReferralFee calldata referralFee = _referralFees[i];

            if (referralFee.recipient == address(0) || referralFee.fee == 0) {
                revert IReferralFee.InvalidReferralFeeConfiguration();
            }

            for (uint256 j = i + 1; j < _referralFees.length; ++j) {
                if (_referralFees[j].recipient == referralFee.recipient) {
                    revert IReferralFee.DuplicateReferralFeeRecipient(referralFee.recipient);
                }
            }

            totalReferralFee += referralFee.fee;
        }

        if (totalReferralFee > MAX_REFERRER_FEE) {
            revert IReferralFee.ReferralFeeExceedsMaximum(totalReferralFee, MAX_REFERRER_FEE);
        }
    }
}
