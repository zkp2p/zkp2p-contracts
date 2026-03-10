// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

interface IReferralFee {
    struct ReferralFee {
        address recipient;
        uint256 fee;
    }
}
