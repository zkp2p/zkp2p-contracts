// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IOracleAdapter
 * @notice Generic adapter interface for reading and normalizing oracle rates.
 * @dev Adapters MUST be view-only (no state mutation) and must normalize rates to 1e18 preciseUnits.
 *
 * Rate semantics:
 * - Returned `rate` is "fiat per deposit token" in preciseUnits (1e18).
 * - Return `valid=false` (not revert) for typical oracle failure modes (stale round, negative answer, etc.).
 */
interface IOracleAdapter {
    /**
     * @notice Validates and normalizes adapter-specific config for storage.
     * @dev Should revert on invalid config. The returned bytes are stored by the registry and passed back into `getRate`.
     *      Implementations may cache metadata (e.g. feed decimals) in the normalized config to reduce read-time work.
     * @param rawConfig Adapter-specific configuration blob.
     * @return normalizedConfig Normalized configuration blob suitable for onchain storage.
     */
    function validateConfig(bytes calldata rawConfig) external view returns (bytes memory normalizedConfig);

    /**
     * @notice Returns the market rate in 1e18 preciseUnits.
     * @dev Should not revert on normal oracle failures; return `valid=false` instead.
     * @param normalizedConfig Configuration blob previously returned by `validateConfig`.
     * @return valid True iff a usable quote was produced.
     * @return rate Market rate in preciseUnits (1e18).
     * @return updatedAt Oracle timestamp (0 if unavailable).
     */
    function getRate(bytes calldata normalizedConfig)
        external
        view
        returns (bool valid, uint256 rate, uint256 updatedAt);
}

