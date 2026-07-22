// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {WhitelistPreIntentHook} from "contracts/hooks/WhitelistPreIntentHook.sol";
import {SignatureGatingPreIntentHook} from "contracts/hooks/SignatureGatingPreIntentHook.sol";
import {AcrossBridgeHookV2} from "contracts/hooks/AcrossBridgeHookV2.sol";
import {AcrossSpokePoolMock} from "contracts/mocks/AcrossSpokePoolMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {RateManagerV1} from "contracts/RateManagerV1.sol";
import {ChainlinkOracleAdapter} from "contracts/oracles/ChainlinkOracleAdapter.sol";
import {ProtocolViewerV2} from "contracts/ProtocolViewerV2.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";

contract V2PeripheryDeploymentTest is Test {
    address internal multisig;
    USDCMock internal token;
    AcrossSpokePoolMock internal spokePool;
    OrchestratorRegistry internal orchestratorRegistry;
    PostIntentHookRegistry internal hookRegistry;
    EscrowRegistry internal escrowRegistry;
    WhitelistPreIntentHook internal whitelistHook;
    SignatureGatingPreIntentHook internal signatureHook;
    AcrossBridgeHookV2 internal acrossHook;
    RateManagerV1 internal rateManager;
    ChainlinkOracleAdapter internal chainlinkAdapter;
    ProtocolViewerV2 internal protocolViewer;

    function setUp() public {
        multisig = makeAddr("multisig");
        token = new USDCMock(1e6, "USD Coin", "USDC");
        spokePool = new AcrossSpokePoolMock();
        orchestratorRegistry = new OrchestratorRegistry();
        hookRegistry = new PostIntentHookRegistry();
        escrowRegistry = new EscrowRegistry();
        whitelistHook = new WhitelistPreIntentHook(address(orchestratorRegistry));
        signatureHook = new SignatureGatingPreIntentHook(address(orchestratorRegistry), block.chainid);
        acrossHook = new AcrossBridgeHookV2(address(token), address(orchestratorRegistry), address(spokePool));
        rateManager = new RateManagerV1(address(escrowRegistry));
        chainlinkAdapter = new ChainlinkOracleAdapter();
        protocolViewer = new ProtocolViewerV2();

        hookRegistry.addPostIntentHook(address(acrossHook));
        acrossHook.transferOwnership(multisig);
        rateManager.transferOwnership(multisig);
    }

    function test_WhitelistPreIntentHookWiresOrchestratorRegistry() public view {
        assertEq(address(whitelistHook.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_SignatureGatingPreIntentHookWiresOrchestratorRegistry() public view {
        assertEq(address(signatureHook.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_SignatureGatingPreIntentHookSetsChainId() public view {
        assertEq(signatureHook.chainId(), block.chainid);
    }

    function test_AcrossBridgeHookV2WiresOrchestratorRegistry() public view {
        assertEq(address(acrossHook.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_AcrossBridgeHookV2SetsInputToken() public view {
        assertEq(address(acrossHook.inputToken()), address(token));
    }

    function test_AcrossBridgeHookV2SetsSpokePool() public view {
        assertEq(address(acrossHook.spokePool()), address(spokePool));
    }

    function test_AcrossBridgeHookV2TransfersOwnership() public view {
        assertEq(acrossHook.owner(), multisig);
    }

    function test_AcrossBridgeHookV2IsWhitelisted() public view {
        assertTrue(hookRegistry.isWhitelistedHook(address(acrossHook)));
    }

    function test_RateManagerV1IsDeployed() public view {
        assertGt(address(rateManager).code.length, 0);
    }

    function test_RateManagerV1WiresEscrowRegistry() public view {
        assertEq(address(rateManager.escrowRegistry()), address(escrowRegistry));
    }

    function test_RateManagerV1TransfersOwnership() public view {
        assertEq(rateManager.owner(), multisig);
    }

    function test_ChainlinkOracleAdapterIsDeployed() public view {
        assertGt(address(chainlinkAdapter).code.length, 0);
    }

    function test_ProtocolViewerV2IsDeployed() public view {
        assertGt(address(protocolViewer).code.length, 0);
    }
}
