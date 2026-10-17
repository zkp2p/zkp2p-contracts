// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentLifecycleHook} from "./IIntentLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "./IDisputeProtectionPolicy.sol";

/**
 *  @notice The dispute policy exposed by the canonical stake-backed lifecycle hook.
 */
interface IStakeReferralLifecycleHook is IIntentLifecycleHook {
    function disputeProtectionPolicy() external view returns (IDisputeProtectionPolicy);
}
