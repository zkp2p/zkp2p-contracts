// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {NullifierRegistry} from "../../../contracts/registries/NullifierRegistry.sol";
import {SimpleAttestationVerifier} from "../../../contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "../../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {DeploySystemV1} from "../../../script/foundry/DeploySystemV1.s.sol";
import {DeployUnifiedVerifier} from "../../../script/foundry/DeployUnifiedVerifier.s.sol";

contract UnifiedVerifierDeploymentTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;

    DeploySystemV1 internal systemScript;
    DeployUnifiedVerifier internal unifiedVerifierScript;
    DeploySystemV1.DeploymentResult internal systemResult;

    address internal deployer;
    address internal owner;
    address internal multiSig;
    address internal witness;
    address internal protocolFeeRecipient;
    address internal dustRecipient;

    NullifierRegistry internal nullifierRegistry;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_KEY);
        owner = makeAddr("owner");
        multiSig = makeAddr("multiSig");
        witness = makeAddr("witness");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        dustRecipient = makeAddr("dustRecipient");

        vm.deal(deployer, 100 ether);

        systemScript = new DeploySystemV1();
        unifiedVerifierScript = new DeployUnifiedVerifier();
        systemResult = _runSystemDeployment(deployer);
        nullifierRegistry = NullifierRegistry(systemResult.nullifierRegistry);
    }

    function test_runDeploysSimpleAttestationVerifierWithWitnessAndOwnership() public {
        DeployUnifiedVerifier.DeploymentResult memory result = _runUnifiedVerifierDeployment(true, true, multiSig);
        SimpleAttestationVerifier attestationVerifier =
            SimpleAttestationVerifier(result.simpleAttestationVerifier);

        assertEq(attestationVerifier.witness(), witness);
        assertEq(attestationVerifier.owner(), multiSig);
    }

    function test_runDeploysUnifiedPaymentVerifierWithExpectedWiring() public {
        DeployUnifiedVerifier.DeploymentResult memory result = _runUnifiedVerifierDeployment(true, true, multiSig);
        UnifiedPaymentVerifier unifiedPaymentVerifier =
            UnifiedPaymentVerifier(payable(result.unifiedPaymentVerifier));

        assertEq(address(unifiedPaymentVerifier.orchestratorRegistry()), systemResult.orchestrator);
        assertEq(address(unifiedPaymentVerifier.nullifierRegistry()), systemResult.nullifierRegistry);
        assertEq(address(unifiedPaymentVerifier.attestationVerifier()), result.simpleAttestationVerifier);
        assertEq(unifiedPaymentVerifier.owner(), multiSig);
    }

    function test_runAddsNullifierWritePermissionForUnifiedPaymentVerifier() public {
        DeployUnifiedVerifier.DeploymentResult memory result = _runUnifiedVerifierDeployment(true, true, multiSig);

        assertTrue(nullifierRegistry.isWriter(result.unifiedPaymentVerifier));
    }

    function test_runCanSkipNullifierWritePermission() public {
        DeployUnifiedVerifier.DeploymentResult memory result = _runUnifiedVerifierDeployment(false, false, deployer);

        assertFalse(nullifierRegistry.isWriter(result.unifiedPaymentVerifier));
        assertEq(SimpleAttestationVerifier(result.simpleAttestationVerifier).owner(), deployer);
        assertEq(UnifiedPaymentVerifier(payable(result.unifiedPaymentVerifier)).owner(), deployer);
    }

    function test_runTransfersOwnershipToConfiguredMultiSigWithoutWritePermissionRegression() public {
        DeployUnifiedVerifier.DeploymentResult memory result = _runUnifiedVerifierDeployment(true, true, multiSig);

        assertEq(SimpleAttestationVerifier(result.simpleAttestationVerifier).owner(), multiSig);
        assertEq(UnifiedPaymentVerifier(payable(result.unifiedPaymentVerifier)).owner(), multiSig);
        assertTrue(nullifierRegistry.isWriter(result.unifiedPaymentVerifier));
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

    function _runUnifiedVerifierDeployment(
        bool addWritePermission,
        bool transferOwnershipToMultiSig,
        address configuredMultiSig
    ) internal returns (DeployUnifiedVerifier.DeploymentResult memory deploymentResult) {
        DeployUnifiedVerifier.DeploymentConfig memory config = DeployUnifiedVerifier.DeploymentConfig({
            multiSig: configuredMultiSig,
            witness: witness,
            orchestrator: systemResult.orchestrator,
            nullifierRegistry: systemResult.nullifierRegistry,
            addWritePermission: addWritePermission,
            transferOwnershipToMultiSig: transferOwnershipToMultiSig
        });

        deploymentResult = unifiedVerifierScript.deployWithConfig(config, DEPLOYER_KEY);
    }
}
