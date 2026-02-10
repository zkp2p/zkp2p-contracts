// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";
import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";
import { IOracleRateManagerRegistry } from "../interfaces/IOracleRateManagerRegistry.sol";
import { BaseRateManagerRegistry } from "./BaseRateManagerRegistry.sol";

/**
 * @title OracleRateManagerRegistry
 * @notice Permissionless registry of “deposit rate managers” backed by onchain oracles.
 * @dev `getMinRate()` is view-only and returns 0 (disabled) if the tuple is unconfigured, the adapter fails,
 *      or the adapter's data is stale.
 *
 * Rate semantics:
 * - All rates returned are in preciseUnits (1e18).
 * - Rates represent "fiat per deposit token".
 */
contract OracleRateManagerRegistry is IOracleRateManagerRegistry, BaseRateManagerRegistry {
    using Math for uint256;

    /* ============ Constants ============ */

    uint256 internal constant BPS = 10_000;
    // Upper bound for stored adapter config bytes. This keeps storage reads and event logs bounded and helps avoid
    // accidentally configuring a tuple such that `getMinRate()` becomes prohibitively expensive.
    //
    // 256 bytes is intentionally generous for oracle configs (e.g. Chainlink normalized config is 22 bytes) while
    // still preventing unbounded blobs.
    uint256 internal constant MAX_ADAPTER_CONFIG_BYTES = 256;

    /* ============ Structs ============ */

    struct OracleConfig {
        address adapter;
        bytes adapterConfig;    // Adapter-specific config blob (normalized via validateConfig)
        uint16 spreadBps;       // 100 = 1%
        uint32 maxStaleness;    // seconds
        bool isConfigured;      // distinguishes "unset" from configured
    }

    /* ============ State Variables ============ */

    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => OracleConfig))) internal oracleConfigs;

    /* ============ External Functions ============ */

    /**
     * @notice Configures an oracle feed + spread for a (rateManagerId, paymentMethod, currency) tuple.
     * @dev Only callable by the rate manager. The adapter is responsible for validating and normalizing
     *      `_rawAdapterConfig` (e.g. Chainlink adapter supports `feed == address(0)` as a constant 1.0 base rate
     *      which can be used for USD when the deposit token is assumed to be USDC).
     */
    function setOracleConfig(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currency,
        address _adapter,
        bytes calldata _rawAdapterConfig,
        uint16 _spreadBps,
        uint32 _maxStaleness
    )
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethod != bytes32(0), "Invalid payment method");
        require(_currency != bytes32(0), "Invalid currency");
        require(_adapter != address(0), "Invalid adapter");
        require(_adapter.code.length > 0, "Invalid adapter");
        require(_spreadBps <= BPS, "Invalid spread");
        require(_maxStaleness > 0, "Invalid staleness");

        bytes memory normalizedAdapterConfig = IOracleAdapter(_adapter).validateConfig(_rawAdapterConfig);
        require(normalizedAdapterConfig.length <= MAX_ADAPTER_CONFIG_BYTES, "Config too long");

        oracleConfigs[_rateManagerId][_paymentMethod][_currency] = OracleConfig({
            adapter: _adapter,
            adapterConfig: normalizedAdapterConfig,
            spreadBps: _spreadBps,
            maxStaleness: _maxStaleness,
            isConfigured: true
        });

        emit RateManagerOracleConfigUpdated(
            _rateManagerId,
            _paymentMethod,
            _currency,
            _adapter,
            _spreadBps,
            _maxStaleness,
            normalizedAdapterConfig
        );
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Returns the oracle configuration for a tuple.
     */
    function getOracleConfig(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency)
        external
        view
        returns (
            bool isConfigured,
            address adapter,
            bytes memory adapterConfig,
            uint16 spreadBps,
            uint32 maxStaleness
        )
    {
        OracleConfig storage cfg = oracleConfigs[_rateManagerId][_paymentMethod][_currency];
        return (cfg.isConfigured, cfg.adapter, cfg.adapterConfig, cfg.spreadBps, cfg.maxStaleness);
    }

    /**
     * @notice Returns the manager-level minimum rate for a (paymentMethod, currency) pair.
     * @dev Returns 0 if the tuple is not configured, the oracle returns invalid data, or the data is stale.
     *      For constant-rate adapter configs (e.g. Chainlink `feed == address(0)`), returns (1 + spread) in preciseUnits.
     */
    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency)
        external
        view
        override(BaseRateManagerRegistry, IBaseRateManagerRegistry)
        returns (uint256)
    {
        OracleConfig storage cfg = oracleConfigs[_rateManagerId][_paymentMethod][_currency];
        if (!cfg.isConfigured) {
            return 0;
        }

        (bool isValidQuote, uint256 marketRate, uint256 rateUpdatedAt) = _getBaseRate(cfg);
        if (!isValidQuote || marketRate == 0) {
            return 0;
        }

        if (rateUpdatedAt == 0) {
            return 0;
        }
        if (rateUpdatedAt > block.timestamp) {
            return 0;
        }
        if (block.timestamp - rateUpdatedAt > cfg.maxStaleness) {
            return 0;
        }

        // Apply spread as a minimum floor: marketRate * (1 + spreadBps)
        return Math.mulDiv(marketRate, BPS + uint256(cfg.spreadBps), BPS, Math.Rounding.Up);
    }

    /* ============ Internal Functions ============ */

    function _getBaseRate(OracleConfig storage cfg)
        internal
        view
        returns (bool isValidQuote, uint256 marketRate, uint256 rateUpdatedAt)
    {
        try IOracleAdapter(cfg.adapter).getRate(cfg.adapterConfig) returns (
            bool valid_,
            uint256 rate_,
            uint256 updatedAt_
        ) {
            return (valid_, rate_, updatedAt_);
        } catch {
            return (false, 0, 0);
        }
    }
}
