// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowLegacyFixture} from "../helpers/EscrowLegacyFixture.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";

contract EscrowRateRangeParityTest is EscrowLegacyFixture {
    event DepositMinConversionRateUpdated(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newRate
    );
    event DepositIntentAmountRangeUpdated(uint256 indexed depositId, IEscrow.Range range);
    event DepositAcceptingIntentsUpdated(uint256 indexed depositId, bool accepting);

    function setUp() public override {
        super.setUp();
        IEscrow.CreateDepositParams memory params = _baseCreateParams();
        params.intentAmountRange.max = 100e6;
        params.retainOnEmpty = false;
        params.currencies[0] = new IEscrow.Currency[](1);
        params.currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: 1.01e18});
        _createAsOffRamper(params);
    }

    function _setRate(address caller, uint256 depositId, bytes32 currency, uint256 rate) internal {
        vm.prank(caller);
        escrow.setCurrencyMinRate(depositId, VENMO, currency, rate);
    }

    function _setRange(address caller, uint256 depositId, IEscrow.Range memory range) internal {
        vm.prank(caller);
        escrow.setIntentRange(depositId, range);
    }

    function test_SetCurrencyMinRateUpdatesRate() public {
        _setRate(offRamper, 0, USD, 1.05e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.05e18);
    }

    function test_SetCurrencyMinRateEmitsUpdate() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(0, VENMO, USD, 1.05e18);
        _setRate(offRamper, 0, USD, 1.05e18);
    }

    function test_SetCurrencyMinRateAllowsDelegate() public {
        _setRate(offRamperDelegate, 0, USD, 1.05e18);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 1.05e18);
    }

    function test_SetCurrencyMinRateRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _setRate(maliciousOnRamper, 0, USD, 1.05e18);
    }

    function test_SetCurrencyMinRateRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _setRate(offRamper, 999, USD, 1.05e18);
    }

    function test_SetCurrencyMinRateRejectsUnsupportedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.CurrencyNotSupported.selector, VENMO, EUR));
        _setRate(offRamper, 0, EUR, 1.05e18);
    }

    function test_SetCurrencyMinRateRejectsZeroRate() public {
        vm.expectRevert(IEscrow.ZeroConversionRate.selector);
        _setRate(offRamper, 0, USD, 0);
    }

    function test_SetCurrencyMinRateRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setRate(offRamper, 0, USD, 1.05e18);
    }

    function test_SetIntentRangeUpdatesBothBounds() public {
        IEscrow.Range memory range = IEscrow.Range({min: 5e6, max: 100e6});
        _setRange(offRamper, 0, range);
        IEscrow.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.intentAmountRange.min, 5e6);
        assertEq(deposit.intentAmountRange.max, 100e6);
    }

    function test_SetIntentRangeEmitsUpdate() public {
        IEscrow.Range memory range = IEscrow.Range({min: 5e6, max: 100e6});
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositIntentAmountRangeUpdated(0, range);
        _setRange(offRamper, 0, range);
    }

    function test_SetIntentRangeAllowsIncreasingMinimum() public {
        IEscrow.Range memory range = IEscrow.Range({min: 20e6, max: 100e6});
        _setRange(offRamper, 0, range);
        assertEq(escrow.getDeposit(0).intentAmountRange.min, 20e6);
    }

    function test_SetIntentRangeDisablesDepositWhenLiquidityBelowNewMinimum() public {
        vm.prank(offRamper);
        escrow.removeFunds(0, 85e6);
        _setRange(offRamper, 0, IEscrow.Range({min: 20e6, max: 100e6}));
        assertEq(escrow.getDeposit(0).remainingDeposits, 15e6);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetIntentRangeEmitsDisabledStateWhenLiquidityBelowNewMinimum() public {
        vm.prank(offRamper);
        escrow.removeFunds(0, 85e6);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, false);
        _setRange(offRamper, 0, IEscrow.Range({min: 20e6, max: 100e6}));
    }

    function test_SetIntentRangeDoesNotReenableAfterMinimumDecreases() public {
        vm.prank(offRamper);
        escrow.removeFunds(0, 85e6);
        _setRange(offRamper, 0, IEscrow.Range({min: 20e6, max: 100e6}));
        _setRange(offRamper, 0, IEscrow.Range({min: 5e6, max: 250e6}));
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetIntentRangeAllowsDelegate() public {
        _setRange(offRamperDelegate, 0, IEscrow.Range({min: 5e6, max: 100e6}));
        assertEq(escrow.getDeposit(0).intentAmountRange.min, 5e6);
    }

    function test_SetIntentRangeRejectsUnauthorizedCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.UnauthorizedCallerOrDelegate.selector, maliciousOnRamper, offRamper, offRamperDelegate
            )
        );
        _setRange(maliciousOnRamper, 0, IEscrow.Range({min: 5e6, max: 100e6}));
    }

    function test_SetIntentRangeRejectsMissingDepositWithUnauthorizedError() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.UnauthorizedCallerOrDelegate.selector, offRamper, address(0), address(0))
        );
        _setRange(offRamper, 999, IEscrow.Range({min: 5e6, max: 100e6}));
    }

    function test_SetIntentRangeRejectsZeroMinimum() public {
        vm.expectRevert(IEscrow.ZeroMinValue.selector);
        _setRange(offRamper, 0, IEscrow.Range({min: 0, max: 100e6}));
    }

    function test_SetIntentRangeRejectsMinimumAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.InvalidRange.selector, 200e6, 100e6));
        _setRange(offRamper, 0, IEscrow.Range({min: 200e6, max: 100e6}));
    }

    function test_SetIntentRangeRejectsWhilePaused() public {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        _setRange(offRamper, 0, IEscrow.Range({min: 5e6, max: 100e6}));
    }
}
