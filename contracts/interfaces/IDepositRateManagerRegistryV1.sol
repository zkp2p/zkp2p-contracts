// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDepositRateManagerRegistryV1
 * @notice Permissionless registry for “deposit rate managers”.
 * A rate manager config is identified by a sequential `rateManagerId` (uint256) and can be shared across many deposits.
 */
interface IDepositRateManagerRegistryV1 {
    /* ============ Structs ============ */

    struct RateManagerConfig {
        address manager;
        address feeRecipient;
        uint256 maxFee;              // Immutable upper bound on `fee` (preciseUnits, 1e18 = 100%)
        uint256 fee;                 // Flat fee in preciseUnits (must be <= maxFee)
        address depositHook;         // Optional hook called on deposit opt-in
        string name;                 // Human-readable name (optional)
        string uri;                  // Metadata URI (optional)
    }

    /* ============ Events ============ */

    event RateManagerCreated(
        uint256 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        uint256 maxFee,
        uint256 fee,
        string name,
        string uri
    );

    event RateManagerConfigUpdated(
        uint256 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        address depositHook,
        string name,
        string uri
    );

    event RateManagerMinRateUpdated(
        uint256 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 minRate
    );

    event RateManagerMinRatesBatchUpdated(uint256 indexed rateManagerId, uint256 count);
    event RateManagerFeeUpdated(uint256 indexed rateManagerId, uint256 fee);

    /* ============ External Functions ============ */

    function createRateManager(RateManagerConfig calldata _config) external returns (uint256 rateManagerId);

    function setRateManagerConfig(uint256 _rateManagerId, address _newManager, address _newFeeRecipient, address _newHook, string calldata _newName, string calldata _newUri) external;

    function setFee(uint256 _rateManagerId, uint256 _newFee) external;

    function setMinRate(uint256 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate) external;

    function setMinRatesBatch(uint256 _rateManagerId, bytes32[] calldata _paymentMethods, bytes32[][] calldata _currencies, uint256[][] calldata _minRates) external;

    /* ============ View Functions ============ */

    function isRateManager(uint256 _rateManagerId) external view returns (bool);

    function getRateManager(uint256 _rateManagerId) external view returns (RateManagerConfig memory);

    function getFee(uint256 _rateManagerId) external view returns (address feeRecipient, uint256 fee);

    function getDepositHook(uint256 _rateManagerId) external view returns (address);

    function getMinRate(uint256 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view returns (uint256);
}
