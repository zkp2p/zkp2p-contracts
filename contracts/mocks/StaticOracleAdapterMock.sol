// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title StaticOracleAdapterMock
 * @notice Mock oracle adapter that returns static values encoded in its config.
 * @dev Config is ABI-encoded as (bool valid, uint256 rate, uint256 updatedAt).
 */
contract StaticOracleAdapterMock is IOracleAdapter {

    function validateConfig(bytes calldata rawConfig) external pure override returns (bytes memory) {
        // Just pass through; any 96-byte blob is accepted.
        return rawConfig;
    }

    function getRate(bytes calldata normalizedConfig)
        external
        pure
        override
        returns (bool valid, uint256 rate, uint256 updatedAt)
    {
        (valid, rate, updatedAt) = abi.decode(normalizedConfig, (bool, uint256, uint256));
    }
}
