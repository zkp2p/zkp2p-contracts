// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { Escrow } from "../../../contracts/Escrow.sol";
import { Orchestrator } from "../../../contracts/Orchestrator.sol";
import { ProtocolViewer } from "../../../contracts/ProtocolViewer.sol";
import { EscrowRegistry } from "../../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../../contracts/registries/PaymentVerifierRegistry.sol";
import { PostIntentHookRegistry } from "../../../contracts/registries/PostIntentHookRegistry.sol";
import { RelayerRegistry } from "../../../contracts/registries/RelayerRegistry.sol";
import { NullifierRegistry } from "../../../contracts/registries/NullifierRegistry.sol";
import { USDCMock } from "../../../contracts/mocks/USDCMock.sol";
import { DeploySystemV1 } from "../../../script/foundry/DeploySystemV1.s.sol";

contract SystemV1DeploymentTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;

    DeploySystemV1 internal deploymentScript;
    DeploySystemV1.DeploymentResult internal result;

    address internal deployer;
    address internal owner;
    address internal multiSig;
    address internal protocolFeeRecipient;
    address internal dustRecipient;

    Escrow internal escrow;
    Orchestrator internal orchestrator;
    ProtocolViewer internal protocolViewer;
    EscrowRegistry internal escrowRegistry;
    PaymentVerifierRegistry internal paymentVerifierRegistry;
    PostIntentHookRegistry internal postIntentHookRegistry;
    RelayerRegistry internal relayerRegistry;
    NullifierRegistry internal nullifierRegistry;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);
        owner = makeAddr("owner");
        multiSig = makeAddr("multiSig");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        dustRecipient = makeAddr("dustRecipient");

        vm.deal(deployer, 100 ether);

        deploymentScript = new DeploySystemV1();
        result = _runDefaultDeployment();

        escrow = Escrow(result.escrow);
        orchestrator = Orchestrator(result.orchestrator);
        protocolViewer = ProtocolViewer(result.protocolViewer);
        escrowRegistry = EscrowRegistry(result.escrowRegistry);
        paymentVerifierRegistry = PaymentVerifierRegistry(result.paymentVerifierRegistry);
        postIntentHookRegistry = PostIntentHookRegistry(result.postIntentHookRegistry);
        relayerRegistry = RelayerRegistry(result.relayerRegistry);
        nullifierRegistry = NullifierRegistry(result.nullifierRegistry);
    }

    function test_runDeploysUsdcMockWhenExistingTokenIsNotConfigured() public {
        assertTrue(result.usdc != address(0));
        assertEq(USDCMock(result.usdc).balanceOf(deployer), 1_000_000e6);
    }

    function test_runUsesExistingUsdcWhenProvided() public {
        address existingUsdc = makeAddr("existingUsdc");
        DeploySystemV1.DeploymentResult memory existingResult = _runDeployment(existingUsdc, true, multiSig);

        assertEq(existingResult.usdc, existingUsdc);
    }

    function test_runTransfersOwnershipToMultiSig() public {
        assertEq(escrowRegistry.owner(), multiSig);
        assertEq(paymentVerifierRegistry.owner(), multiSig);
        assertEq(postIntentHookRegistry.owner(), multiSig);
        assertEq(relayerRegistry.owner(), multiSig);
        assertEq(nullifierRegistry.owner(), multiSig);
        assertEq(escrow.owner(), multiSig);
        assertEq(orchestrator.owner(), multiSig);
    }

    function test_runDeploysEscrowWithExpectedWiringAndConfig() public {
        assertEq(address(escrow.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(address(escrow.orchestrator()), address(orchestrator));
        assertEq(escrow.chainId(), block.chainid);
        assertTrue(escrowRegistry.isWhitelistedEscrow(address(escrow)));
        assertEq(escrow.dustRecipient(), dustRecipient);
        assertEq(escrow.dustThreshold(), 100_000);
        assertEq(escrow.maxIntentsPerDeposit(), 100);
        assertEq(escrow.intentExpirationPeriod(), 1 days);
    }

    function test_runDeploysOrchestratorWithExpectedWiringAndFeeConfig() public {
        assertEq(orchestrator.owner(), multiSig);
        assertEq(orchestrator.chainId(), block.chainid);
        assertEq(address(orchestrator.escrowRegistry()), address(escrowRegistry));
        assertEq(address(orchestrator.paymentVerifierRegistry()), address(paymentVerifierRegistry));
        assertEq(address(orchestrator.postIntentHookRegistry()), address(postIntentHookRegistry));
        assertEq(address(orchestrator.relayerRegistry()), address(relayerRegistry));
        assertEq(orchestrator.protocolFee(), 0.01e18);
        assertEq(orchestrator.protocolFeeRecipient(), protocolFeeRecipient);
    }

    function test_runDeploysProtocolViewerAgainstEscrowAndOrchestrator() public {
        assertEq(address(protocolViewer.escrowContract()), address(escrow));
        assertEq(address(protocolViewer.orchestrator()), address(orchestrator));
    }

    function test_runCanKeepOwnershipWithDeployerWhenRequested() public {
        DeploySystemV1.DeploymentResult memory deployerOwnedResult = _runDeployment(address(0), false, deployer);
        Escrow deployerOwnedEscrow = Escrow(deployerOwnedResult.escrow);
        Orchestrator deployerOwnedOrchestrator = Orchestrator(deployerOwnedResult.orchestrator);

        assertEq(PaymentVerifierRegistry(deployerOwnedResult.paymentVerifierRegistry).owner(), deployer);
        assertEq(PostIntentHookRegistry(deployerOwnedResult.postIntentHookRegistry).owner(), deployer);
        assertEq(RelayerRegistry(deployerOwnedResult.relayerRegistry).owner(), deployer);
        assertEq(NullifierRegistry(deployerOwnedResult.nullifierRegistry).owner(), deployer);
        assertEq(EscrowRegistry(deployerOwnedResult.escrowRegistry).owner(), deployer);
        assertEq(deployerOwnedEscrow.owner(), owner);
        assertEq(deployerOwnedOrchestrator.owner(), owner);
    }

    function _runDefaultDeployment() internal returns (DeploySystemV1.DeploymentResult memory deploymentResult) {
        deploymentResult = _runDeployment(address(0), true, multiSig);
    }

    function _runDeployment(address existingUsdc, bool transferOwnershipToMultiSig, address configuredMultiSig)
        internal
        returns (DeploySystemV1.DeploymentResult memory deploymentResult)
    {
        DeploySystemV1.DeploymentConfig memory config = DeploySystemV1.DeploymentConfig({
            owner: owner,
            multiSig: configuredMultiSig,
            existingUsdc: existingUsdc,
            usdcMintAmount: 1_000_000e6,
            protocolTakerFee: 0.01e18,
            protocolFeeRecipient: protocolFeeRecipient,
            dustRecipient: dustRecipient,
            dustThreshold: 100_000,
            maxIntentsPerDeposit: 100,
            intentExpirationPeriod: 1 days,
            transferOwnershipToMultiSig: transferOwnershipToMultiSig
        });

        deploymentResult = deploymentScript.deployWithConfig(config, DEPLOYER_KEY);
    }
}
