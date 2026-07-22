// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {AcrossBridgeHook} from "contracts/hooks/AcrossBridgeHook.sol";
import {AcrossSpokePoolMock} from "contracts/mocks/AcrossSpokePoolMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";

contract AcrossBridgeHookDeploymentTest is Test {
    address internal orchestrator;
    USDCMock internal token;
    AcrossSpokePoolMock internal spokePool;
    AcrossBridgeHook internal hook;
    PostIntentHookRegistry internal registry;

    function setUp() public {
        orchestrator = makeAddr("legacyAcrossOrchestrator");
        token = new USDCMock(1e6, "USD Coin", "USDC");
        spokePool = new AcrossSpokePoolMock();
        hook = new AcrossBridgeHook(address(token), orchestrator, address(spokePool));
        registry = new PostIntentHookRegistry();
        registry.addPostIntentHook(address(hook));
    }

    function test_AcrossBridgeHookDeploymentSetsConstructorParameters() public view {
        assertEq(hook.orchestrator(), orchestrator);
        assertEq(address(hook.inputToken()), address(token));
        assertEq(address(hook.spokePool()), address(spokePool));
    }

    function test_AcrossBridgeHookDeploymentSetsOwner() public view {
        assertEq(hook.owner(), address(this));
    }

    function test_AcrossBridgeHookDeploymentWhitelistsHook() public view {
        assertTrue(registry.isWhitelistedHook(address(hook)));
    }
}
