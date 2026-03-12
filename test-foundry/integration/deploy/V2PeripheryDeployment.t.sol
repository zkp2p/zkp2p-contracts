// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { AcrossBridgeHookV2 } from "../../../contracts/hooks/AcrossBridgeHookV2.sol";
import { SignatureGatingPreIntentHook } from "../../../contracts/hooks/SignatureGatingPreIntentHook.sol";
import { WhitelistPreIntentHook } from "../../../contracts/hooks/WhitelistPreIntentHook.sol";
import { ProtocolViewerV2 } from "../../../contracts/ProtocolViewerV2.sol";
import { RateManagerV1 } from "../../../contracts/RateManagerV1.sol";
import { ChainlinkOracleAdapter } from "../../../contracts/oracles/ChainlinkOracleAdapter.sol";
import { PostIntentHookRegistry } from "../../../contracts/registries/PostIntentHookRegistry.sol";
import { V2DeploymentTestBase } from "../../helpers/V2DeploymentTestBase.sol";

contract V2PeripheryDeploymentTest is V2DeploymentTestBase {
    function setUp() public {
        _setUpDeploymentHarness();
        v2SystemResult = _runV2SystemDeployment(false);
        v2PeripheryResult = _runV2PeripheryDeployment(address(0), true, true);
    }

    function test_runDeploysWhitelistPreIntentHookAgainstOrchestratorRegistry() public {
        WhitelistPreIntentHook hook = WhitelistPreIntentHook(v2PeripheryResult.whitelistPreIntentHook);

        assertEq(address(hook.orchestratorRegistry()), v2SystemResult.orchestratorRegistry);
    }

    function test_runDeploysSignatureGatingPreIntentHookAgainstOrchestratorRegistryAndChain() public {
        SignatureGatingPreIntentHook hook =
            SignatureGatingPreIntentHook(v2PeripheryResult.signatureGatingPreIntentHook);

        assertEq(address(hook.orchestratorRegistry()), v2SystemResult.orchestratorRegistry);
        assertEq(hook.chainId(), block.chainid);
    }

    function test_runDeploysAcrossBridgeHookV2WithExpectedWiringAndRegistration() public {
        AcrossBridgeHookV2 hook = AcrossBridgeHookV2(payable(v2PeripheryResult.acrossBridgeHookV2));
        PostIntentHookRegistry registry = PostIntentHookRegistry(v1SystemResult.postIntentHookRegistry);

        assertEq(address(hook.orchestratorRegistry()), v2SystemResult.orchestratorRegistry);
        assertEq(address(hook.inputToken()), v1SystemResult.usdc);
        assertEq(address(hook.spokePool()), v2PeripheryResult.spokePool);
        assertEq(hook.owner(), multiSig);
        assertTrue(registry.isWhitelistedHook(address(hook)));
    }

    function test_runDeploysRateManagerV1WithExpectedRegistryAndOwnership() public {
        RateManagerV1 rateManager = RateManagerV1(v2PeripheryResult.rateManagerV1);

        assertEq(address(rateManager.escrowRegistry()), v1SystemResult.escrowRegistry);
        assertEq(rateManager.owner(), multiSig);
    }

    function test_runDeploysChainlinkOracleAdapter() public {
        assertTrue(v2PeripheryResult.chainlinkOracleAdapter != address(0));
        assertEq(address(ChainlinkOracleAdapter(v2PeripheryResult.chainlinkOracleAdapter)), v2PeripheryResult.chainlinkOracleAdapter);
    }

    function test_runDeploysProtocolViewerV2() public {
        assertTrue(v2PeripheryResult.protocolViewerV2 != address(0));
        assertEq(address(ProtocolViewerV2(v2PeripheryResult.protocolViewerV2)), v2PeripheryResult.protocolViewerV2);
    }
}
