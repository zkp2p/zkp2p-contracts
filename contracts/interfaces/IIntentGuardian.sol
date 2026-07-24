// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IEscrowRegistry} from "./IEscrowRegistry.sol";

/**
 * @title IIntentGuardian
 * @notice Permissionless prepaid intent extensions for compatible Escrow deposits.
 */
interface IIntentGuardian {
    event ExtensionFeeBpsPerHourUpdated(uint256 previousFeeBpsPerHour, uint256 newFeeBpsPerHour);

    event IntentExtended(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed intentHash,
        address payer,
        uint256 additionalTime,
        uint256 cost
    );

    error ZeroAddress();
    error ExtensionsDisabled();
    error IntentAlreadyExpired(bytes32 intentHash, uint256 expiryTime, uint256 currentTime);
    error ExtensionCostExceedsMax(uint256 cost, uint256 maxCost);
    error ExtensionFeeExceedsIntentAmount(uint256 extensionFeeBpsPerHour);
    error EscrowNotWhitelisted(address escrow);

    /**
     * @notice Prepays a deposit's maker and extends a live intent.
     * @param _escrow Whitelisted Escrow or EscrowV2 holding the deposit and intent.
     * @param _depositId Deposit containing the intent.
     * @param _intentHash Intent to extend.
     * @param _additionalTime Seconds to add to the current expiry.
     * @param _maxCost Maximum fee the payer authorizes.
     */
    function extendIntent(
        address _escrow,
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _additionalTime,
        uint256 _maxCost
    ) external;

    /**
     * @notice Updates the hourly extension fee for all deposits using this guardian.
     * @dev A zero fee disables extensions until governance configures a non-zero fee.
     */
    function setExtensionFeeBpsPerHour(uint256 _extensionFeeBpsPerHour) external;

    /// @notice Quotes the exact upward-rounded prepaid extension cost.
    function quoteExtensionCost(uint256 _intentAmount, uint256 _additionalTime) external view returns (uint256);

    /// @notice Escrow registry used to authorize compatible escrows.
    function escrowRegistry() external view returns (IEscrowRegistry);

    /// @notice Governance-configured hourly extension fee in basis points of the locked intent amount.
    function extensionFeeBpsPerHour() external view returns (uint256);
}
