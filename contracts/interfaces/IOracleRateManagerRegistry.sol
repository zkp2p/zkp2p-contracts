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
        address feed,
        uint16 spreadBps,
        uint32 maxStaleness,
        bool invert
    );

    /* ============ External Functions ============ */

    function setOracleConfig(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currency,
        address _feed,
        uint16 _spreadBps,
        uint32 _maxStaleness,
        bool _invert
    )
        external;

    /* ============ View Functions ============ */

    function getOracleConfig(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency)
        external
        view
        returns (
            bool isConfigured,
            address feed,
            uint8 feedDecimals,
            uint16 spreadBps,
            uint32 maxStaleness,
            bool invert
        );
}
