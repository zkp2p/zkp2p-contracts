// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { AcrossBridgeHook } from "../../contracts/hooks/AcrossBridgeHook.sol";
import { AcrossSpokePoolMock } from "../../contracts/mocks/AcrossSpokePoolMock.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";

contract DeployAcrossBridgeHook is Script {
    struct DeploymentConfig {
        address multiSig;
        address usdc;
        address orchestrator;
        address postIntentHookRegistry;
        address spokePool;
        bool deployMockSpokePool;
        bool registerHook;
        bool transferOwnershipToMultiSig;
    }

    struct DeploymentResult {
        address spokePool;
        address acrossBridgeHook;
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

        if (config.spokePool == address(0)) {
            require(config.deployMockSpokePool, "ACROSS_SPOKE_POOL_ADDRESS required unless DEPLOY_ACROSS_SPOKE_POOL_MOCK=true");
            AcrossSpokePoolMock spokePoolMock = new AcrossSpokePoolMock();
            result.spokePool = address(spokePoolMock);
        } else {
            result.spokePool = config.spokePool;
        }

        AcrossBridgeHook acrossBridgeHook = new AcrossBridgeHook(config.usdc, config.orchestrator, result.spokePool);

        if (config.registerHook) {
            PostIntentHookRegistry(config.postIntentHookRegistry).addPostIntentHook(address(acrossBridgeHook));
        }

        if (config.transferOwnershipToMultiSig && config.multiSig != deployer && acrossBridgeHook.owner() != config.multiSig) {
            acrossBridgeHook.transferOwnership(config.multiSig);
        }

        vm.stopBroadcast();

        result.acrossBridgeHook = address(acrossBridgeHook);
        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.multiSig = vm.envOr("MULTISIG", deployer);
        config.usdc = vm.envAddress("USDC_ADDRESS");
        config.orchestrator = vm.envAddress("ORCHESTRATOR_ADDRESS");
        config.postIntentHookRegistry = vm.envAddress("POST_INTENT_HOOK_REGISTRY_ADDRESS");
        config.spokePool = vm.envOr("ACROSS_SPOKE_POOL_ADDRESS", address(0));
        config.deployMockSpokePool = vm.envOr("DEPLOY_ACROSS_SPOKE_POOL_MOCK", false);
        config.registerHook = vm.envOr("REGISTER_POST_INTENT_HOOK", true);
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal pure {
        console2.log("DeployAcrossBridgeHook complete");
        console2.log("multiSig", config.multiSig);
        console2.log("spokePool", result.spokePool);
        console2.log("acrossBridgeHook", result.acrossBridgeHook);
    }
}
