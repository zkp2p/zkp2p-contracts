// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { PaymentVerifierRegistry } from "../../../contracts/registries/PaymentVerifierRegistry.sol";
import { UnifiedPaymentVerifier } from "../../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import { V2PaymentMethodConfigBuilder } from "../../../script/foundry/helpers/V2PaymentMethodConfigBuilder.sol";
import { V2DeploymentTestBase } from "../../helpers/V2DeploymentTestBase.sol";

contract V2PaymentMethodsDeploymentTest is V2DeploymentTestBase, V2PaymentMethodConfigBuilder {
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    UnifiedPaymentVerifier internal unifiedPaymentVerifierV2;

    function setUp() public {
        _setUpDeploymentHarness();
        v2SystemResult = _runV2SystemDeployment(false);
        v2PaymentMethodsResult = _runV2PaymentMethodConfiguration(true);

        paymentVerifierRegistry = PaymentVerifierRegistry(v1SystemResult.paymentVerifierRegistry);
        unifiedPaymentVerifierV2 = UnifiedPaymentVerifier(payable(v2SystemResult.unifiedPaymentVerifierV2));
    }

    function test_runConfiguresEveryExpectedPaymentMethodOnRegistryAndVerifier() public {
        PaymentMethodConfig[] memory configs = _paymentMethodConfigs(true);
        bytes32[] memory registeredMethods = unifiedPaymentVerifierV2.getPaymentMethods();

        assertEq(v2PaymentMethodsResult.configuredCount, configs.length);
        assertEq(registeredMethods.length, configs.length);

        for (uint256 index = 0; index < configs.length; index++) {
            PaymentMethodConfig memory methodConfig = configs[index];

            assertTrue(paymentVerifierRegistry.isPaymentMethod(methodConfig.paymentMethodHash));
            assertEq(paymentVerifierRegistry.getVerifier(methodConfig.paymentMethodHash), address(unifiedPaymentVerifierV2));

            bytes32[] memory configuredCurrencies = paymentVerifierRegistry.getCurrencies(methodConfig.paymentMethodHash);
            assertEq(configuredCurrencies.length, methodConfig.currencies.length);
            for (uint256 currencyIndex = 0; currencyIndex < methodConfig.currencies.length; currencyIndex++) {
                assertEq(configuredCurrencies[currencyIndex], methodConfig.currencies[currencyIndex]);
            }

            assertTrue(unifiedPaymentVerifierV2.isPaymentMethod(methodConfig.paymentMethodHash));
            assertEq(registeredMethods[index], methodConfig.paymentMethodHash);
        }
    }

    function test_runTransfersUnifiedPaymentVerifierV2OwnershipToMultiSig() public {
        assertEq(unifiedPaymentVerifierV2.owner(), multiSig);
    }
}
