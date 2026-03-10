// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IReferralFee } from "../interfaces/IReferralFee.sol";

library ReferralFeeLib {
    function hashReferralFees(IReferralFee.ReferralFee[] memory _referralFees) internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](_referralFees.length);

        for (uint256 i = 0; i < _referralFees.length; ++i) {
            feeHashes[i] = keccak256(abi.encode(_referralFees[i].recipient, _referralFees[i].fee));
        }

        return keccak256(abi.encode(feeHashes));
    }
}
