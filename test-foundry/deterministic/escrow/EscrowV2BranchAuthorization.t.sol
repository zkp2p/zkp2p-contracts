// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2BranchAuthorizationTest is EscrowV2LegacyFixture {
    event DepositClosed(uint256 depositId, address depositor);

    function _expectUnauthorizedManager() internal {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCallerOrDelegate.selector, other, depositor, delegate)
        );
        vm.prank(other);
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

    function test_CreateDepositRejectsZeroIntentMinimum() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 0, max: 100e6}), 1e18, delegate, intentGuardian);
        vm.expectRevert(IEscrowV2.ZeroMinValue.selector);
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_CreateDepositRejectsSelfDelegation() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, depositor, address(0));
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        vm.prank(depositor);
        escrow.createDeposit(params);
    }

    function test_DepositToRejectsZeroOwner() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, delegate, intentGuardian);
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(other);
        escrow.depositTo(address(0), params);
    }

    function test_DepositToRejectsOwnerAsDelegate() public {
        IEscrowV2.CreateDepositParams memory params =
            _createParams(50e6, IEscrowV2.Range({min: 10e6, max: 100e6}), 1e18, depositor, address(0));
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        vm.prank(other);
        escrow.depositTo(depositor, params);
    }

    function test_WithdrawDepositRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.withdrawDeposit(0);
    }

    function test_WithdrawDepositWithoutExpiredIntentsSkipsOrchestratorPrune() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit DepositClosed(0, depositor);
        vm.prank(depositor);
        escrow.withdrawDeposit(0);
        assertEq(orchestratorMock.getPruneCallCount(), 0);
    }

    function test_RemoveDelegateRejectsNonDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, depositor));
        vm.prank(other);
        escrow.removeDelegate(0);
    }

    function test_PruneExpiredIntentsWithoutExpiredEntriesSkipsOrchestrator() public {
        vm.prank(other);
        escrow.pruneExpiredIntents(0);
        assertEq(orchestratorMock.getPruneCallCount(), 0);
        assertEq(escrow.getDeposit(0).remainingDeposits, 500e6);
    }

    function test_UnlockFundsRejectsDirectNonOrchestratorCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        vm.prank(other);
        escrow.unlockFunds(0, keccak256("direct-unlock"));
    }

    function test_UnlockAndTransferRejectsDirectNonOrchestratorCaller() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEscrowV2.UnauthorizedCaller.selector, other, address(orchestratorRegistry))
        );
        vm.prank(other);
        escrow.unlockAndTransferFunds(0, keccak256("direct-transfer"), 20e6, other);
    }

    function test_SetOracleRateConfigBatchRejectsUnauthorizedCaller() public {
        IEscrowV2.OracleRateConfig[][] memory configs = new IEscrowV2.OracleRateConfig[][](1);
        configs[0] = new IEscrowV2.OracleRateConfig[](1);
        configs[0][0] = _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100);
        _expectUnauthorizedManager();
        escrow.setOracleRateConfigBatch(0, _singleMethod(), _singleCurrencyCodes(), configs);
    }

    function test_UpdateCurrencyConfigBatchRejectsUnauthorizedCaller() public {
        IEscrowV2.CurrencyRateUpdate[][] memory updates = new IEscrowV2.CurrencyRateUpdate[][](1);
        updates[0] = new IEscrowV2.CurrencyRateUpdate[](1);
        updates[0][0] = IEscrowV2.CurrencyRateUpdate({
            code: USD,
            minConversionRate: 1.1e18,
            updateOracle: true,
            oracleRateConfig: _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100)
        });
        _expectUnauthorizedManager();
        escrow.updateCurrencyConfigBatch(0, _singleMethod(), updates);
    }

    function test_RemoveOracleRateConfigRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.removeOracleRateConfig(0, VENMO, USD);
    }

    function test_SetIntentRangeRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.setIntentRange(0, IEscrowV2.Range({min: 5e6, max: 300e6}));
    }

    function test_AddPaymentMethodsRejectsUnauthorizedCaller() public {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = PAYPAL;
        IEscrowV2.DepositPaymentMethodData[] memory data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] = _methodData();
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
        _expectUnauthorizedManager();
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_SetPaymentMethodActiveRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.setPaymentMethodActive(0, VENMO, false);
    }

    function test_AddCurrenciesRejectsUnauthorizedCaller() public {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({code: EUR, minConversionRate: 0.9e18, oracleRateConfig: _emptyOracle()});
        _expectUnauthorizedManager();
        escrow.addCurrencies(0, VENMO, currencies);
    }

    function test_DeactivateCurrencyRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.deactivateCurrency(0, VENMO, USD);
    }

    function test_DeactivateCurrenciesBatchRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.deactivateCurrenciesBatch(0, _singleMethod(), _singleCurrencyCodes());
    }

    function test_SetAcceptingIntentsRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.setAcceptingIntents(0, false);
    }

    function test_SetRetainOnEmptyRejectsUnauthorizedCaller() public {
        _expectUnauthorizedManager();
        escrow.setRetainOnEmpty(0, true);
    }
}
