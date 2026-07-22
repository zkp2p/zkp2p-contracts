// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract V2PaymentMethodDeploymentTest is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant REVOLUT = keccak256("revolut");
    bytes32 internal constant CASHAPP = keccak256("cashapp");
    bytes32 internal constant WISE = keccak256("wise");
    bytes32 internal constant MERCADOPAGO = keccak256("mercadopago");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant MONZO = keccak256("monzo");
    bytes32 internal constant ALIPAY = keccak256("alipay");
    bytes32 internal constant CHIME = keccak256("chime");
    bytes32 internal constant N26 = keccak256("n26");
    bytes32 internal constant LUXON = keccak256("luxon");
    PaymentVerifierRegistry internal registry;
    UnifiedPaymentVerifier internal v2Verifier;
    UnifiedPaymentVerifier internal legacyVerifier;
    UnifiedPaymentVerifierV3 internal activeVerifier;
    mapping(bytes32 => bytes32[]) internal expectedCurrencies;

    function setUp() public {
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        NullifierRegistry legacyNullifierRegistry = new NullifierRegistry();
        NullifierRegistryV2 nullifierRegistryV2 =
            new NullifierRegistryV2(INullifierRegistry(address(legacyNullifierRegistry)));
        AttestationVerifierMock attestationVerifier = new AttestationVerifierMock();
        registry = new PaymentVerifierRegistry();
        v2Verifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(legacyNullifierRegistry)),
            IAttestationVerifier(address(attestationVerifier))
        );
        legacyVerifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(legacyNullifierRegistry)),
            IAttestationVerifier(address(attestationVerifier))
        );
        activeVerifier = new UnifiedPaymentVerifierV3(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistryV2(address(nullifierRegistryV2)),
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
        _registerAndRemove(N26, _singleCurrency("EUR"));
        _registerAndRemove(LUXON, _paypalCurrencies());
    }

    function _register(bytes32 method, bytes32[] memory currencies) internal {
        registry.addPaymentMethod(method, address(activeVerifier), currencies);
        v2Verifier.addPaymentMethod(method);
        for (uint256 index; index < currencies.length; index++) {
            expectedCurrencies[method].push(currencies[index]);
        }
    }

    function _registerAndRemove(bytes32 method, bytes32[] memory currencies) internal {
        registry.addPaymentMethod(method, address(activeVerifier), currencies);
        legacyVerifier.addPaymentMethod(method);
        v2Verifier.addPaymentMethod(method);
        registry.removePaymentMethod(method);
        legacyVerifier.removePaymentMethod(method);
        v2Verifier.removePaymentMethod(method);
    }

    function _singleCurrency(string memory currency) internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = keccak256(bytes(currency));
    }

    function _paypalCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](7);
        string[7] memory codes = ["USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD"];
        for (uint256 index; index < codes.length; index++) {
            currencies[index] = keccak256(bytes(codes[index]));
        }
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

    function test_VenmoIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(VENMO));
    }

    function test_VenmoPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(VENMO), address(activeVerifier));
    }

    function test_VenmoHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(VENMO), expectedCurrencies[VENMO]);
    }

    function test_VenmoIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), VENMO));
    }

    function test_RevolutIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(REVOLUT));
    }

    function test_RevolutPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(REVOLUT), address(activeVerifier));
    }

    function test_RevolutHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(REVOLUT), expectedCurrencies[REVOLUT]);
    }

    function test_RevolutIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), REVOLUT));
    }

    function test_CashAppIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(CASHAPP));
    }

    function test_CashAppPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(CASHAPP), address(activeVerifier));
    }

    function test_CashAppHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(CASHAPP), expectedCurrencies[CASHAPP]);
    }

    function test_CashAppIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), CASHAPP));
    }

    function test_WiseIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(WISE));
    }

    function test_WisePointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(WISE), address(activeVerifier));
    }

    function test_WiseHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(WISE), expectedCurrencies[WISE]);
    }

    function test_WiseIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), WISE));
    }

    function test_MercadoPagoIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(MERCADOPAGO));
    }

    function test_MercadoPagoPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(MERCADOPAGO), address(activeVerifier));
    }

    function test_MercadoPagoHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(MERCADOPAGO), expectedCurrencies[MERCADOPAGO]);
    }

    function test_MercadoPagoIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), MERCADOPAGO));
    }

    function test_ZelleIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(ZELLE));
    }

    function test_ZellePointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(ZELLE), address(activeVerifier));
    }

    function test_ZelleHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(ZELLE), expectedCurrencies[ZELLE]);
    }

    function test_ZelleIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), ZELLE));
    }

    function test_PayPalIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(PAYPAL));
    }

    function test_PayPalPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(PAYPAL), address(activeVerifier));
    }

    function test_PayPalHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(PAYPAL), expectedCurrencies[PAYPAL]);
    }

    function test_PayPalIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), PAYPAL));
    }

    function test_MonzoIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(MONZO));
    }

    function test_MonzoPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(MONZO), address(activeVerifier));
    }

    function test_MonzoHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(MONZO), expectedCurrencies[MONZO]);
    }

    function test_MonzoIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), MONZO));
    }

    function test_AlipayIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(ALIPAY));
    }

    function test_AlipayPointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(ALIPAY), address(activeVerifier));
    }

    function test_AlipayHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(ALIPAY), expectedCurrencies[ALIPAY]);
    }

    function test_AlipayIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), ALIPAY));
    }

    function test_ChimeIsRegisteredInPaymentVerifierRegistry() public view {
        assertTrue(registry.isPaymentMethod(CHIME));
    }

    function test_ChimePointsToActiveV3Verifier() public view {
        assertEq(registry.getVerifier(CHIME), address(activeVerifier));
    }

    function test_ChimeHasCorrectCurrencies() public view {
        assertEq(registry.getCurrencies(CHIME), expectedCurrencies[CHIME]);
    }

    function test_ChimeIsRegisteredInV2UnifiedVerifier() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), CHIME));
    }

    function test_GenericZelleUsesCanonicalKeccakHash() public pure {
        assertEq(ZELLE, 0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3);
    }

    function test_GenericZelleRegistryRoutesActiveV3WithUsd() public view {
        assertTrue(registry.isPaymentMethod(ZELLE));
        assertEq(registry.getVerifier(ZELLE), address(activeVerifier));
        assertEq(registry.getCurrencies(ZELLE), _singleCurrency("USD"));
    }

    function test_GenericZelleRemainsInUnifiedPaymentVerifierV2() public view {
        assertTrue(_contains(v2Verifier.getPaymentMethods(), ZELLE));
    }

    function test_N26IsRemovedFromEveryPaymentMethodSurface() public view {
        assertFalse(registry.isPaymentMethod(N26));
        assertFalse(_contains(legacyVerifier.getPaymentMethods(), N26));
        assertFalse(_contains(v2Verifier.getPaymentMethods(), N26));
    }

    function test_LuxonIsRemovedFromEveryPaymentMethodSurface() public view {
        assertFalse(registry.isPaymentMethod(LUXON));
        assertFalse(_contains(legacyVerifier.getPaymentMethods(), LUXON));
        assertFalse(_contains(v2Verifier.getPaymentMethods(), LUXON));
    }
}
