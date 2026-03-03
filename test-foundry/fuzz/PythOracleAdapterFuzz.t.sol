// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { PythOracleAdapter } from "../../contracts/oracles/PythOracleAdapter.sol";
import { PythMock } from "../../contracts/mocks/PythMock.sol";

contract PythOracleAdapterFuzz is Test {
    using Math for uint256;

    uint256 constant PRECISE_UNIT = 1e18;

    PythOracleAdapter public adapter;
    PythMock public pythMock;

    bytes32 constant FEED_ID = keccak256("FUZZ/FEED");

    function setUp() public {
        pythMock = new PythMock();
        adapter = new PythOracleAdapter(address(pythMock));
    }

    function testFuzz_getRate_directRate(int64 price, int32 expo) public {
        // Bound to valid ranges
        vm.assume(price > 0);
        vm.assume(expo <= 0 && expo >= -18);

        pythMock.setPrice(FEED_ID, price, 0, expo, block.timestamp);
        bytes memory norm = adapter.validateConfig(abi.encode(FEED_ID, false));

        (bool valid, uint256 rate,) = adapter.getRate(norm);

        assertTrue(valid);
        assertGt(rate, 0);

        // Verify rate calculation: rate = price * 1e18 / 10^|expo|
        uint256 priceUint = uint256(uint64(price));
        uint256 absExpo = uint256(uint32(-expo));
        uint256 decimalsScale = 10 ** absExpo;
        uint256 expectedRate = Math.mulDiv(priceUint, PRECISE_UNIT, decimalsScale, Math.Rounding.Up);

        assertEq(rate, expectedRate);
    }

    function testFuzz_getRate_inversionIdentity(int64 price, int32 expo) public {
        // Bound to valid ranges
        vm.assume(price > 0);
        vm.assume(expo <= 0 && expo >= -18);

        pythMock.setPrice(FEED_ID, price, 0, expo, block.timestamp);

        bytes memory normDirect = adapter.validateConfig(abi.encode(FEED_ID, false));
        bytes memory normInverted = adapter.validateConfig(abi.encode(FEED_ID, true));

        (bool validDirect, uint256 directRate,) = adapter.getRate(normDirect);
        (bool validInverted, uint256 invertedRate,) = adapter.getRate(normInverted);

        assertTrue(validDirect);
        assertTrue(validInverted);

        // directRate * invertedRate should be approximately 1e36
        // Due to rounding up on both, the product is >= 1e36
        uint256 product = directRate * invertedRate;
        assertGe(product, 1e36);

        // The product should be close to 1e36 — within a reasonable bound
        // Max rounding error: 2 * max(directRate, invertedRate) since both round up by at most 1
        uint256 maxRate = directRate > invertedRate ? directRate : invertedRate;
        assertLe(product, 1e36 + 2 * maxRate);
    }

    function testFuzz_getRate_negativePriceInvalid(int64 price, int32 expo) public {
        vm.assume(price <= 0);
        vm.assume(expo <= 0 && expo >= -18);

        pythMock.setPrice(FEED_ID, price, 0, expo, block.timestamp);

        // Manually construct 34-byte normalized config (can't use validateConfig since price may be 0)
        uint8 absExpo = uint8(uint32(-expo));
        bytes memory norm = abi.encodePacked(FEED_ID, absExpo, bytes1(uint8(0)));

        (bool valid,,) = adapter.getRate(norm);

        assertFalse(valid);
    }
}
