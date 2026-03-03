// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IPyth
 * @notice Minimal interface for the Pyth Network oracle contract.
 */
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint feeAmount);

    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}
