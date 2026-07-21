// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

abstract contract StakeVaultLegacyFixture is Test {
    uint64 internal constant DAY = 1 days;
    uint64 internal constant EXIT_DELAY = 30 days;

    address internal controller;
    address internal nextController;
    address internal staker;
    address internal maker;
    address internal recipient;

    USDCMock internal token;
    StakeVault internal vault;

    function setUp() public virtual {
        controller = makeAddr("controller");
        nextController = makeAddr("nextController");
        staker = makeAddr("staker");
        maker = makeAddr("maker");
        recipient = makeAddr("recipient");

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        vault = new StakeVault(address(this), token, controller, EXIT_DELAY, DAY);
        token.transfer(staker, 10_000e6);
        vm.prank(staker);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(staker);
        vault.depositStake(amount);
    }

    function _reserve(bytes32 intentHash, uint256 amount, uint64 releaseTime) internal {
        vm.prank(controller);
        vault.reserveStake(staker, intentHash, amount, releaseTime);
    }

    function _reservation(bytes32 intentHash) internal view returns (IStakeVault.Reservation memory) {
        return vault.getReservation(intentHash);
    }
}
