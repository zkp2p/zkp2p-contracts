// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDepositRateManagerRegistryV1
 * @notice Permissionless registry for “deposit rate managers”.
 * A rate manager config is identified by a `rateManagerId` (bytes32) and can be shared across many deposits.
 */
interface IDepositRateManagerRegistryV1 {
    /* ============ Structs ============ */

    struct RateManagerConfig {
        address manager;
        address feeRecipient;
        uint256 fee;                 // Flat fee in preciseUnits (1e18 = 100%)
        uint256 minDelegationAmount; // Minimum deposit size required to opt into this manager (in deposit token units)
        string name;                 // Human-readable name (optional)
        string uri;                  // Metadata URI (optional)
    }

    /* ============ Events ============ */

    event RateManagerCreated(
        bytes32 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        uint256 fee,
        uint256 minDelegationAmount,
        string name,
        string uri
    );

    event RateManagerConfigUpdated(
        bytes32 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        uint256 minDelegationAmount,
        string name,
        string uri
    );

    event RateManagerMinRateUpdated(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 minRate
    );

    event RateManagerMinRatesBatchUpdated(bytes32 indexed rateManagerId, uint256 count);

    /* ============ External Functions ============ */

    function createRateManager(bytes32 _rateManagerId, RateManagerConfig calldata _config) external;

    function setRateManagerConfig(bytes32 _rateManagerId, address _newManager, address _newFeeRecipient, uint256 _newMinDelegationAmount, string calldata _newName, string calldata _newUri) external;

    function setMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate) external;

    function setMinRatesBatch(bytes32 _rateManagerId, bytes32[] calldata _paymentMethods, bytes32[] calldata _currencies, uint256[] calldata _minRates) external;

    /* ============ View Functions ============ */

    function isRateManager(bytes32 _rateManagerId) external view returns (bool);

    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory);

    function getFee(bytes32 _rateManagerId) external view returns (address feeRecipient, uint256 fee);

    function getMinDelegationAmount(bytes32 _rateManagerId) external view returns (uint256);

    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view returns (uint256);
}

