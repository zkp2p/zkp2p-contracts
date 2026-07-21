// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2BranchStatePauseParityTest is EscrowV2LegacyFixture {
    event DepositClosed(uint256 depositId, address depositor);

    function _expectPaused(address caller) internal {
        escrow.pauseEscrow();
        vm.expectRevert("Pausable: paused");
        vm.prank(caller);
    }

    function _secondaryDeposit(bool retain, address depositDelegate) internal returns (uint256 id) {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(20e6, IEscrowV2.Range({min: 10e6, max: 200e6}), 1e18, depositDelegate, intentGuardian);
        params.retainOnEmpty = retain;
        id = escrow.depositCounter();
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function _singleMethod() internal pure returns (bytes32[] memory methods) {
        methods = new bytes32[](1);
        methods[0] = VENMO;
    }

    function _singleCurrencyCodes() internal pure returns (bytes32[][] memory currencies) {
        currencies = new bytes32[][](1);
        currencies[0] = new bytes32[](1);
        currencies[0][0] = USD;
    }

    function _paymentMethodInputs()
        internal
        pure
        returns (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        )
    {
        methods = new bytes32[](1);
        methods[0] = PAYPAL;
        data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] = _methodData();
        currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
    }

    function _assertNoDustCollected(Vm.Log[] memory logs) internal pure {
        bytes32 signature = keccak256("DustCollected(uint256,uint256,address)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != signature, "unexpected dust event");
        }
    }

    function test_ZeroOracleMarketRateHaltsRate() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 0, block.timestamp, 100);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_ZeroOracleUpdatedAtHaltsRate() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.2e18, 0, 100);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_RetainOnEmptyPreservesDepositAfterFullSettlement() public {
        uint256 id = _secondaryDeposit(true, delegate);
        bytes32 intentHash = keccak256("retain-intent");
        orchestratorMock.lockFunds(id, intentHash, 20e6);
        orchestratorMock.unlockAndTransferFunds(id, intentHash, 20e6, other);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(id);
        assertEq(deposit.depositor, depositor);
        assertEq(deposit.remainingDeposits, 0);
        assertEq(deposit.outstandingIntentAmount, 0);
    }

    function test_ZeroRemainingClosesDepositWithoutDustEvent() public {
        uint256 id = _secondaryDeposit(false, delegate);
        bytes32 intentHash = keccak256("zero-remain");
        orchestratorMock.lockFunds(id, intentHash, 20e6);
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(id, depositor);
        vm.recordLogs();
        orchestratorMock.unlockAndTransferFunds(id, intentHash, 20e6, other);
        _assertNoDustCollected(vm.getRecordedLogs());
        assertEq(escrow.getDeposit(id).depositor, address(0));
    }

    function test_SetAcceptingIntentsRejectsAlreadyTrue() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, 0, true));
        vm.prank(depositor);
        escrow.setAcceptingIntents(0, true);
    }

    function test_SetAcceptingIntentsRejectsAlreadyFalse() public {
        vm.startPrank(depositor);
        escrow.setAcceptingIntents(0, false);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, 0, false));
        escrow.setAcceptingIntents(0, false);
        vm.stopPrank();
    }

    function test_SetRetainOnEmptyRejectsAlreadyFalse() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, 0, false));
        vm.prank(depositor);
        escrow.setRetainOnEmpty(0, false);
    }

    function test_SetRetainOnEmptyRejectsAlreadyTrue() public {
        vm.startPrank(depositor);
        escrow.setRetainOnEmpty(0, true);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, 0, true));
        escrow.setRetainOnEmpty(0, true);
        vm.stopPrank();
    }

    function test_RemoveFundsRejectsZeroAmount() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(depositor);
        escrow.removeFunds(0, 0);
    }

    function test_CreateDepositRejectsWhilePaused() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, delegate, intentGuardian);
        _expectPaused(depositor);
        escrow.createDeposit(params);
    }

    function test_DepositToRejectsWhilePaused() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, delegate, intentGuardian);
        _expectPaused(other);
        escrow.depositTo(depositor, params);
    }

    function test_AddFundsRejectsWhilePaused() public {
        _expectPaused(other);
        escrow.addFunds(0, 10e6);
    }

    function test_RemoveFundsRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.removeFunds(0, 10e6);
    }

    function test_SetCurrencyMinRateRejectsUnauthorizedCallerWithDelegateConfigured() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCallerOrDelegate.selector, other, depositor, delegate)
        );
        vm.prank(other);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.1e18);
    }

    function test_SetCurrencyMinRateRejectsUnauthorizedCallerWithNoDelegate() public {
        uint256 id = _secondaryDeposit(false, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCallerOrDelegate.selector, other, depositor, address(0))
        );
        vm.prank(other);
        escrow.setCurrencyMinRate(id, VENMO, USD, 1.1e18);
    }

    function test_SetCurrencyMinRateRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setCurrencyMinRate(0, VENMO, USD, 1.1e18);
    }

    function test_SetOracleRateConfigRejectsWhilePaused() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100);
        _expectPaused(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
    }

    function test_AddPaymentMethodsRejectsWhilePaused() public {
        (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        ) = _paymentMethodInputs();
        _expectPaused(depositor);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddCurrenciesRejectsWhilePaused() public {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({code: EUR, minConversionRate: 0.9e18, oracleRateConfig: _emptyOracle()});
        _expectPaused(depositor);
        escrow.addCurrencies(0, VENMO, currencies);
    }

    function test_SetPaymentMethodActiveRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setPaymentMethodActive(0, VENMO, false);
    }

    function test_SetAcceptingIntentsRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setAcceptingIntents(0, false);
    }

    function test_SetRetainOnEmptyRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setRetainOnEmpty(0, true);
    }

    function test_SetIntentRangeRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setIntentRange(0, IEscrowV2.Range({min: 5e6, max: 300e6}));
    }

    function test_SetDelegateRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setDelegate(0, other);
    }

    function test_RemoveDelegateRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.removeDelegate(0);
    }

    function test_RemoveOracleRateConfigRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.removeOracleRateConfig(0, VENMO, USD);
    }

    function test_DeactivateCurrencyRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
    }

    function test_SetRateManagerRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.setRateManager(0, address(rateManagerMock), MANAGER_ID);
    }

    function test_ClearRateManagerRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.clearRateManager(0);
    }

    function test_SetOracleRateConfigBatchRejectsWhilePaused() public {
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100);
        _expectPaused(depositor);
        escrow.setOracleRateConfigBatch(0, _singleMethod(), _singleCurrencyCodes(), configs);
    }

    function test_UpdateCurrencyConfigBatchRejectsWhilePaused() public {
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](1);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: USD,
            minConversionRate: 1.1e18,
            updateOracle: true,
            oracleRateConfig: _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100)
        });
        _expectPaused(depositor);
        escrow.updateCurrencyConfigBatch(0, _singleMethod(), updates);
    }

    function test_DeactivateCurrenciesBatchRejectsWhilePaused() public {
        _expectPaused(depositor);
        escrow.deactivateCurrenciesBatch(0, _singleMethod(), _singleCurrencyCodes());
    }

    function test_RemoveFundsRejectsWhenReentrancyGuardIsEntered() public {
        vm.store(address(escrow), bytes32(uint256(1)), bytes32(uint256(2)));
        vm.expectRevert("ReentrancyGuard: reentrant call");
        vm.prank(depositor);
        escrow.removeFunds(0, 10e6);
    }
}
