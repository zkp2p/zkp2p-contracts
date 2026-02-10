// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";
import { IManualRateManagerRegistry } from "../interfaces/IManualRateManagerRegistry.sol";
import { BaseRateManagerRegistry } from "./BaseRateManagerRegistry.sol";

/**
 * @title ManualRateManagerRegistry
 * @notice Permissionless registry of “deposit rate managers” with manually-set per-pair min rates.
 */
contract ManualRateManagerRegistry is IManualRateManagerRegistry, BaseRateManagerRegistry {
    /* ============ State Variables ============ */

    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => uint256))) internal minRates;

    /* ============ External Functions ============ */

    /**
     * @notice Sets the manager-level minimum rate for a specific (paymentMethod, currency) pair.
     * @dev Does not validate whether the payment method or currency are registered; Escrow/Orchestrator enforce
     *      deposit support and payment method whitelisting. Setting to 0 disables the pair at the manager level.
     */
    function setMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate)
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethod != bytes32(0), "Invalid payment method");
        require(_currency != bytes32(0), "Invalid currency");

        minRates[_rateManagerId][_paymentMethod][_currency] = _minRate;

        emit RateManagerMinRateUpdated(_rateManagerId, _paymentMethod, _currency, _minRate);
    }

    /**
     * @notice Batch update manager-level minimum rates.
     * @dev For each i in paymentMethods, currencies[i] and minRates[i] must be same length.
     *      Reverts on any array length mismatch or zero keys. No validation of platform/currency registration.
     */
    function setMinRatesBatch(
        bytes32 _rateManagerId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencies,
        uint256[][] calldata _minRatesArr
    )
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethods.length == _currencies.length, "Array length mismatch");
        require(_paymentMethods.length == _minRatesArr.length, "Array length mismatch");

        uint256 total;
        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            bytes32 pm = _paymentMethods[i];
            require(pm != bytes32(0), "Invalid payment method");
            bytes32[] calldata currList = _currencies[i];
            uint256[] calldata rateList = _minRatesArr[i];
            require(currList.length == rateList.length, "Array length mismatch");
            for (uint256 j = 0; j < currList.length; j++) {
                bytes32 cur = currList[j];
                require(cur != bytes32(0), "Invalid currency");
                minRates[_rateManagerId][pm][cur] = rateList[j];
                emit RateManagerMinRateUpdated(_rateManagerId, pm, cur, rateList[j]);
                total++;
            }
        }
        emit RateManagerMinRatesBatchUpdated(_rateManagerId, total);
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Returns the manager-level minimum rate for a (paymentMethod, currency) pair.
     * @return minRate Minimum rate in preciseUnits (0 means disabled/unset).
     */
    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency)
        external
        view
        override(BaseRateManagerRegistry, IBaseRateManagerRegistry)
        returns (uint256)
    {
        return minRates[_rateManagerId][_paymentMethod][_currency];
    }
}
