// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

abstract contract V2PaymentMethodConfigBuilder {
    struct PaymentMethodConfig {
        bytes32 paymentMethodHash;
        bytes32[] currencies;
    }

    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant GBP = keccak256("GBP");
    bytes32 internal constant SGD = keccak256("SGD");
    bytes32 internal constant NZD = keccak256("NZD");
    bytes32 internal constant AUD = keccak256("AUD");
    bytes32 internal constant CAD = keccak256("CAD");
    bytes32 internal constant JPY = keccak256("JPY");
    bytes32 internal constant HKD = keccak256("HKD");
    bytes32 internal constant MXN = keccak256("MXN");
    bytes32 internal constant SAR = keccak256("SAR");
    bytes32 internal constant AED = keccak256("AED");
    bytes32 internal constant THB = keccak256("THB");
    bytes32 internal constant TRY = keccak256("TRY");
    bytes32 internal constant PLN = keccak256("PLN");
    bytes32 internal constant CHF = keccak256("CHF");
    bytes32 internal constant ZAR = keccak256("ZAR");
    bytes32 internal constant CNY = keccak256("CNY");
    bytes32 internal constant CZK = keccak256("CZK");
    bytes32 internal constant DKK = keccak256("DKK");
    bytes32 internal constant HUF = keccak256("HUF");
    bytes32 internal constant NOK = keccak256("NOK");
    bytes32 internal constant RON = keccak256("RON");
    bytes32 internal constant SEK = keccak256("SEK");
    bytes32 internal constant ARS = keccak256("ARS");
    bytes32 internal constant ILS = keccak256("ILS");
    bytes32 internal constant IDR = keccak256("IDR");
    bytes32 internal constant KES = keccak256("KES");
    bytes32 internal constant MYR = keccak256("MYR");
    bytes32 internal constant VND = keccak256("VND");
    bytes32 internal constant UGX = keccak256("UGX");
    bytes32 internal constant INR = keccak256("INR");
    bytes32 internal constant PHP = keccak256("PHP");

    function _paymentMethodConfigs(bool includeLuxon) internal pure returns (PaymentMethodConfig[] memory configs) {
        configs = new PaymentMethodConfig[](includeLuxon ? 14 : 13);

        configs[0] = PaymentMethodConfig({ paymentMethodHash: keccak256("venmo"), currencies: _venmoCurrencies() });
        configs[1] = PaymentMethodConfig({ paymentMethodHash: keccak256("revolut"), currencies: _revolutCurrencies() });
        configs[2] = PaymentMethodConfig({ paymentMethodHash: keccak256("cashapp"), currencies: _cashAppCurrencies() });
        configs[3] = PaymentMethodConfig({ paymentMethodHash: keccak256("wise"), currencies: _wiseCurrencies() });
        configs[4] = PaymentMethodConfig({
            paymentMethodHash: keccak256("mercadopago"),
            currencies: _mercadoPagoCurrencies()
        });
        configs[5] = PaymentMethodConfig({ paymentMethodHash: keccak256("zelle-citi"), currencies: _zelleCurrencies() });
        configs[6] = PaymentMethodConfig({ paymentMethodHash: keccak256("zelle-chase"), currencies: _zelleCurrencies() });
        configs[7] = PaymentMethodConfig({ paymentMethodHash: keccak256("zelle-bofa"), currencies: _zelleCurrencies() });
        configs[8] = PaymentMethodConfig({ paymentMethodHash: keccak256("paypal"), currencies: _paypalCurrencies() });
        configs[9] = PaymentMethodConfig({ paymentMethodHash: keccak256("monzo"), currencies: _monzoCurrencies() });
        configs[10] = PaymentMethodConfig({ paymentMethodHash: keccak256("n26"), currencies: _n26Currencies() });
        configs[11] = PaymentMethodConfig({ paymentMethodHash: keccak256("alipay"), currencies: _alipayCurrencies() });
        configs[12] = PaymentMethodConfig({ paymentMethodHash: keccak256("chime"), currencies: _chimeCurrencies() });

        if (includeLuxon) {
            configs[13] = PaymentMethodConfig({ paymentMethodHash: keccak256("luxon"), currencies: _luxonCurrencies() });
        }
    }

    function _venmoCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = USD;
    }

    function _cashAppCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = USD;
    }

    function _mercadoPagoCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = ARS;
    }

    function _zelleCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = USD;
    }

    function _monzoCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = GBP;
    }

    function _n26Currencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = EUR;
    }

    function _alipayCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = CNY;
    }

    function _chimeCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = USD;
    }

    function _paypalCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](7);
        currencies[0] = USD;
        currencies[1] = EUR;
        currencies[2] = GBP;
        currencies[3] = SGD;
        currencies[4] = NZD;
        currencies[5] = AUD;
        currencies[6] = CAD;
    }

    function _revolutCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](24);
        currencies[0] = USD;
        currencies[1] = EUR;
        currencies[2] = GBP;
        currencies[3] = SGD;
        currencies[4] = NZD;
        currencies[5] = AUD;
        currencies[6] = CAD;
        currencies[7] = JPY;
        currencies[8] = HKD;
        currencies[9] = MXN;
        currencies[10] = SAR;
        currencies[11] = AED;
        currencies[12] = THB;
        currencies[13] = TRY;
        currencies[14] = PLN;
        currencies[15] = CHF;
        currencies[16] = ZAR;
        currencies[17] = CNY;
        currencies[18] = CZK;
        currencies[19] = DKK;
        currencies[20] = HUF;
        currencies[21] = NOK;
        currencies[22] = RON;
        currencies[23] = SEK;
    }

    function _wiseCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](31);
        currencies[0] = USD;
        currencies[1] = CNY;
        currencies[2] = EUR;
        currencies[3] = GBP;
        currencies[4] = AUD;
        currencies[5] = NZD;
        currencies[6] = CAD;
        currencies[7] = AED;
        currencies[8] = CHF;
        currencies[9] = ZAR;
        currencies[10] = SGD;
        currencies[11] = ILS;
        currencies[12] = HKD;
        currencies[13] = JPY;
        currencies[14] = PLN;
        currencies[15] = TRY;
        currencies[16] = IDR;
        currencies[17] = KES;
        currencies[18] = MYR;
        currencies[19] = MXN;
        currencies[20] = THB;
        currencies[21] = VND;
        currencies[22] = UGX;
        currencies[23] = CZK;
        currencies[24] = DKK;
        currencies[25] = HUF;
        currencies[26] = INR;
        currencies[27] = NOK;
        currencies[28] = PHP;
        currencies[29] = RON;
        currencies[30] = SEK;
    }

    function _luxonCurrencies() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](3);
        currencies[0] = USD;
        currencies[1] = EUR;
        currencies[2] = GBP;
    }
}
