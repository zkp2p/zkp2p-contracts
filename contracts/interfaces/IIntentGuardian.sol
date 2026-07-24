// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrowV2} from "./IEscrowV2.sol";
import {IEscrowRegistry} from "./IEscrowRegistry.sol";

/**
 * @title IIntentGuardian
 * @notice Prepaid intent-extension policy for EscrowV2 deposits.
 */
interface IIntentGuardian {
    event IntentExtended(
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        address indexed payer,
        uint256 additionalTime,
        uint256 cost
    );
    event ExtensionFeeUpdated(uint256 extensionFeeBpsPerHour);

    error ExtensionsDisabled();
    error IntentAlreadyExpired(bytes32 intentHash, uint256 expiryTime, uint256 currentTime);
    error ExtensionCostExceedsMax(uint256 cost, uint256 maxCost);
    error ExtensionFeeExceedsIntentAmount(uint256 extensionFeeBpsPerHour);
    error EscrowNotWhitelisted(address escrow);

    /// @notice Prepays the deposit's maker to extend a live intent.
    function extendIntent(
        IEscrowV2 _escrow,
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _additionalTime,
        uint256 _maxCost
    ) external;

    /// @notice Quotes an extension fee using the current hourly rate.
    function quoteExtensionCost(uint256 _intentAmount, uint256 _additionalTime) external view returns (uint256);

    /// @notice Sets the hourly extension fee or disables extensions with zero.
    function setExtensionFeeBpsPerHour(uint256 _extensionFeeBpsPerHour) external;

    /// @notice Returns the EscrowRegistry used to authorize escrows for extension.
    function escrowRegistry() external view returns (IEscrowRegistry);

    /// @notice Returns the current hourly extension fee in basis points.
    function extensionFeeBpsPerHour() external view returns (uint256);
}
