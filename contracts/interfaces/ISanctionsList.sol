// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/// @notice On-chain sanctions list, as published by the Chainalysis sanctions oracle.
interface ISanctionsList {
    function isSanctioned(address account) external view returns (bool);
}
