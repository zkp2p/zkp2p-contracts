// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";

contract PaymentVerifierRegistryTest is Test {
    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event CurrencyAdded(bytes32 indexed paymentMethod, bytes32 indexed currencyCode);
    event CurrencyRemoved(bytes32 indexed paymentMethod, bytes32 indexed currencyCode);

    PaymentVerifierRegistry internal registry;

    address internal owner;
    address internal attacker;
    address internal verifier1;
    address internal verifier2;
    address internal verifier3;

    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant WISE = keccak256("wise");

    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant GBP = keccak256("GBP");
    bytes32 internal constant JPY = keccak256("JPY");
    bytes32 internal constant CAD = keccak256("CAD");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant CASHAPP = keccak256("cashapp");
    bytes32 internal constant REVOLUT = keccak256("revolut");
    bytes32 internal constant STRIPE = keccak256("stripe");

    function setUp() public {
        owner = makeAddr("owner");
        attacker = makeAddr("attacker");
        verifier1 = makeAddr("verifier1");
        verifier2 = makeAddr("verifier2");
        verifier3 = makeAddr("verifier3");

        vm.prank(owner);
        registry = new PaymentVerifierRegistry();
    }

    function test_constructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_constructorStartsWithEmptyPaymentMethods() public view {
        assertEq(registry.getPaymentMethods().length, 0);
    }

    function test_addPaymentMethodStoresMethodVerifierAndCurrencies() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));

        assertTrue(registry.isPaymentMethod(VENMO));
        assertEq(registry.getVerifier(VENMO), verifier1);
        assertTrue(registry.isCurrency(VENMO, USD));
        assertTrue(registry.isCurrency(VENMO, EUR));
        _assertBytes32ArrayEq(registry.getCurrencies(VENMO), _currencies(USD, EUR));
        _assertContains(registry.getPaymentMethods(), VENMO);
        assertEq(registry.getPaymentMethods().length, 1);
    }

    function test_addPaymentMethodEmitsCurrencyAndPaymentMethodEvents() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyAdded(VENMO, USD);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyAdded(VENMO, EUR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit PaymentMethodAdded(VENMO);

        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
    }

    function test_addPaymentMethodRevertsWhenMethodAlreadyExists() public {
        vm.startPrank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
        vm.expectRevert("Payment method already exists");
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
        vm.stopPrank();
    }

    function test_addPaymentMethodRevertsWhenVerifierIsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert("Invalid verifier");
        registry.addPaymentMethod(VENMO, address(0), _currencies(USD, EUR));
    }

    function test_addPaymentMethodRevertsWhenCurrenciesAreEmpty() public {
        vm.prank(owner);
        vm.expectRevert("Invalid currencies length");
        registry.addPaymentMethod(VENMO, verifier1, new bytes32[](0));
    }

    function test_addPaymentMethodRevertsWhenCurrencyCodeIsZero() public {
        vm.prank(owner);
        vm.expectRevert("Invalid currency code");
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, bytes32(0), EUR));
    }

    function test_addPaymentMethodRevertsWhenCurrenciesDuplicate() public {
        vm.prank(owner);
        vm.expectRevert("Currency already exists");
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR, USD));
    }

    function test_addPaymentMethodRevertsWhenCallerIsNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
    }

    function test_removePaymentMethodClearsStateAndEmitsEvents() public {
        _seedPaymentMethods();

        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyRemoved(VENMO, USD);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyRemoved(VENMO, EUR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit PaymentMethodRemoved(VENMO);

        vm.prank(owner);
        registry.removePaymentMethod(VENMO);

        assertFalse(registry.isPaymentMethod(VENMO));
        assertEq(registry.getVerifier(VENMO), address(0));
        assertFalse(registry.isCurrency(VENMO, USD));
        assertFalse(registry.isCurrency(VENMO, EUR));
        _assertContains(registry.getPaymentMethods(), PAYPAL);
        _assertNotContains(registry.getPaymentMethods(), VENMO);
        assertEq(registry.getPaymentMethods().length, 1);
    }

    function test_removePaymentMethodRevertsWhenMethodMissing() public {
        _seedPaymentMethods();

        vm.prank(owner);
        vm.expectRevert("Payment method does not exist");
        registry.removePaymentMethod(WISE);
    }

    function test_removePaymentMethodRevertsWhenCallerIsNotOwner() public {
        _seedPaymentMethods();

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removePaymentMethod(VENMO);
    }

    function test_addCurrenciesSupportsMultipleAndSingleCurrencyAdds() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD));

        vm.prank(owner);
        registry.addCurrencies(VENMO, _currencies(EUR, GBP));
        _assertContains(registry.getCurrencies(VENMO), USD);
        _assertContains(registry.getCurrencies(VENMO), EUR);
        _assertContains(registry.getCurrencies(VENMO), GBP);
        assertEq(registry.getCurrencies(VENMO).length, 3);

        vm.prank(owner);
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(EUR));
        vm.prank(owner);
        registry.addCurrencies(PAYPAL, _currencies(GBP));
        _assertContains(registry.getCurrencies(PAYPAL), EUR);
        _assertContains(registry.getCurrencies(PAYPAL), GBP);
        assertEq(registry.getCurrencies(PAYPAL).length, 2);
    }

    function test_addCurrenciesEmitsEventPerCurrency() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD));

        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyAdded(VENMO, EUR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyAdded(VENMO, GBP);

        vm.prank(owner);
        registry.addCurrencies(VENMO, _currencies(EUR, GBP));
    }

    function test_addCurrenciesRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD));

        vm.prank(owner);
        vm.expectRevert("Invalid currencies length");
        registry.addCurrencies(VENMO, new bytes32[](0));

        vm.prank(owner);
        vm.expectRevert("Payment method does not exist");
        registry.addCurrencies(PAYPAL, _currencies(EUR));

        vm.prank(owner);
        vm.expectRevert("Invalid currency code");
        registry.addCurrencies(VENMO, _currencies(EUR, bytes32(0), GBP));

        vm.prank(owner);
        vm.expectRevert("Currency already exists");
        registry.addCurrencies(VENMO, _currencies(EUR, USD, GBP));

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addCurrencies(VENMO, _currencies(EUR));
    }

    function test_removeCurrenciesSupportsMultipleAndSingleCurrencyRemovals() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR, GBP, JPY));

        vm.prank(owner);
        registry.removeCurrencies(VENMO, _currencies(USD, GBP));
        assertFalse(registry.isCurrency(VENMO, USD));
        assertFalse(registry.isCurrency(VENMO, GBP));
        assertTrue(registry.isCurrency(VENMO, EUR));
        assertTrue(registry.isCurrency(VENMO, JPY));
        _assertContains(registry.getCurrencies(VENMO), EUR);
        _assertContains(registry.getCurrencies(VENMO), JPY);
        assertEq(registry.getCurrencies(VENMO).length, 2);

        vm.prank(owner);
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(USD, EUR, GBP, JPY));
        vm.prank(owner);
        registry.removeCurrencies(PAYPAL, _currencies(USD));
        _assertContains(registry.getCurrencies(PAYPAL), EUR);
        _assertContains(registry.getCurrencies(PAYPAL), GBP);
        _assertContains(registry.getCurrencies(PAYPAL), JPY);
        assertEq(registry.getCurrencies(PAYPAL).length, 3);
    }

    function test_removeCurrenciesEmitsEventPerCurrency() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR, GBP, JPY));

        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyRemoved(VENMO, USD);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CurrencyRemoved(VENMO, GBP);

        vm.prank(owner);
        registry.removeCurrencies(VENMO, _currencies(USD, GBP));
    }

    function test_removeCurrenciesRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR, GBP, JPY));

        vm.prank(owner);
        vm.expectRevert("Invalid currencies length");
        registry.removeCurrencies(VENMO, new bytes32[](0));

        vm.prank(owner);
        vm.expectRevert("Currency does not exist");
        registry.removeCurrencies(VENMO, _currencies(USD, CAD, EUR));

        vm.prank(owner);
        vm.expectRevert("Currency does not exist");
        registry.removeCurrencies(PAYPAL, _currencies(USD));

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removeCurrencies(VENMO, _currencies(USD));
    }

    function test_viewFunctionsReturnExpectedDataAcrossMethods() public {
        vm.startPrank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(GBP));
        registry.addPaymentMethod(WISE, verifier3, _currencies(EUR, GBP, JPY));
        vm.stopPrank();

        assertTrue(registry.isPaymentMethod(VENMO));
        assertTrue(registry.isPaymentMethod(PAYPAL));
        assertTrue(registry.isPaymentMethod(WISE));
        assertFalse(registry.isPaymentMethod(ZELLE));

        _assertContains(registry.getPaymentMethods(), VENMO);
        _assertContains(registry.getPaymentMethods(), PAYPAL);
        _assertContains(registry.getPaymentMethods(), WISE);
        assertEq(registry.getPaymentMethods().length, 3);

        assertEq(registry.getVerifier(VENMO), verifier1);
        assertEq(registry.getVerifier(PAYPAL), verifier2);
        assertEq(registry.getVerifier(WISE), verifier3);
        assertEq(registry.getVerifier(CASHAPP), address(0));

        assertTrue(registry.isCurrency(VENMO, USD));
        assertTrue(registry.isCurrency(VENMO, EUR));
        assertTrue(registry.isCurrency(PAYPAL, GBP));
        assertTrue(registry.isCurrency(WISE, JPY));
        assertFalse(registry.isCurrency(VENMO, GBP));
        assertFalse(registry.isCurrency(VENMO, JPY));
        assertFalse(registry.isCurrency(PAYPAL, USD));
        assertFalse(registry.isCurrency(WISE, USD));
        assertFalse(registry.isCurrency(REVOLUT, USD));

        _assertBytes32ArrayEq(registry.getCurrencies(VENMO), _currencies(USD, EUR));
        _assertBytes32ArrayEq(registry.getCurrencies(PAYPAL), _currencies(GBP));
        _assertBytes32ArrayEq(registry.getCurrencies(WISE), _currencies(EUR, GBP, JPY));
        assertEq(registry.getCurrencies(STRIPE).length, 0);
    }

    function test_complexStateTransitionsMaintainIndependentMethodState() public {
        vm.startPrank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD));
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(EUR, GBP));
        registry.addPaymentMethod(WISE, verifier3, _currencies(JPY));
        vm.stopPrank();

        assertEq(registry.getPaymentMethods().length, 3);

        vm.prank(owner);
        registry.removePaymentMethod(PAYPAL);

        assertEq(registry.getPaymentMethods().length, 2);
        _assertContains(registry.getPaymentMethods(), VENMO);
        _assertContains(registry.getPaymentMethods(), WISE);
        _assertNotContains(registry.getPaymentMethods(), PAYPAL);
        assertFalse(registry.isPaymentMethod(PAYPAL));
        assertFalse(registry.isCurrency(PAYPAL, EUR));
        assertFalse(registry.isCurrency(PAYPAL, GBP));

        vm.prank(owner);
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(EUR));
        vm.prank(owner);
        registry.addCurrencies(VENMO, _currencies(EUR, GBP));
        vm.prank(owner);
        registry.addCurrencies(PAYPAL, _currencies(GBP, JPY));
        vm.prank(owner);
        registry.removeCurrencies(VENMO, _currencies(EUR));

        _assertBytes32ArrayEq(registry.getCurrencies(VENMO), _currencies(USD, GBP));
        _assertBytes32ArrayEq(registry.getCurrencies(PAYPAL), _currencies(EUR, GBP, JPY));
    }

    function _seedPaymentMethods() internal {
        vm.startPrank(owner);
        registry.addPaymentMethod(VENMO, verifier1, _currencies(USD, EUR));
        registry.addPaymentMethod(PAYPAL, verifier2, _currencies(GBP));
        vm.stopPrank();
    }

    function _currencies(bytes32 currencyA) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = currencyA;
    }

    function _currencies(bytes32 currencyA, bytes32 currencyB) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](2);
        currencies[0] = currencyA;
        currencies[1] = currencyB;
    }

    function _currencies(bytes32 currencyA, bytes32 currencyB, bytes32 currencyC)
        internal
        pure
        returns (bytes32[] memory currencies)
    {
        currencies = new bytes32[](3);
        currencies[0] = currencyA;
        currencies[1] = currencyB;
        currencies[2] = currencyC;
    }

    function _currencies(bytes32 currencyA, bytes32 currencyB, bytes32 currencyC, bytes32 currencyD)
        internal
        pure
        returns (bytes32[] memory currencies)
    {
        currencies = new bytes32[](4);
        currencies[0] = currencyA;
        currencies[1] = currencyB;
        currencies[2] = currencyC;
        currencies[3] = currencyD;
    }

    function _assertContains(bytes32[] memory values, bytes32 needle) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == needle) {
                return;
            }
        }

        revert("missing expected value");
    }

    function _assertNotContains(bytes32[] memory values, bytes32 needle) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == needle) {
                revert("unexpected value present");
            }
        }
    }

    function _assertBytes32ArrayEq(bytes32[] memory actual, bytes32[] memory expected) internal {
        assertEq(actual.length, expected.length, "array length mismatch");
        for (uint256 index = 0; index < expected.length; index++) {
            assertEq(actual[index], expected[index], "array item mismatch");
        }
    }
}
