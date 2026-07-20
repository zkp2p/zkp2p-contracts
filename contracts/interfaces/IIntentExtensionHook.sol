// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIntentExtensionHook
 * @notice Optional paid-extension capability for a snapshotted V3 risk hook.
 */
interface IIntentExtensionHook {
    /**
     * @notice Authorizes and charges for an extension before Escrow mutates the expiry.
     * @return fee Non-refundable stake fee credited to the depositor.
     */
    function onIntentExpiryExtension(
        bytes32 _intentHash,
        uint256 _extensionSeconds,
        uint256 _newExpiry
    ) external returns (uint256 fee);
}
