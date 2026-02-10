// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";
import { IOracleRateManagerRegistry } from "../interfaces/IOracleRateManagerRegistry.sol";
import { BaseRateManagerRegistry } from "./BaseRateManagerRegistry.sol";

/**
 * @dev Minimal Chainlink AggregatorV3 interface.
 */
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * @title OracleRateManagerRegistry
 * @notice Permissionless registry of “deposit rate managers” backed by onchain oracles.
 * @dev `getMinRate()` is view-only and returns 0 (disabled) if the oracle is misconfigured or stale.
 *
 * Rate semantics:
 * - All rates returned are in preciseUnits (1e18).
 * - Rates represent "fiat per deposit token".
 * - For PeerOne (USDC-only strategy), USD may be configured with a zero feed to use a fixed 1.0 market rate.
 */
contract OracleRateManagerRegistry is IOracleRateManagerRegistry, BaseRateManagerRegistry {
    using Math for uint256;

    /* ============ Constants ============ */

    uint256 internal constant PRECISE_UNIT = 1e18;
    uint256 internal constant BPS = 10_000;
    bytes32 internal constant USD = keccak256(abi.encodePacked("USD"));

    /* ============ Structs ============ */

    struct OracleConfig {
        address feed;
        uint16 spreadBps;       // 100 = 1%
        uint32 maxStaleness;    // seconds
        bool invert;            // invert the oracle answer
        uint8 feedDecimals;     // cached at config time
        bool isConfigured;      // distinguishes "unset" from "configured with 0 values" (e.g. USD peg)
    }

    /* ============ State Variables ============ */

    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => OracleConfig))) internal oracleConfigs;

    /* ============ External Functions ============ */

    /**
     * @notice Configures an oracle feed + spread for a (rateManagerId, paymentMethod, currency) tuple.
     * @dev Only callable by the rate manager. For non-USD currencies, feed must be non-zero.
     *      For USD, a zero feed is allowed and implies a fixed 1.0 market rate (USDC-only assumption).
     */
    function setOracleConfig(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currency,
        address _feed,
        uint16 _spreadBps,
        uint32 _maxStaleness,
        bool _invert
    )
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethod != bytes32(0), "Invalid payment method");
        require(_currency != bytes32(0), "Invalid currency");
        require(_spreadBps <= BPS, "Invalid spread");

        uint8 decimals_;
        if (_feed == address(0)) {
            // Only USD is allowed to use a fixed 1.0 market rate.
            require(_currency == USD, "Invalid feed");
        } else {
            require(_maxStaleness > 0, "Invalid staleness");
            decimals_ = IAggregatorV3(_feed).decimals();
            require(decimals_ <= 18, "Unsupported decimals");
        }

        oracleConfigs[_rateManagerId][_paymentMethod][_currency] = OracleConfig({
            feed: _feed,
            spreadBps: _spreadBps,
            maxStaleness: _maxStaleness,
            invert: _invert,
            feedDecimals: decimals_,
            isConfigured: true
        });

        emit RateManagerOracleConfigUpdated(_rateManagerId, _paymentMethod, _currency, _feed, _spreadBps, _maxStaleness, _invert);
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
            address feed,
            uint8 feedDecimals,
            uint16 spreadBps,
            uint32 maxStaleness,
            bool invert
        )
    {
        OracleConfig storage cfg = oracleConfigs[_rateManagerId][_paymentMethod][_currency];
        return (cfg.isConfigured, cfg.feed, cfg.feedDecimals, cfg.spreadBps, cfg.maxStaleness, cfg.invert);
    }

    /**
     * @notice Returns the manager-level minimum rate for a (paymentMethod, currency) pair.
     * @dev Returns 0 if the tuple is not configured, the oracle returns invalid data, or the data is stale.
     *      For USD with a zero feed, returns (1 + spread) in preciseUnits.
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

        uint256 baseRate = _getBaseRate(cfg, _currency);
        if (baseRate == 0) {
            return 0;
        }

        // Apply spread as a minimum floor: marketRate * (1 + spreadBps)
        return Math.mulDiv(baseRate, BPS + uint256(cfg.spreadBps), BPS, Math.Rounding.Up);
    }

    /* ============ Internal Functions ============ */

    function _getBaseRate(OracleConfig storage cfg, bytes32 currency) internal view returns (uint256) {
        if (cfg.feed == address(0)) {
            // Fixed 1.0 rate for USD under the USDC-only PeerOne assumption.
            if (currency != USD) {
                return 0;
            }
            return PRECISE_UNIT;
        }

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = IAggregatorV3(cfg.feed).latestRoundData();

        if (answer <= 0) {
            return 0;
        }
        if (updatedAt == 0) {
            return 0;
        }
        if (answeredInRound < roundId) {
            return 0;
        }
        if (block.timestamp - updatedAt > cfg.maxStaleness) {
            return 0;
        }

        uint256 ans = uint256(answer);
        uint256 scale = 10 ** uint256(cfg.feedDecimals);

        // Convert oracle decimals to 1e18 preciseUnits. Round up to avoid under-enforcing min rates.
        if (cfg.invert) {
            // rate = (1e18 * 10^decimals) / answer
            return Math.mulDiv(PRECISE_UNIT, scale, ans, Math.Rounding.Up);
        }

        // rate = (answer * 1e18) / 10^decimals
        return Math.mulDiv(ans, PRECISE_UNIT, scale, Math.Rounding.Up);
    }
}
