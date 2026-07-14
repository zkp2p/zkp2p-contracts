// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPostIntentHookV2 } from "./IPostIntentHookV2.sol";

/**
 * @title IDeferredPayoutHook
 * @notice Required settlement action for intents using deferred-payout risk mode.
 */
interface IDeferredPayoutHook is IPostIntentHookV2 {
    event PayoutDeferred(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        address indexed vault,
        uint256 amount
    );
}
