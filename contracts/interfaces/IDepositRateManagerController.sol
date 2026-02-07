// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDepositRateManagerController
 * @notice External controller that manages per-deposit rate manager configuration and effective min rates.
 */
interface IDepositRateManagerController {
    /* ============ Events ============ */

    event DepositRateManagerSet(
        address indexed escrow,
        uint256 indexed depositId,
        address indexed registry,
        bytes32 rateManagerId
    );

    event DepositRateManagerCleared(
        address indexed escrow,
        uint256 indexed depositId,
        address indexed registry,
        bytes32 prevRateManagerId
    );

    /* ============ Errors ============ */

    error UnauthorizedCaller(address caller, address authorized);
    error ZeroAddress();
    error ZeroValue();
    error RateManagerNotFound(bytes32 rateManagerId);
    error RateManagerRegistryNotSet();

    /* ============ External Functions ============ */

    function setDepositRateManager(address escrow, uint256 depositId, address registry, bytes32 rateManagerId) external;

    function clearDepositRateManager(address escrow, uint256 depositId) external;

    /* ============ View Functions ============ */

    function getEffectiveMinRate(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode
    ) external view returns (uint256);

    function getManagerFee(address escrow, uint256 depositId) external view returns (address recipient, uint256 fee);

    function getDepositRateManager(address escrow, uint256 depositId) external view returns (address registry, bytes32 rateManagerId);
}
