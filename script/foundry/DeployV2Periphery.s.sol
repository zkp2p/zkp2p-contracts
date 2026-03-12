// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { AcrossBridgeHookV2 } from "../../contracts/hooks/AcrossBridgeHookV2.sol";
import { SignatureGatingPreIntentHook } from "../../contracts/hooks/SignatureGatingPreIntentHook.sol";
import { WhitelistPreIntentHook } from "../../contracts/hooks/WhitelistPreIntentHook.sol";
import { AcrossSpokePoolMock } from "../../contracts/mocks/AcrossSpokePoolMock.sol";
import { ProtocolViewerV2 } from "../../contracts/ProtocolViewerV2.sol";
import { RateManagerV1 } from "../../contracts/RateManagerV1.sol";
import { ChainlinkOracleAdapter } from "../../contracts/oracles/ChainlinkOracleAdapter.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";

contract DeployV2Periphery is Script {
    struct DeploymentConfig {
        address owner;
        address multiSig;
        address usdc;
        address orchestratorRegistry;
        address postIntentHookRegistry;
        address escrowRegistry;
        address spokePool;
        bool deployMockSpokePool;
        bool registerAcrossBridgeHook;
        bool transferOwnershipToMultiSig;
    }

    struct DeploymentResult {
        address whitelistPreIntentHook;
        address signatureGatingPreIntentHook;
        address spokePool;
        address acrossBridgeHookV2;
        address rateManagerV1;
        address chainlinkOracleAdapter;
        address protocolViewerV2;
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
        address finalOwner = config.transferOwnershipToMultiSig ? config.multiSig : config.owner;

        vm.startBroadcast(deployerPrivateKey);

        WhitelistPreIntentHook whitelistPreIntentHook = new WhitelistPreIntentHook(config.orchestratorRegistry);
        SignatureGatingPreIntentHook signatureGatingPreIntentHook =
            new SignatureGatingPreIntentHook(config.orchestratorRegistry, block.chainid);

        if (config.spokePool == address(0)) {
            require(
                config.deployMockSpokePool,
                "ACROSS_SPOKE_POOL_ADDRESS required unless DEPLOY_ACROSS_SPOKE_POOL_MOCK=true"
            );
            AcrossSpokePoolMock spokePoolMock = new AcrossSpokePoolMock();
            result.spokePool = address(spokePoolMock);
        } else {
            result.spokePool = config.spokePool;
        }

        AcrossBridgeHookV2 acrossBridgeHookV2 =
            new AcrossBridgeHookV2(config.usdc, config.orchestratorRegistry, result.spokePool);
        RateManagerV1 rateManagerV1 = new RateManagerV1(config.escrowRegistry);
        ChainlinkOracleAdapter chainlinkOracleAdapter = new ChainlinkOracleAdapter();
        ProtocolViewerV2 protocolViewerV2 = new ProtocolViewerV2();

        if (config.registerAcrossBridgeHook) {
            PostIntentHookRegistry(config.postIntentHookRegistry).addPostIntentHook(address(acrossBridgeHookV2));
        }

        if (finalOwner != deployer) {
            if (acrossBridgeHookV2.owner() != finalOwner) {
                acrossBridgeHookV2.transferOwnership(finalOwner);
            }
            if (rateManagerV1.owner() != finalOwner) {
                rateManagerV1.transferOwnership(finalOwner);
            }
        }

        vm.stopBroadcast();

        result.whitelistPreIntentHook = address(whitelistPreIntentHook);
        result.signatureGatingPreIntentHook = address(signatureGatingPreIntentHook);
        result.acrossBridgeHookV2 = address(acrossBridgeHookV2);
        result.rateManagerV1 = address(rateManagerV1);
        result.chainlinkOracleAdapter = address(chainlinkOracleAdapter);
        result.protocolViewerV2 = address(protocolViewerV2);

        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.owner = vm.envOr("OWNER", deployer);
        config.multiSig = vm.envOr("MULTISIG", config.owner);
        config.usdc = vm.envAddress("USDC_ADDRESS");
        config.orchestratorRegistry = vm.envAddress("ORCHESTRATOR_REGISTRY_ADDRESS");
        config.postIntentHookRegistry = vm.envAddress("POST_INTENT_HOOK_REGISTRY_ADDRESS");
        config.escrowRegistry = vm.envAddress("ESCROW_REGISTRY_ADDRESS");
        config.spokePool = vm.envOr("ACROSS_SPOKE_POOL_ADDRESS", address(0));
        config.deployMockSpokePool = vm.envOr("DEPLOY_ACROSS_SPOKE_POOL_MOCK", false);
        config.registerAcrossBridgeHook = vm.envOr("REGISTER_POST_INTENT_HOOK", true);
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal pure {
        console2.log("DeployV2Periphery complete");
        console2.log("multiSig", config.multiSig);
        console2.log("whitelistPreIntentHook", result.whitelistPreIntentHook);
        console2.log("signatureGatingPreIntentHook", result.signatureGatingPreIntentHook);
        console2.log("spokePool", result.spokePool);
        console2.log("acrossBridgeHookV2", result.acrossBridgeHookV2);
        console2.log("rateManagerV1", result.rateManagerV1);
        console2.log("chainlinkOracleAdapter", result.chainlinkOracleAdapter);
        console2.log("protocolViewerV2", result.protocolViewerV2);
    }
}
