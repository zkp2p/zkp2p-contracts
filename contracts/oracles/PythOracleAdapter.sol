// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPyth } from "../interfaces/IPyth.sol";
import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title PythOracleAdapter
 * @notice Oracle adapter for Pyth Network price feeds.
 * @dev Normalizes answers to 1e18 preciseUnits ("fiat per deposit token") with rounding-up.
 *
 * Raw config format:
 * - abi.encode(bytes32 feedId, bool invert)
 *
 * Normalized config format (packed bytes, length = 33):
 * - [0..31]  feedId (bytes32)
 * - [32]     invert flag (uint8; 0 = false, 1 = true)
 */
contract PythOracleAdapter is IOracleAdapter {
    using Math for uint256;

    /* ============ Constants ============ */

    uint256 internal constant PRECISE_UNIT = 1e18;

    /* ============ State ============ */

    IPyth public immutable pyth;

    /* ============ Constructor ============ */

    constructor(address _pyth) {
        pyth = IPyth(_pyth);
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Validates raw config and returns packed normalized config.
     * @dev Reverts if feedId is zero, feed doesn't exist in Pyth, or exponent is out of range.
     */
    function validateConfig(bytes calldata rawConfig) external view returns (bytes memory normalizedConfig) {
        (bytes32 feedId, bool invert) = abi.decode(rawConfig, (bytes32, bool));
        require(feedId != bytes32(0), "Zero feedId");

        IPyth.Price memory price = pyth.getPriceUnsafe(feedId);
        require(price.expo <= 0 && price.expo >= -18, "Unsupported exponent");

        normalizedConfig = abi.encodePacked(feedId, invert ? bytes1(uint8(1)) : bytes1(uint8(0)));
    }

    /**
     * @notice Returns the market rate in preciseUnits and the oracle `publishTime`.
     * @dev Returns (false, 0, 0) on invalid oracle responses. Does not perform staleness checks.
     *      Uses `getPriceUnsafe` because staleness is checked by EscrowV2 via `maxStaleness`.
     */
    function getRate(bytes calldata normalizedConfig)
        external
        view
        returns (bool valid, uint256 rate, uint256 updatedAt)
    {
        (bytes32 feedId, bool invert) = _decodeNormalizedConfig(normalizedConfig);

        int64 price;
        int32 expo;
        uint publishTime;
        try pyth.getPriceUnsafe(feedId) returns (IPyth.Price memory p) {
            price = p.price;
            expo = p.expo;
            publishTime = p.publishTime;
        } catch {
            return (false, 0, 0);
        }

        if (price <= 0) {
            return (false, 0, 0);
        }
        if (publishTime == 0) {
            return (false, 0, 0);
        }
        if (expo > 0 || expo < -18) {
            return (false, 0, 0);
        }

        uint256 priceUint = uint256(uint64(price));
        uint256 absExpo = uint256(uint32(-expo));
        uint256 decimalsScale = 10 ** absExpo;

        if (invert) {
            uint256 invertedRate = Math.mulDiv(PRECISE_UNIT, decimalsScale, priceUint, Math.Rounding.Up);
            return (true, invertedRate, publishTime);
        }

        uint256 directRate = Math.mulDiv(priceUint, PRECISE_UNIT, decimalsScale, Math.Rounding.Up);
        return (true, directRate, publishTime);
    }

    /* ============ Internal Functions ============ */

    function _decodeNormalizedConfig(bytes calldata normalizedConfig)
        internal
        pure
        returns (bytes32 feedId, bool invert)
    {
        require(normalizedConfig.length == 33, "Invalid config");

        uint8 invertByte;
        assembly {
            feedId := calldataload(normalizedConfig.offset)
            invertByte := byte(0, calldataload(add(normalizedConfig.offset, 32)))
        }

        invert = invertByte != 0;
    }
}
