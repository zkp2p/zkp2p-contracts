// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { UnifiedPaymentVerifier } from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import { V2PaymentMethodConfigBuilder } from "./helpers/V2PaymentMethodConfigBuilder.sol";

contract ConfigureV2PaymentMethods is Script, V2PaymentMethodConfigBuilder {
    struct DeploymentConfig {
        address multiSig;
        address unifiedPaymentVerifierV2;
        address paymentVerifierRegistry;
        bool includeLuxon;
        bool transferOwnershipToMultiSig;
    }

    struct DeploymentResult {
        uint256 configuredCount;
    }

    function run() external returns (DeploymentResult memory result) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        DeploymentConfig memory config = _loadConfig(vm.addr(deployerPrivateKey));

        return deployWithConfig(config, deployerPrivateKey);
    }

    function deployWithConfig(DeploymentConfig memory config, uint256 deployerPrivateKey)
        public
        returns (DeploymentResult memory result)
    {
        PaymentMethodConfig[] memory configs = _paymentMethodConfigs(config.includeLuxon);
        UnifiedPaymentVerifier verifier = UnifiedPaymentVerifier(payable(config.unifiedPaymentVerifierV2));
        PaymentVerifierRegistry registry = PaymentVerifierRegistry(config.paymentVerifierRegistry);

        vm.startBroadcast(deployerPrivateKey);

        for (uint256 index = 0; index < configs.length; index++) {
            PaymentMethodConfig memory methodConfig = configs[index];

            if (!verifier.isPaymentMethod(methodConfig.paymentMethodHash)) {
                verifier.addPaymentMethod(methodConfig.paymentMethodHash);
            }

            bool isRegistered = registry.isPaymentMethod(methodConfig.paymentMethodHash);
            if (isRegistered && registry.getVerifier(methodConfig.paymentMethodHash) != config.unifiedPaymentVerifierV2) {
                registry.removePaymentMethod(methodConfig.paymentMethodHash);
                isRegistered = false;
            }

            if (!isRegistered) {
                registry.addPaymentMethod(
                    methodConfig.paymentMethodHash,
                    config.unifiedPaymentVerifierV2,
                    methodConfig.currencies
                );
            }
        }

        if (config.transferOwnershipToMultiSig && verifier.owner() != config.multiSig) {
            verifier.transferOwnership(config.multiSig);
        }

        vm.stopBroadcast();

        result.configuredCount = configs.length;
        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.multiSig = vm.envOr("MULTISIG", deployer);
        config.unifiedPaymentVerifierV2 = vm.envAddress("UNIFIED_PAYMENT_VERIFIER_V2_ADDRESS");
        config.paymentVerifierRegistry = vm.envAddress("PAYMENT_VERIFIER_REGISTRY_ADDRESS");
        config.includeLuxon = vm.envOr("INCLUDE_LUXON_PAYMENT_METHOD", true);
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal pure {
        console2.log("ConfigureV2PaymentMethods complete");
        console2.log("multiSig", config.multiSig);
        console2.log("configuredCount", result.configuredCount);
    }
}
