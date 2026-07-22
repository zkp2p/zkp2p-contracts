// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2ManagementTest is EscrowV2LegacyFixture {
    event DepositReceived(
        uint256 indexed depositId,
        address indexed depositor,
        IERC20 indexed token,
        uint256 amount,
        IEscrowV2.Range range,
        address delegate,
        address guardian
    );
    event DepositFundsAdded(uint256 indexed depositId, address indexed funder, uint256 amount);
    event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount);
    event DepositClosed(uint256 depositId, address depositor);
    event DepositAcceptingIntentsUpdated(uint256 indexed depositId, bool accepting);
    event DepositDelegateSet(uint256 indexed depositId, address indexed depositor, address indexed delegate);
    event DepositDelegateRemoved(uint256 indexed depositId, address indexed depositor);
    event DepositPaymentMethodAdded(
        uint256 indexed depositId, bytes32 indexed method, bytes32 indexed payeeDetails, address gatingService
    );
    event DepositPaymentMethodActiveUpdated(uint256 indexed depositId, bytes32 indexed method, bool active);
    event DepositCurrencyAdded(
        uint256 indexed depositId, bytes32 indexed method, bytes32 indexed currency, uint256 rate
    );
    event DepositRetainOnEmptyUpdated(uint256 indexed depositId, bool retain);

    function _createAsDepositor(IEscrowV2.CreateDepositParams memory params) internal {
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_CreateDepositRejectsMinimumAboveMaximum() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 100e6, max: 10e6}), 1e18, delegate, intentGuardian);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRange.selector, 100e6, 10e6));
        _createAsDepositor(params);
    }

    function test_CreateDepositRejectsAmountBelowMinimum() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(10e6, IEscrowV2.Range({min: 20e6, max: 100e6}), 1e18, delegate, intentGuardian);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.AmountBelowMin.selector, 10e6, 20e6));
        _createAsDepositor(params);
    }

    function test_CreateDepositAllowsZeroCurrencyFloor() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 0, delegate, intentGuardian);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(1, VENMO, USD, 0);
        _createAsDepositor(params);
        assertEq(escrow.getDepositCurrencyMinRate(1, VENMO, USD), 0);
    }

    function test_CreateDepositStoresZeroDelegate() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 50e6}), 1e18, address(0), address(0));
        _createAsDepositor(params);
        assertEq(escrow.getDeposit(1).delegate, address(0));
    }

    function test_DepositToPullsFromCallerButAssignsSpecifiedOwner() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(30e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, delegate, intentGuardian);
        uint256 callerBefore = token.balanceOf(other);
        uint256 ownerBefore = token.balanceOf(depositor);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositReceived(
            1, depositor, IERC20(address(token)), 30e6, params.intentAmountRange, delegate, intentGuardian
        );
        vm.prank(other);
        escrow.depositTo(depositor, params);
        assertEq(escrow.getDeposit(1).depositor, depositor);
        assertEq(escrow.getDeposit(1).remainingDeposits, 30e6);
        assertEq(callerBefore - token.balanceOf(other), 30e6);
        assertEq(token.balanceOf(depositor), ownerBefore);
    }

    function test_AddFundsUpdatesLiquidityAndEmitsFunder() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositFundsAdded(0, other, 25e6);
        vm.prank(other);
        escrow.addFunds(0, 25e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, 525e6);
    }

    function test_AddFundsDoesNotChangeDisabledAcceptingState() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(0, false);
        vm.prank(depositor);
        escrow.addFunds(0, 10e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, 510e6);
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_AddFundsRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        vm.prank(other);
        escrow.addFunds(999, 25e6);
    }

    function test_AddFundsRejectsZeroAmount() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(other);
        escrow.addFunds(0, 0);
    }

    function test_RemoveFundsUpdatesLiquidityAndEmits() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositWithdrawn(0, depositor, 40e6);
        vm.prank(depositor);
        escrow.removeFunds(0, 40e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, 460e6);
    }

    function test_RemoveFundsReclaimsExpiredIntentAndPrunesOrchestrator() public {
        bytes32 intentHash = _lock(address(orchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        vm.prank(depositor);
        escrow.removeFunds(0, 490e6);
        bytes32[] memory pruned = orchestratorMock.getLastPrunedIntents();
        assertEq(pruned.length, 1);
        assertEq(pruned[0], intentHash);
    }

    function test_RemoveFundsDoesNotAutoDisableBelowMinimumLiquidity() public {
        vm.prank(depositor);
        escrow.removeFunds(0, 495e6);
        assertEq(escrow.getDeposit(0).remainingDeposits, 5e6);
        assertTrue(escrow.getDeposit(0).acceptingIntents);
    }

    function test_RemoveFundsRejectsAmountAboveAvailableLiquidity() public {
        _lock(address(orchestratorMock), 20e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, 0, 480e6, 490e6));
        vm.prank(depositor);
        escrow.removeFunds(0, 490e6);
    }

    function test_RemoveFundsRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.removeFunds(0, 40e6);
    }

    function test_WithdrawDepositPrunesExpiredIntentsAndCloses() public {
        _lock(address(orchestratorMock), 20e6);
        vm.warp(block.timestamp + 3601);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, depositor);
        vm.prank(depositor);
        escrow.withdrawDeposit(0);
        assertEq(escrow.getDeposit(0).depositor, address(0));
        assertEq(escrow.getDepositPaymentMethods(0).length, 0);
    }

    function test_WithdrawDepositDisablesAcceptingStateWhenTransitioning() public {
        _lock(address(orchestratorMock), 20e6);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, false);
        vm.prank(depositor);
        escrow.withdrawDeposit(0);
    }

    function test_WithdrawDepositDoesNotRepeatAlreadyDisabledEvent() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(0, false);
        vm.recordLogs();
        vm.prank(depositor);
        escrow.withdrawDeposit(0);
        bytes32 topic = keccak256("DepositAcceptingIntentsUpdated(uint256,bool)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0) assertNotEq(logs[i].topics[0], topic);
        }
    }

    function test_WithdrawDepositRetainOnEmptyKeepsDepositOpen() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(20e6, IEscrowV2.Range({min: 10e6, max: 200e6}), 1e18, address(0), address(0));
        params.retainOnEmpty = true;
        _createAsDepositor(params);
        vm.prank(depositor);
        escrow.withdrawDeposit(1);
        assertEq(escrow.getDeposit(1).depositor, depositor);
        assertEq(escrow.getDeposit(1).remainingDeposits, 0);
    }

    function test_WithdrawDepositWithOutstandingIntentKeepsDepositOpen() public {
        _lock(address(orchestratorMock), 50e6);
        vm.prank(depositor);
        escrow.withdrawDeposit(0);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.depositor, depositor);
        assertEq(deposit.outstandingIntentAmount, 50e6);
    }

    function test_DisablingAcceptingIntentsBypassesMinimumLiquidityCheck() public {
        vm.startPrank(depositor);
        escrow.removeFunds(0, 495e6);
        escrow.setAcceptingIntents(0, false);
        vm.stopPrank();
        assertFalse(escrow.getDeposit(0).acceptingIntents);
    }

    function test_SetDelegateUpdatesStateAndEmits() public {
        vm.expectEmit(true, true, true, false, address(escrow));
        emit DepositDelegateSet(0, depositor, other);
        vm.prank(depositor);
        escrow.setDelegate(0, other);
        assertEq(escrow.getDeposit(0).delegate, other);
    }

    function test_SetDelegateRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.setDelegate(0, other);
    }

    function test_RemoveDelegateClearsStateAndEmits() public {
        vm.expectEmit(true, true, false, false, address(escrow));
        emit DepositDelegateRemoved(0, depositor);
        vm.prank(depositor);
        escrow.removeDelegate(0);
        assertEq(escrow.getDeposit(0).delegate, address(0));
    }

    function test_RemoveDelegateRejectsWhenNoneConfigured() public {
        vm.prank(depositor);
        escrow.removeDelegate(0);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DelegateNotFound.selector, 0));
        vm.prank(depositor);
        escrow.removeDelegate(0);
    }

    function test_SetIntentRangeUpdatesBothBounds() public {
        vm.prank(depositor);
        escrow.setIntentRange(0, IEscrowV2.Range({min: 20e6, max: 300e6}));
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(0);
        assertEq(deposit.intentAmountRange.min, 20e6);
        assertEq(deposit.intentAmountRange.max, 300e6);
    }

    function test_SetIntentRangeRejectsZeroMinimum() public {
        vm.expectRevert(IEscrowV2.ZeroMinValue.selector);
        vm.prank(depositor);
        escrow.setIntentRange(0, IEscrowV2.Range({min: 0, max: 100e6}));
    }

    function test_SetIntentRangeRejectsMinimumAboveMaximum() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRange.selector, 100e6, 50e6));
        vm.prank(depositor);
        escrow.setIntentRange(0, IEscrowV2.Range({min: 100e6, max: 50e6}));
    }

    function test_SetCurrencyMinimumRejectsUnlistedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, bytes32("JPY")));
        vm.prank(depositor);
        escrow.setCurrencyMinRate(0, VENMO, bytes32("JPY"), 1e18);
    }

    function _addPaypal(address caller) internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = PAYPAL;
        IEscrowV2.DepositPaymentMethodData[] memory data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] = _methodData();
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: EUR, minConversionRate: 0.9e18, oracleRateConfig: _emptyOracle()});
        vm.prank(caller);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddPaymentMethodsAddsWhitelistedMethod() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositPaymentMethodAdded(0, PAYPAL, PAYEE, address(0));
        _addPaypal(depositor);
        assertTrue(escrow.getDepositPaymentMethodListed(0, PAYPAL));
    }

    function test_AddPaymentMethodsRejectsUnwhitelistedMethod() public {
        bytes32 unknown = bytes32("unknown");
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = unknown;
        IEscrowV2.DepositPaymentMethodData[] memory data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] = _methodData();
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotWhitelisted.selector, unknown));
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_SetPaymentMethodActiveTogglesAndEmits() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit DepositPaymentMethodActiveUpdated(0, VENMO, false);
        vm.prank(depositor);
        escrow.setPaymentMethodActive(0, VENMO, false);
        assertFalse(escrow.getDepositPaymentMethodActive(0, VENMO));
    }

    function test_SetPaymentMethodActiveRejectsExistingState() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, 0, true));
        vm.prank(depositor);
        escrow.setPaymentMethodActive(0, VENMO, true);
    }

    function _currency(bytes32 code, uint256 rate, IEscrowV2.OracleRateConfig memory oracle)
        internal
        pure
        returns (IEscrowV2.Currency[] memory values)
    {
        values = new IEscrowV2.Currency[](1);
        values[0] = IEscrowV2.Currency({code: code, minConversionRate: rate, oracleRateConfig: oracle});
    }

    function test_AddCurrenciesAddsSupportedCurrency() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositCurrencyAdded(0, VENMO, EUR, 0.9e18);
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, _currency(EUR, 0.9e18, _emptyOracle()));
    }

    function test_AddCurrenciesRejectsUnsupportedCurrency() public {
        bytes32 unsupported = bytes32("JPY");
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, unsupported));
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, _currency(unsupported, 1e18, _emptyOracle()));
    }

    function test_AddCurrenciesRejectsExistingCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyAlreadyExists.selector, VENMO, USD));
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, _currency(USD, 1e18, _emptyOracle()));
    }

    function test_AddCurrenciesAllowsZeroFixedFloor() public {
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, _currency(EUR, 0, _emptyOracle()));
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, EUR), 0);
    }

    function test_AddCurrenciesStoresInlineOracleConfig() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.1e18, block.timestamp, 100);
        vm.prank(depositor);
        escrow.addCurrencies(0, VENMO, _currency(EUR, 0.9e18, config));
        IEscrowV2.OracleRateConfig memory stored = escrow.getDepositOracleRateConfig(0, VENMO, EUR);
        assertEq(stored.adapter, address(adapter));
        assertEq(stored.spreadBps, 100);
        assertEq(stored.maxStaleness, 3600);
    }

    function test_SetAcceptingIntentsUpdatesFlagAndEmits() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositAcceptingIntentsUpdated(0, false);
        vm.prank(depositor);
        escrow.setAcceptingIntents(0, false);
    }

    function test_SetAcceptingIntentsRejectsEnableBelowMinimumLiquidity() public {
        vm.startPrank(depositor);
        escrow.setAcceptingIntents(0, false);
        escrow.removeFunds(0, 495e6);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InsufficientDepositLiquidity.selector, 0, 5e6, 10e6));
        escrow.setAcceptingIntents(0, true);
        vm.stopPrank();
    }

    function test_SetRetainOnEmptyUpdatesFlagAndEmits() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit DepositRetainOnEmptyUpdated(0, true);
        vm.prank(depositor);
        escrow.setRetainOnEmpty(0, true);
        assertTrue(escrow.getDeposit(0).retainOnEmpty);
    }
}
