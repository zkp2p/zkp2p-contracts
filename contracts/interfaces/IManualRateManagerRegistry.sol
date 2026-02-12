// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IBaseRateManagerRegistry } from "./IBaseRateManagerRegistry.sol";

/**
 * @title IManualRateManagerRegistry
 * @notice Interface for manual (push) rate managers that set min-rates onchain.
 */
interface IManualRateManagerRegistry is IBaseRateManagerRegistry {
    /* ============ Events ============ */

    event RateManagerMinRateUpdated(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currency,
        uint256 minRate
    );

    event RateManagerMinRatesBatchUpdated(bytes32 indexed rateManagerId, uint256 count);

    /* ============ External Functions ============ */

    function setMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate) external;

    function setMinRatesBatch(
        bytes32 _rateManagerId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencies,
        uint256[][] calldata _minRates
    )
        external;
}

