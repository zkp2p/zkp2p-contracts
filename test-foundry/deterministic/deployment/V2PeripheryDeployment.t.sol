// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {WhitelistPreIntentHook} from "contracts/hooks/WhitelistPreIntentHook.sol";
import {SignatureGatingPreIntentHook} from "contracts/hooks/SignatureGatingPreIntentHook.sol";
import {RateManagerV1} from "contracts/RateManagerV1.sol";
import {ChainlinkOracleAdapter} from "contracts/oracles/ChainlinkOracleAdapter.sol";
import {ProtocolViewerV2} from "contracts/ProtocolViewerV2.sol";
import {DepositCreationGuard} from "contracts/DepositCreationGuard.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";

contract V2PeripheryDeploymentTest is Test {
    address internal multisig;
    OrchestratorRegistry internal orchestratorRegistry;
    EscrowRegistry internal escrowRegistry;
    WhitelistPreIntentHook internal whitelistHook;
    SignatureGatingPreIntentHook internal signatureHook;
    RateManagerV1 internal rateManager;
    ChainlinkOracleAdapter internal chainlinkAdapter;
    ProtocolViewerV2 internal protocolViewer;
    DepositCreationGuard internal depositCreationGuard;

    function setUp() public {
        multisig = makeAddr("multisig");
        orchestratorRegistry = new OrchestratorRegistry();
        escrowRegistry = new EscrowRegistry();
        whitelistHook = new WhitelistPreIntentHook(address(orchestratorRegistry));
        signatureHook = new SignatureGatingPreIntentHook(address(orchestratorRegistry), block.chainid);
        rateManager = new RateManagerV1(address(escrowRegistry));
        chainlinkAdapter = new ChainlinkOracleAdapter();
        protocolViewer = new ProtocolViewerV2();
        depositCreationGuard = new DepositCreationGuard();

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

    function test_DepositCreationGuardIsDeployed() public view {
        assertGt(address(depositCreationGuard).code.length, 0);
    }
}
