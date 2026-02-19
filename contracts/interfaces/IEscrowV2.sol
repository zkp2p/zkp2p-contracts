// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "./IEscrow.sol";

/**
 * @title IEscrowV2
 * @notice Extended escrow interface with native oracle-spread rates and delegated rate managers.
 */
interface IEscrowV2 is IEscrow {
    /* ============ Structs ============ */

    struct OracleRateConfig {
        address adapter;
        bytes adapterConfig;
        uint16 spreadBps;
        uint32 maxStaleness;
    }

    struct RateManagerConfig {
        address rateManager;
        bytes32 rateManagerId;
    }

    /* ============ Events ============ */

    event DepositOracleRateConfigSet(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode,
        address adapter,
        bytes adapterConfig,
        uint16 spreadBps,
        uint32 maxStaleness
    );

    event DepositOracleRateConfigRemoved(
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode
    );

    event DepositRateManagerSet(
        uint256 indexed depositId,
        address indexed rateManager,
        bytes32 indexed rateManagerId
    );

    event DepositRateManagerCleared(
        uint256 indexed depositId,
        address indexed rateManager,
        bytes32 indexed rateManagerId
    );

    event OrchestratorRegistryUpdated(address indexed orchestratorRegistry);

    /* ============ Custom Errors ============ */

    error InvalidOracleAdapter(address adapter);
    error InvalidRateManager(address rateManager);
    error InvalidSpread(uint256 spreadBps);
    error RateManagerAlreadySet(bytes32 rateManagerId);
    error RateManagerNotFound(bytes32 rateManagerId);
    error RateManagerNotSet(uint256 depositId);

    /* ============ External Functions ============ */

    function setOracleRateConfig(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        OracleRateConfig calldata _config
    ) external;

    function setOracleRateConfigBatch(
        uint256 _depositId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencyCodes,
        OracleRateConfig[][] calldata _configs
    ) external;

    function removeOracleRateConfig(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external;

    function setRateManager(
        uint256 _depositId,
        address _rateManager,
        bytes32 _rateManagerId
    ) external;

    function clearRateManager(uint256 _depositId) external;

    function setOrchestratorRegistry(address _orchestratorRegistry) external;

    /* ============ View Functions ============ */

    function getDepositOracleRateConfig(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external view returns (OracleRateConfig memory);

    function getDepositRateManager(uint256 _depositId)
        external
        view
        returns (address rateManager, bytes32 rateManagerId);

    function getEffectiveRate(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external view returns (uint256);

    function getManagerFee(uint256 _depositId) external view returns (address recipient, uint256 fee);
}
