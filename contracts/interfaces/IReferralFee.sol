// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

interface IReferralFee {
    struct ReferralFee {
        address recipient;
        uint256 fee;
    }

    error ReferralFeeExceedsMaximum(uint256 totalFee, uint256 maximum);
    error ReferralFeeCountExceedsMaximum(uint256 count, uint256 maximum);
    error DuplicateReferralFeeRecipient(address recipient);
    error InvalidReferralFeeConfiguration();
}
