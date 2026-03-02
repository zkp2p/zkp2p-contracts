// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOracleAdapter } from "../interfaces/IOracleAdapter.sol";

/**
 * @title RevertingOracleAdapterMock
 * @notice Mock oracle adapter whose getRate always reverts.
 * @dev Used to test fallback behaviour when the oracle adapter fails.
 */
contract RevertingOracleAdapterMock is IOracleAdapter {

    function validateConfig(bytes calldata rawConfig) external pure override returns (bytes memory) {
        return rawConfig;
    }

    function getRate(bytes calldata)
        external
        pure
        override
        returns (bool, uint256, uint256)
    {
        revert("RevertingOracleAdapterMock: forced revert");
    }
}
