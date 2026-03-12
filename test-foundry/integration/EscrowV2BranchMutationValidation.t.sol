// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { EscrowV2LegacyCoverageBase } from "./EscrowV2LegacyCoverageBase.sol";

contract EscrowV2BranchMutationValidationTest is EscrowV2LegacyCoverageBase {
    function setUp() public {
        _setUpLegacyFixture();
    }

    function test_addPaymentMethodsRevertsWhenPaymentMethodIsZero() public {
        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = bytes32(0);

        vm.prank(depositor);
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.addPaymentMethods(
            depositId,
            paymentMethods,
            _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            _currenciesByMethod(_currencyList(USD, 1e18))
        );
    }

    function test_addPaymentMethodsRevertsWhenPayeeDetailsIsZero() public {
        vm.prank(depositor);
        vm.expectRevert(IEscrowV2.EmptyPayeeDetails.selector);
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(PAYPAL),
            _singlePaymentMethodData(address(0), bytes32(0), ""),
            _currenciesByMethod(_currencyList(USD, 1e18))
        );
    }

    function test_addPaymentMethodsRevertsWhenPaymentMethodAlreadyExists() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.PaymentMethodAlreadyExists.selector, depositId, VENMO));
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(VENMO),
            _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            _currenciesByMethod(_currencyList(EUR, 0.9e18))
        );
    }

    function test_addPaymentMethodsRevertsWhenPaymentMethodDataLengthMismatch() public {
        IEscrowV2.DepositPaymentMethodData[] memory paymentMethodData = new IEscrowV2.DepositPaymentMethodData[](0);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(PAYPAL),
            paymentMethodData,
            _currenciesByMethod(_currencyList(USD, 1e18))
        );
    }

    function test_addPaymentMethodsRevertsWhenCurrenciesLengthMismatch() public {
        IEscrowV2.Currency[][] memory emptyCurrencies = new IEscrowV2.Currency[][](0);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.ArrayLengthMismatch.selector, uint256(1), uint256(0)));
        escrow.addPaymentMethods(
            depositId,
            _singlePaymentMethods(PAYPAL),
            _singlePaymentMethodData(address(0), PAYEE_DETAILS, ""),
            emptyCurrencies
        );
    }

    function test_removeOracleRateConfigRevertsWhenCurrencyIsNotListed() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CurrencyNotSupported.selector, VENMO, JPY));
        escrow.removeOracleRateConfig(depositId, VENMO, JPY);
    }

    function test_setDelegateRevertsWhenDelegateIsZeroAddress() public {
        vm.prank(depositor);
        vm.expectRevert(IEscrowV2.ZeroAddress.selector);
        escrow.setDelegate(depositId, address(0));
    }

    function test_setDelegateRevertsWhenDelegateIsDepositor() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.CannotDelegateToSelf.selector, depositor));
        escrow.setDelegate(depositId, depositor);
    }

    function test_setAcceptingIntentsRevertsWhenAlreadyTrue() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, depositId, true));
        escrow.setAcceptingIntents(depositId, true);
    }

    function test_setAcceptingIntentsRevertsWhenAlreadyFalse() public {
        vm.prank(depositor);
        escrow.setAcceptingIntents(depositId, false);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, depositId, false));
        escrow.setAcceptingIntents(depositId, false);
    }

    function test_setRetainOnEmptyRevertsWhenAlreadyFalse() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, depositId, false));
        escrow.setRetainOnEmpty(depositId, false);
    }

    function test_setRetainOnEmptyRevertsWhenAlreadyTrue() public {
        vm.prank(depositor);
        escrow.setRetainOnEmpty(depositId, true);

        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IEscrowV2.DepositAlreadyInState.selector, depositId, true));
        escrow.setRetainOnEmpty(depositId, true);
    }

    function test_removeFundsRevertsWhenAmountIsZero() public {
        vm.prank(depositor);
        vm.expectRevert(IEscrowV2.ZeroValue.selector);
        escrow.removeFunds(depositId, 0);
    }

    function _currenciesByMethod(
        IEscrowV2.Currency[] memory currencies
    ) internal pure returns (IEscrowV2.Currency[][] memory currenciesByMethod) {
        currenciesByMethod = new IEscrowV2.Currency[][](1);
        currenciesByMethod[0] = currencies;
    }
}
