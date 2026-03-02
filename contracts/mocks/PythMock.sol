// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPyth } from "../interfaces/IPyth.sol";

/**
 * @title PythMock
 * @notice Minimal mock for the Pyth Network oracle, used in testing.
 */
contract PythMock is IPyth {
    mapping(bytes32 => Price) internal _prices;
    mapping(bytes32 => bool) internal _feedExists;

    function setPrice(
        bytes32 id,
        int64 price,
        uint64 conf,
        int32 expo,
        uint publishTime
    ) external {
        _prices[id] = Price(price, conf, expo, publishTime);
        _feedExists[id] = true;
    }

    function removePrice(bytes32 id) external {
        delete _prices[id];
        _feedExists[id] = false;
    }

    function getPriceUnsafe(bytes32 id) external view override returns (Price memory price) {
        require(_feedExists[id], "feed not found");
        return _prices[id];
    }

    function getUpdateFee(bytes[] calldata) external pure override returns (uint feeAmount) {
        return 1;
    }

    function updatePriceFeeds(bytes[] calldata) external payable override {
        // no-op in mock
    }
}
