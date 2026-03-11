// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "../interfaces/IReferralFee.sol";

library ReferralFeeLib {
    uint256 internal constant MAX_REFERRER_FEE = 5e17;      // 50% max total referral fee
    uint256 internal constant MAX_REFERRAL_FEE_RECIPIENTS = 5;

    function hashReferralFees(IReferralFee.ReferralFee[] calldata _referralFees) internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](_referralFees.length);

        for (uint256 i = 0; i < _referralFees.length; ++i) {
            feeHashes[i] = keccak256(abi.encode(_referralFees[i].recipient, _referralFees[i].fee));
        }

        return keccak256(abi.encode(feeHashes));
    }

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
