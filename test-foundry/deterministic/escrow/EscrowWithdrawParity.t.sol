// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowWithdrawParityTest is EscrowLegacyFixture {
    event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount);
    event DepositClosed(uint256 depositId, address depositor);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.08e18});
        _createAsOffRamper(params);
    }

    function _withdraw(address caller, uint256 depositId) internal {
        vm.prank(caller);
        escrow.withdrawDeposit(depositId);
    }

    function _signalOutstandingIntent() internal returns (bytes32) {
        return _signalIntent(0, 50e6, 1.08e18);
    }

    function test_WithdrawDepositTransfersAllAvailableFunds() public {
        uint256 depositorBefore = token.balanceOf(offRamper);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _withdraw(offRamper, 0);
        assertEq(token.balanceOf(offRamper) - depositorBefore, 100e6);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), 100e6);
    }

    function test_WithdrawDepositDeletesDeposit() public {
        assertNotEq(escrow.getDeposit(0).depositor, address(0));
        _withdraw(offRamper, 0);
        assertEq(escrow.getDeposit(0).depositor, address(0));
    }

    function test_WithdrawDepositRemovesAccountDepositId() public {
        assertEq(escrow.getAccountDeposits(offRamper).length, 1);
        _withdraw(offRamper, 0);
        assertEq(escrow.getAccountDeposits(offRamper).length, 0);
    }

    function test_WithdrawDepositDeletesPaymentMethodData() public {
        assertNotEq(escrow.getDepositPaymentMethodData(0, VENMO).intentGatingService, address(0));
        _withdraw(offRamper, 0);
        assertEq(escrow.getDepositPaymentMethodData(0, VENMO).intentGatingService, address(0));
    }

    function test_WithdrawDepositClearsPaymentMethodActive() public {
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDepositPaymentMethodActive(0, VENMO));
    }

    function test_WithdrawDepositClearsPaymentMethodListed() public {
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDepositPaymentMethodListed(0, VENMO));
    }

    function test_WithdrawDepositDeletesPaymentMethodArray() public {
        assertEq(escrow.getDepositPaymentMethods(0).length, 1);
        _withdraw(offRamper, 0);
        assertEq(escrow.getDepositPaymentMethods(0).length, 0);
    }

    function test_WithdrawDepositDeletesCurrencyArray() public {
        assertEq(escrow.getDepositCurrencies(0, VENMO).length, 1);
        _withdraw(offRamper, 0);
        assertEq(escrow.getDepositCurrencies(0, VENMO).length, 0);
    }

    function test_WithdrawDepositDeletesCurrencyMinimumRate() public {
        assertNotEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
        _withdraw(offRamper, 0);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_WithdrawDepositClearsCurrencyListed() public {
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDepositCurrencyListed(0, VENMO, USD));
    }

    function test_WithdrawDepositEmitsWithdrawal() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 100e6);
        _withdraw(offRamper, 0);
    }

    function test_WithdrawDepositClearsAcceptingState() public {
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_WithdrawDepositEmitsDepositClosed() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, offRamper);
        _withdraw(offRamper, 0);
    }

    function test_WithdrawDepositWithOutstandingIntentTransfersOnlyAvailableFunds() public {
        _signalOutstandingIntent();
        uint256 depositorBefore = token.balanceOf(offRamper);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _withdraw(offRamper, 0);
        assertEq(token.balanceOf(offRamper) - depositorBefore, 50e6);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), 50e6);
    }

    function test_WithdrawDepositWithOutstandingIntentZerosRemainingOnly() public {
        _signalOutstandingIntent();
        _withdraw(offRamper, 0);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.depositor, offRamper);
        assertEq(deposit.remainingDeposits, 0);
        assertEq(deposit.outstandingIntentAmount, 50e6);
    }

    function test_WithdrawDepositWithOutstandingIntentDisablesDeposit() public {
        _signalOutstandingIntent();
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_WithdrawDepositWithOutstandingIntentEmitsAvailableWithdrawal() public {
        _signalOutstandingIntent();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 50e6);
        _withdraw(offRamper, 0);
    }

    function test_WithdrawDepositWithOutstandingIntentClearsAcceptingState() public {
        _signalOutstandingIntent();
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_WithdrawDepositWithExpiredIntentTransfersReclaimedAndAvailableFunds() public {
        _signalOutstandingIntent();
        vm.warp(block.timestamp + 1 days + 1);
        uint256 depositorBefore = token.balanceOf(offRamper);
        uint256 escrowBefore = token.balanceOf(address(escrow));
        _withdraw(offRamper, 0);
        assertEq(token.balanceOf(offRamper) - depositorBefore, 100e6);
        assertEq(escrowBefore - token.balanceOf(address(escrow)), 100e6);
    }

    function test_WithdrawDepositWithExpiredIntentDeletesDeposit() public {
        _signalOutstandingIntent();
        vm.warp(block.timestamp + 1 days + 1);
        _withdraw(offRamper, 0);
        assertEq(escrow.getDeposit(0).depositor, address(0));
    }

    function test_WithdrawDepositWithExpiredIntentDeletesIntent() public {
        bytes32 intentHash = _signalOutstandingIntent();
        assertEq(escrow.getDepositIntent(0, intentHash).amount, 50e6);
        vm.warp(block.timestamp + 1 days + 1);
        _withdraw(offRamper, 0);
        assertEq(escrow.getDepositIntent(0, intentHash).amount, 0);
    }

    function test_WithdrawDepositWithExpiredIntentEmitsFullWithdrawal() public {
        _signalOutstandingIntent();
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, offRamper, 100e6);
        _withdraw(offRamper, 0);
    }

    function test_WithdrawDepositWithExpiredIntentClearsAcceptingState() public {
        _signalOutstandingIntent();
        vm.warp(block.timestamp + 1 days + 1);
        _withdraw(offRamper, 0);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_WithdrawDepositWithExpiredIntentEmitsDepositClosed() public {
        _signalOutstandingIntent();
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, offRamper);
        _withdraw(offRamper, 0);
    }

    function test_WithdrawDepositRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, maliciousOnRamper, offRamper));
        _withdraw(maliciousOnRamper, 0);
    }

    function test_WithdrawDepositRejectsDelegate() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamperDelegate, offRamper));
        _withdraw(offRamperDelegate, 0);
    }

    function test_WithdrawDepositRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UnauthorizedCaller.selector, offRamper, address(0)));
        _withdraw(offRamper, 999);
    }

    function test_WithdrawDepositSucceedsWhilePaused() public {
        escrow.pauseEscrow();
        _withdraw(offRamper, 0);
        assertEq(escrow.getDeposit(0).depositor, address(0));
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
