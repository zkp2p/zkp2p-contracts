// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract LegacyPaymentMethodDeploymentTest is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant REVOLUT = keccak256("revolut");
    bytes32 internal constant CASHAPP = keccak256("cashapp");
    bytes32 internal constant WISE = keccak256("wise");
    bytes32 internal constant MERCADOPAGO = keccak256("mercadopago");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant MONZO = keccak256("monzo");
    bytes32 internal constant N26 = keccak256("n26");
    bytes32 internal constant ALIPAY = keccak256("alipay");
    bytes32 internal constant CHIME = keccak256("chime");
    bytes32 internal constant LUXON = keccak256("luxon");

    PaymentVerifierRegistry internal registry;
    UnifiedPaymentVerifier internal verifier;

    function setUp() public {
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        NullifierRegistry nullifierRegistry = new NullifierRegistry();
        AttestationVerifierMock attestationVerifier = new AttestationVerifierMock();
        registry = new PaymentVerifierRegistry();
        verifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(nullifierRegistry)),
            IAttestationVerifier(address(attestationVerifier))
        );
        _register(VENMO, _singleCurrency("USD"));
        _register(REVOLUT, _revolutCurrencies());
        _register(CASHAPP, _singleCurrency("USD"));
        _register(WISE, _wiseCurrencies());
        _register(MERCADOPAGO, _singleCurrency("ARS"));
        _register(ZELLE, _singleCurrency("USD"));
        _register(PAYPAL, _paypalCurrencies());
        _register(MONZO, _singleCurrency("GBP"));
        _register(ALIPAY, _singleCurrency("CNY"));
        _register(CHIME, _singleCurrency("USD"));
        _register(N26, _singleCurrency("EUR"));
        _remove(N26);
        _register(LUXON, _luxonCurrencies());
        _remove(LUXON);
    }

    function _register(bytes32 method, bytes32[] memory currencies) internal {
        registry.addPaymentMethod(method, address(verifier), currencies);
        verifier.addPaymentMethod(method);
    }

    function _remove(bytes32 method) internal {
        registry.removePaymentMethod(method);
        verifier.removePaymentMethod(method);
    }

    function _singleCurrency(string memory currency) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = keccak256(bytes(currency));
    }

    function _paypalCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](7);
        currencies[0] = keccak256("USD");
        currencies[1] = keccak256("EUR");
        currencies[2] = keccak256("GBP");
        currencies[3] = keccak256("SGD");
        currencies[4] = keccak256("NZD");
        currencies[5] = keccak256("AUD");
        currencies[6] = keccak256("CAD");
    }

    function _luxonCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](3);
        currencies[0] = keccak256("USD");
        currencies[1] = keccak256("EUR");
        currencies[2] = keccak256("GBP");
    }

    function _revolutCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](24);
        string[24] memory codes = [
            "USD",
            "EUR",
            "GBP",
            "SGD",
            "NZD",
            "AUD",
            "CAD",
            "JPY",
            "HKD",
            "MXN",
            "SAR",
            "AED",
            "THB",
            "TRY",
            "PLN",
            "CHF",
            "ZAR",
            "CNY",
            "CZK",
            "DKK",
            "HUF",
            "NOK",
            "RON",
            "SEK"
        ];
        for (uint256 index; index < codes.length; index++) {
            currencies[index] = keccak256(bytes(codes[index]));
        }
    }

    function _wiseCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](31);
        string[31] memory codes = [
            "USD",
            "CNY",
            "EUR",
            "GBP",
            "AUD",
            "NZD",
            "CAD",
            "AED",
            "CHF",
            "ZAR",
            "SGD",
            "ILS",
            "HKD",
            "JPY",
            "PLN",
            "TRY",
            "IDR",
            "KES",
            "MYR",
            "MXN",
            "THB",
            "VND",
            "UGX",
            "CZK",
            "DKK",
            "HUF",
            "INR",
            "NOK",
            "PHP",
            "RON",
            "SEK"
        ];
        for (uint256 index; index < codes.length; index++) {
            currencies[index] = keccak256(bytes(codes[index]));
        }
    }

    function _contains(bytes32[] memory values, bytes32 expected) internal pure returns (bool) {
        for (uint256 index; index < values.length; index++) {
            if (values[index] == expected) return true;
        }
        return false;
    }

    function test_VenmoRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(VENMO));
    }

    function test_VenmoRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(VENMO), _singleCurrency("USD"));
    }

    function test_VenmoUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), VENMO));
    }

    function test_RevolutRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(REVOLUT));
    }

    function test_RevolutRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(REVOLUT), _revolutCurrencies());
    }

    function test_RevolutUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), REVOLUT));
    }

    function test_CashAppRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(CASHAPP));
    }

    function test_CashAppRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(CASHAPP), _singleCurrency("USD"));
    }

    function test_CashAppUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), CASHAPP));
    }

    function test_WiseRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(WISE));
    }

    function test_WiseRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(WISE), _wiseCurrencies());
    }

    function test_WiseUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), WISE));
    }

    function test_MercadoPagoRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(MERCADOPAGO));
    }

    function test_MercadoPagoRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(MERCADOPAGO), _singleCurrency("ARS"));
    }

    function test_MercadoPagoUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), MERCADOPAGO));
    }

    function test_ZelleUsesGenericPaymentMethodHash() public pure {
        assertEq(ZELLE, keccak256("zelle"));
    }

    function test_ZelleRegistryStoresGenericMethodAndCurrencies() public view {
        assertTrue(registry.isPaymentMethod(ZELLE));
        assertEq(registry.getCurrencies(ZELLE), _singleCurrency("USD"));
    }

    function test_ZelleUnifiedVerifierContainsGenericMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), ZELLE));
    }

    function test_PayPalRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(PAYPAL));
    }

    function test_PayPalRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(PAYPAL), _paypalCurrencies());
    }

    function test_PayPalRegistrySupportsSevenCurrencies() public view {
        assertEq(registry.getCurrencies(PAYPAL).length, 7);
    }

    function test_PayPalUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), PAYPAL));
    }

    function test_MonzoRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(MONZO));
    }

    function test_MonzoRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(MONZO), _singleCurrency("GBP"));
    }

    function test_MonzoRegistrySupportsOnlyGbp() public view {
        bytes32[] memory currencies = registry.getCurrencies(MONZO);
        assertEq(currencies.length, 1);
        assertEq(currencies[0], keccak256("GBP"));
    }

    function test_MonzoUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), MONZO));
    }

    function test_N26RegistryRemovesPaymentMethod() public view {
        assertFalse(registry.isPaymentMethod(N26));
    }

    function test_N26RegistryRemovesCurrencies() public view {
        assertEq(registry.getCurrencies(N26).length, 0);
    }

    function test_N26UnifiedVerifierRemovesPaymentMethod() public view {
        assertFalse(_contains(verifier.getPaymentMethods(), N26));
    }

    function test_AlipayRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(ALIPAY));
    }

    function test_AlipayRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(ALIPAY), _singleCurrency("CNY"));
    }

    function test_AlipayRegistrySupportsOnlyCny() public view {
        bytes32[] memory currencies = registry.getCurrencies(ALIPAY);
        assertEq(currencies.length, 1);
        assertEq(currencies[0], keccak256("CNY"));
    }

    function test_AlipayUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), ALIPAY));
    }

    function test_ChimeRegistryContainsPaymentMethod() public view {
        assertTrue(registry.isPaymentMethod(CHIME));
    }

    function test_ChimeRegistryStoresCurrencies() public view {
        assertEq(registry.getCurrencies(CHIME), _singleCurrency("USD"));
    }

    function test_ChimeRegistrySupportsOnlyUsd() public view {
        bytes32[] memory currencies = registry.getCurrencies(CHIME);
        assertEq(currencies.length, 1);
        assertEq(currencies[0], keccak256("USD"));
    }

    function test_ChimeUnifiedVerifierContainsPaymentMethod() public view {
        assertTrue(_contains(verifier.getPaymentMethods(), CHIME));
    }

    function test_LuxonRegistryRemovesPaymentMethod() public view {
        assertFalse(registry.isPaymentMethod(LUXON));
    }

    function test_LuxonRegistryRemovesCurrencies() public view {
        assertEq(registry.getCurrencies(LUXON).length, 0);
    }

    function test_LuxonUnifiedVerifierRemovesPaymentMethod() public view {
        assertFalse(_contains(verifier.getPaymentMethods(), LUXON));
    }
}
