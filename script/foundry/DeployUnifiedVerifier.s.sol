// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IAttestationVerifier} from "../../contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "../../contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "../../contracts/interfaces/IOrchestratorRegistry.sol";
import {NullifierRegistry} from "../../contracts/registries/NullifierRegistry.sol";
import {SimpleAttestationVerifier} from "../../contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";

contract DeployUnifiedVerifier is Script {
    struct DeploymentConfig {
        address multiSig;
        address witness;
        address orchestrator;
        address nullifierRegistry;
        bool addWritePermission;
        bool transferOwnershipToMultiSig;
    }

    struct DeploymentResult {
        address simpleAttestationVerifier;
        address unifiedPaymentVerifier;
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
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        SimpleAttestationVerifier simpleAttestationVerifier = new SimpleAttestationVerifier(config.witness);
        UnifiedPaymentVerifier unifiedPaymentVerifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(config.orchestrator),
            INullifierRegistry(config.nullifierRegistry),
            IAttestationVerifier(address(simpleAttestationVerifier))
        );

        if (config.addWritePermission) {
            NullifierRegistry(config.nullifierRegistry).addWritePermission(address(unifiedPaymentVerifier));
        }

        if (config.transferOwnershipToMultiSig && config.multiSig != deployer) {
            if (simpleAttestationVerifier.owner() != config.multiSig) {
                simpleAttestationVerifier.transferOwnership(config.multiSig);
            }
            if (unifiedPaymentVerifier.owner() != config.multiSig) {
                unifiedPaymentVerifier.transferOwnership(config.multiSig);
            }
        }

        vm.stopBroadcast();

        result.simpleAttestationVerifier = address(simpleAttestationVerifier);
        result.unifiedPaymentVerifier = address(unifiedPaymentVerifier);

        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.multiSig = vm.envOr("MULTISIG", deployer);
        config.witness = vm.envAddress("WITNESS_ADDRESS");
        config.orchestrator = vm.envAddress("ORCHESTRATOR_ADDRESS");
        config.nullifierRegistry = vm.envAddress("NULLIFIER_REGISTRY_ADDRESS");
        config.addWritePermission = vm.envOr("ADD_NULLIFIER_WRITE_PERMISSION", true);
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal pure {
        console2.log("DeployUnifiedVerifier complete");
        console2.log("multiSig", config.multiSig);
        console2.log("witness", config.witness);
        console2.log("orchestrator", config.orchestrator);
        console2.log("nullifierRegistry", config.nullifierRegistry);
        console2.log("simpleAttestationVerifier", result.simpleAttestationVerifier);
        console2.log("unifiedPaymentVerifier", result.unifiedPaymentVerifier);
    }
}
