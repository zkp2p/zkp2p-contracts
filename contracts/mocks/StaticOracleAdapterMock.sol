// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title StaticOracleAdapterMock
 * @notice Test helper adapter that returns a static tuple decoded from config.
 * @dev `normalizedConfig` is expected to be abi.encode(bool valid, uint256 rate, uint256 updatedAt).
 */
contract StaticOracleAdapterMock is IOracleAdapter {
    function validateConfig(bytes calldata rawConfig) external pure returns (bytes memory normalizedConfig) {
        return rawConfig;
    }

    function getRate(bytes calldata normalizedConfig)
        external
        pure
        returns (bool valid, uint256 rate, uint256 updatedAt)
    {
        return abi.decode(normalizedConfig, (bool, uint256, uint256));
    }
}

