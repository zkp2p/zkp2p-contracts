// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {EscrowV2LegacyFixture} from "../helpers/EscrowV2LegacyFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";

contract EscrowV2BranchValidationParityTest is EscrowV2LegacyFixture {
    bytes32 internal constant JPY = bytes32("JPY");

    event DepositMinConversionRateUpdated(
        uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 newRate
    );

    function _paymentMethodInputs(bytes32 method, bytes32 methodPayee)
        internal
        pure
        returns (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        )
    {
        methods = new bytes32[](1);
        methods[0] = method;
        data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: methodPayee, data: ""});
        currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({code: USD, minConversionRate: 1e18, oracleRateConfig: _emptyOracle()});
    }

    function _assertNoOracleRemoval(Vm.Log[] memory logs) internal pure {
        bytes32 signature = keccak256("DepositOracleRateConfigRemoved(uint256,bytes32,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != signature, "unexpected oracle removal event");
        }
    }

    function test_AddPaymentMethodsRejectsZeroMethod() public {
        (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        ) = _paymentMethodInputs(bytes32(0), PAYEE);
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddPaymentMethodsRejectsEmptyPayeeDetails() public {
        (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        ) = _paymentMethodInputs(PAYPAL, bytes32(0));
        vm.expectRevert(IEscrowV2.EmptyPayeeDetails.selector);
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddPaymentMethodsRejectsExistingMethod() public {
        (
            bytes32[] memory methods,
            IEscrowV2.DepositPaymentMethodData[] memory data,
            IEscrowV2.Currency[][] memory currencies
        ) = _paymentMethodInputs(VENMO, PAYEE);
        currencies[0][0].code = EUR;
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodAlreadyExists.selector, 0, VENMO));
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, data, currencies);
    }

    function test_AddPaymentMethodsRejectsMethodDataLengthMismatch() public {
        (bytes32[] memory methods,, IEscrowV2.Currency[][] memory currencies) = _paymentMethodInputs(PAYPAL, PAYEE);
        IEscrowV2.DepositPaymentMethodData[] memory emptyData = new IEscrowV2.DepositPaymentMethodData[](0);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, emptyData, currencies);
    }

    function test_AddPaymentMethodsRejectsCurrencyArrayLengthMismatch() public {
        (bytes32[] memory methods, IEscrowV2.DepositPaymentMethodData[] memory data,) =
            _paymentMethodInputs(PAYPAL, PAYEE);
        IEscrowV2.Currency[][] memory emptyCurrencies = new IEscrowV2.Currency[][](0);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, 1, 0));
        vm.prank(depositor);
        escrow.addPaymentMethods(0, methods, data, emptyCurrencies);
    }

    function test_SetOracleRateConfigRejectsEoaAdapter() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(other, true, 1.2e18, block.timestamp, 100);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidOracleAdapter.selector, other));
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
    }

    function test_SetOracleRateConfigAcceptsSpreadAboveTenThousand() public {
        IEscrowV2.OracleRateConfig memory config =
            _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 10_001);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
        assertEq(escrow.getDepositOracleRateConfig(0, VENMO, USD).spreadBps, 10_001);
    }

    function test_SetOracleRateConfigRejectsNegativeTenThousandSpread() public {
        IEscrowV2.OracleRateConfig memory config =
            _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, -10_000);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidSpread.selector, int16(-10_000)));
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
    }

    function test_SetOracleRateConfigRejectsZeroMaxStaleness() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(adapter), true, 1.2e18, block.timestamp, 100);
        config.maxStaleness = 0;
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
    }

    function test_SetOracleRateConfigRejectsZeroAdapter() public {
        IEscrowV2.OracleRateConfig memory config = _oracleConfig(address(0), true, 1.2e18, block.timestamp, 100);
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.setOracleRateConfig(0, VENMO, USD, config);
    }

    function test_RemoveOracleRateConfigRejectsUnsupportedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        vm.prank(depositor);
        escrow.removeOracleRateConfig(0, VENMO, JPY);
    }

    function test_DeactivateCurrencyRejectsInactivePaymentMethod() public {
        vm.startPrank(depositor);
        escrow.setPaymentMethodActive(0, VENMO, false);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, 0, VENMO));
        escrow.deactivateCurrency(0, VENMO, USD);
        vm.stopPrank();
    }

    function test_DeactivateCurrencyRejectsUnlistedCurrency() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotFound.selector, VENMO, JPY));
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, JPY);
    }

    function test_DeactivateCurrencyWithoutOracleEmitsOnlyFloorUpdate() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositMinConversionRateUpdated(0, VENMO, USD, 0);
        vm.recordLogs();
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
        _assertNoOracleRemoval(vm.getRecordedLogs());
        assertEq(escrow.getDepositCurrencyMinRate(0, VENMO, USD), 0);
    }

    function test_DeactivateCurrencyWithoutOracleDoesNotEmitRemoval() public {
        vm.recordLogs();
        vm.prank(depositor);
        escrow.deactivateCurrency(0, VENMO, USD);
        _assertNoOracleRemoval(vm.getRecordedLogs());
    }

    function test_AddCurrenciesRejectsInactivePaymentMethod() public {
        IEscrowV2.Currency[] memory currencies = new IEscrowV2.Currency[](1);
        currencies[0] = IEscrowV2.Currency({code: EUR, minConversionRate: 0.9e18, oracleRateConfig: _emptyOracle()});
        vm.startPrank(depositor);
        escrow.setPaymentMethodActive(0, VENMO, false);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotActive.selector, 0, VENMO));
        escrow.addCurrencies(0, VENMO, currencies);
        vm.stopPrank();
    }

    function test_SetPaymentMethodActiveRejectsUnlistedMethod() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodNotListed.selector, 0, PAYPAL));
        vm.prank(depositor);
        escrow.setPaymentMethodActive(0, PAYPAL, false);
    }

    function test_SetRateManagerRejectsMissingDeposit() public {
        rateManagerMock.setManager(MANAGER_ID, true);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        vm.prank(depositor);
        escrow.setRateManager(999, address(rateManagerMock), MANAGER_ID);
    }

    function test_SetRateManagerRejectsZeroAddress() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.setRateManager(0, address(0), MANAGER_ID);
    }

    function test_SetRateManagerRejectsEoa() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.InvalidRateManager.selector, other));
        vm.prank(depositor);
        escrow.setRateManager(0, other, MANAGER_ID);
    }

    function test_SetRateManagerRejectsZeroManagerId() public {
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), bytes32(0));
    }

    function test_SetRateManagerPropagatesMissingManagerError() public {
        bytes32 missing = bytes32("nonexistent-manager");
        vm.expectRevert(abi.encodeWithSignature("RateManagerNotFound(bytes32)", missing));
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), missing);
    }

    function test_ClearRateManagerRejectsMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositNotFound.selector, 999));
        vm.prank(depositor);
        escrow.clearRateManager(999);
    }

    function test_ClearRateManagerRejectsUnsetManager() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.RateManagerNotSet.selector, 0));
        vm.prank(depositor);
        escrow.clearRateManager(0);
    }

    function test_SetDelegateRejectsZeroAddress() public {
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        vm.prank(depositor);
        escrow.setDelegate(0, address(0));
    }

    function test_SetDelegateRejectsDepositorSelfDelegation() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        vm.prank(depositor);
        escrow.setDelegate(0, depositor);
    }
}
