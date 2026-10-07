// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IDisputeProtectionPolicy} from "./IDisputeProtectionPolicy.sol";

interface IDisputeProtectionPolicyV2 is IDisputeProtectionPolicy {
    event LegacyIntentAdopted(bytes32 indexed intentHash);

    /// @notice Authorized-hook settlement with a proof-derived hold; zero releases the entire original lock.
    function onIntentSettledWithWindow(bytes32 _intentHash, uint256 _releaseAmount, uint64 _window) external;
}
