// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title RevertingOracleAdapterMock
 * @notice Test helper adapter that reverts on getRate().
 */
contract RevertingOracleAdapterMock is IOracleAdapter {
    function validateConfig(bytes calldata rawConfig) external pure returns (bytes memory normalizedConfig) {
        return rawConfig;
    }

    function getRate(bytes calldata) external pure returns (bool, uint256, uint256) {
        revert("Adapter failure");
    }
}

