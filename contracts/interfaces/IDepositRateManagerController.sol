// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDepositRateManagerController
 * @notice External controller that manages per-deposit rate manager configuration and effective min rates.
 */
interface IDepositRateManagerController {
    /* ============ Structs ============ */

    struct OracleFloorConfigInput {
        bytes32 paymentMethod;
        bytes32 currencyCode;
        address adapter;
        bytes rawAdapterConfig;
        uint16 spreadBps;
        uint32 maxStaleness;
    }

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

    event DepositOracleFloorConfigUpdated(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 currencyCode,
        address adapter,
        uint16 spreadBps,
        uint32 maxStaleness,
        bytes adapterConfig
    );

    event DepositOracleFloorConfigCleared(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 currencyCode
    );

    /* ============ Errors ============ */

    error UnauthorizedCaller(address caller, address authorized);
    error ZeroAddress();
    error ZeroValue();
    error RateManagerNotFound(bytes32 rateManagerId);
    error RateManagerAlreadySet(bytes32 rateManagerId);
    error RateManagerRegistryNotSet();
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);
    error InvalidPaymentMethod();
    error InvalidCurrency();
    error InvalidSpread();
    error InvalidStaleness();
    error InvalidAdapter();
    error InvalidAdapterConfig();
    error OracleFloorConfigNotSet();

    /* ============ External Functions ============ */

    function setDepositRateManager(address escrow, uint256 depositId, address registry, bytes32 rateManagerId) external;

    function clearDepositRateManager(address escrow, uint256 depositId) external;

    function setDepositOracleFloorConfig(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode,
        address adapter,
        bytes calldata rawAdapterConfig,
        uint16 spreadBps,
        uint32 maxStaleness
    ) external;

    function setDepositOracleFloorConfigs(
        address escrow,
        uint256 depositId,
        OracleFloorConfigInput[] calldata oracleFloorConfigs
    ) external;

    function clearDepositOracleFloorConfig(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode
    ) external;

    /* ============ View Functions ============ */

    function getEffectiveMinRate(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode
    ) external view returns (uint256);

    function getManagerFee(address escrow, uint256 depositId) external view returns (address recipient, uint256 fee);

    function getDepositRateManager(address escrow, uint256 depositId) external view returns (address registry, bytes32 rateManagerId);

    function getDepositOracleFloorConfig(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode
    )
        external
        view
        returns (
            bool isConfigured,
            address adapter,
            bytes memory adapterConfig,
            uint16 spreadBps,
            uint32 maxStaleness
        );
}
