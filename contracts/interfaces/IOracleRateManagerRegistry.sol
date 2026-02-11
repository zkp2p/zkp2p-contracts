// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IBaseRateManagerRegistry } from "./IBaseRateManagerRegistry.sol";

/**
 * @title IOracleRateManagerRegistry
 * @notice Interface for oracle-backed (pull) rate managers.
 * @dev `getMinRate()` must be a view function and MUST NOT mutate state.
 */
interface IOracleRateManagerRegistry is IBaseRateManagerRegistry {
    /* ============ Events ============ */

    event RateManagerOracleConfigUpdated(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        address adapter,
        uint16 spreadBps,
        uint32 maxStaleness,
        bytes adapterConfig
    );
    event RateManagerOracleConfigRemoved(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency
    );

    /* ============ External Functions ============ */

    function setOracleConfig(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currency,
        address _adapter,
        bytes calldata _rawAdapterConfig,
        uint16 _spreadBps,
        uint32 _maxStaleness
    )
        external;
    function removeOracleConfig(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currency
    )
        external;

    /* ============ View Functions ============ */

    function getOracleConfig(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency)
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
