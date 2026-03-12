// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AcrossBridgeHook} from "../../../contracts/hooks/AcrossBridgeHook.sol";
import {AcrossSpokePoolMock} from "../../../contracts/mocks/AcrossSpokePoolMock.sol";
import {PostIntentHookRegistry} from "../../../contracts/registries/PostIntentHookRegistry.sol";
import {DeployAcrossBridgeHook} from "../../../script/foundry/DeployAcrossBridgeHook.s.sol";
import {DeploySystemV1} from "../../../script/foundry/DeploySystemV1.s.sol";

contract AcrossBridgeHookDeploymentTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;

    DeployAcrossBridgeHook internal acrossBridgeHookScript;
    DeploySystemV1 internal systemScript;
    DeploySystemV1.DeploymentResult internal systemResult;

    address internal deployer;
    address internal owner;
    address internal multiSig;
    address internal protocolFeeRecipient;
    address internal dustRecipient;

    PostIntentHookRegistry internal postIntentHookRegistry;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);
        owner = makeAddr("owner");
        multiSig = makeAddr("multiSig");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        dustRecipient = makeAddr("dustRecipient");

        vm.deal(deployer, 100 ether);

        acrossBridgeHookScript = new DeployAcrossBridgeHook();
        systemScript = new DeploySystemV1();
        systemResult = _runSystemDeployment(deployer);
        postIntentHookRegistry = PostIntentHookRegistry(systemResult.postIntentHookRegistry);
    }

    function test_runDeploysAcrossBridgeHookWithSystemAddresses() public {
        address existingSpokePool = makeAddr("existingSpokePool");
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(existingSpokePool, false, true, true, deployer);
        AcrossBridgeHook hook = AcrossBridgeHook(payable(result.acrossBridgeHook));

        assertEq(address(hook.inputToken()), systemResult.usdc);
        assertEq(hook.orchestrator(), systemResult.orchestrator);
        assertEq(address(hook.spokePool()), existingSpokePool);
    }

    function test_runDeploysMockSpokePoolWhenConfigured() public {
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(address(0), true, true, true, deployer);

        assertTrue(result.spokePool != address(0));
        assertGt(result.spokePool.code.length, 0);
        assertFalse(AcrossSpokePoolMock(result.spokePool).shouldRevert());
    }

    function test_runRevertsWhenSpokePoolIsMissingAndMockDeploymentDisabled() public {
        vm.expectRevert("ACROSS_SPOKE_POOL_ADDRESS required unless DEPLOY_ACROSS_SPOKE_POOL_MOCK=true");
        _runAcrossBridgeHookDeployment(address(0), false, true, true, deployer);
    }

    function test_runWhitelistsHookInPostIntentHookRegistry() public {
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(makeAddr("existingSpokePool"), false, true, true, deployer);

        assertTrue(postIntentHookRegistry.isWhitelistedHook(result.acrossBridgeHook));
    }

    function test_runCanSkipHookRegistration() public {
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(makeAddr("existingSpokePool"), false, false, false, deployer);

        assertFalse(postIntentHookRegistry.isWhitelistedHook(result.acrossBridgeHook));
    }

    function test_runTransfersOwnershipToConfiguredMultiSig() public {
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(makeAddr("existingSpokePool"), false, false, true, multiSig);

        assertEq(AcrossBridgeHook(payable(result.acrossBridgeHook)).owner(), multiSig);
    }

    function test_runKeepsDeployerOwnershipWhenTransferIsDisabled() public {
        DeployAcrossBridgeHook.DeploymentResult memory result =
            _runAcrossBridgeHookDeployment(makeAddr("existingSpokePool"), false, false, false, multiSig);

        assertEq(AcrossBridgeHook(payable(result.acrossBridgeHook)).owner(), deployer);
    }

    function _runSystemDeployment(address configuredMultiSig)
        internal
        returns (DeploySystemV1.DeploymentResult memory deploymentResult)
    {
        DeploySystemV1.DeploymentConfig memory config = DeploySystemV1.DeploymentConfig({
            owner: owner,
            multiSig: configuredMultiSig,
            existingUsdc: address(0),
            usdcMintAmount: 1_000_000e6,
            protocolTakerFee: 0.01e18,
            protocolFeeRecipient: protocolFeeRecipient,
            dustRecipient: dustRecipient,
            dustThreshold: 100_000,
            maxIntentsPerDeposit: 100,
            intentExpirationPeriod: 1 days,
            transferOwnershipToMultiSig: true
        });

        deploymentResult = systemScript.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runAcrossBridgeHookDeployment(
        address spokePool,
        bool deployMockSpokePool,
        bool registerHook,
        bool transferOwnershipToMultiSig,
        address configuredMultiSig
    ) internal returns (DeployAcrossBridgeHook.DeploymentResult memory deploymentResult) {
        DeployAcrossBridgeHook.DeploymentConfig memory config = DeployAcrossBridgeHook.DeploymentConfig({
            multiSig: configuredMultiSig,
            usdc: systemResult.usdc,
            orchestrator: systemResult.orchestrator,
            postIntentHookRegistry: systemResult.postIntentHookRegistry,
            spokePool: spokePool,
            deployMockSpokePool: deployMockSpokePool,
            registerHook: registerHook,
            transferOwnershipToMultiSig: transferOwnershipToMultiSig
        });

        deploymentResult = acrossBridgeHookScript.deployWithConfig(config, DEPLOYER_KEY);
    }
}
