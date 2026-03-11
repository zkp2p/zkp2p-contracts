// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "../interfaces/IReferralFee.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";

library ReferralFeeLib {
    uint256 internal constant MAX_REFERRER_FEE = 5e16;
    uint256 internal constant MAX_REFERRAL_FEE_RECIPIENTS = 4;

    function hashReferralFees(IReferralFee.ReferralFee[] calldata _referralFees) internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](_referralFees.length);

        for (uint256 i = 0; i < _referralFees.length; ++i) {
            feeHashes[i] = keccak256(abi.encode(_referralFees[i].recipient, _referralFees[i].fee));
        }

        return keccak256(abi.encode(feeHashes));
    }

    function validateReferralFees(IReferralFee.ReferralFee[] calldata _referralFees) internal pure {
        if (_referralFees.length > MAX_REFERRAL_FEE_RECIPIENTS) {
            revert IOrchestratorV2.ReferralFeeCountExceedsMaximum(_referralFees.length, MAX_REFERRAL_FEE_RECIPIENTS);
        }

        uint256 totalReferralFee;
        for (uint256 i = 0; i < _referralFees.length; ++i) {
            IReferralFee.ReferralFee calldata referralFee = _referralFees[i];

            if (referralFee.recipient == address(0) || referralFee.fee == 0) {
                revert IOrchestratorV2.InvalidReferralFeeConfiguration();
            }

            for (uint256 j = i + 1; j < _referralFees.length; ++j) {
                if (_referralFees[j].recipient == referralFee.recipient) {
                    revert IOrchestratorV2.DuplicateReferralFeeRecipient(referralFee.recipient);
                }
            }

            totalReferralFee += referralFee.fee;
        }

        if (totalReferralFee > MAX_REFERRER_FEE) {
            revert IOrchestratorV2.FeeExceedsMaximum(totalReferralFee, MAX_REFERRER_FEE);
        }
    }
}
