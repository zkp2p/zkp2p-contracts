// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { DeploySystemV1 } from "../../script/foundry/DeploySystemV1.s.sol";
import { DeployUnifiedVerifier } from "../../script/foundry/DeployUnifiedVerifier.s.sol";
import { ConfigureV2PaymentMethods } from "../../script/foundry/ConfigureV2PaymentMethods.s.sol";
import { DeployPythOracle } from "../../script/foundry/DeployPythOracle.s.sol";
import { DeploySystemV2 } from "../../script/foundry/DeploySystemV2.s.sol";
import { DeployV2Periphery } from "../../script/foundry/DeployV2Periphery.s.sol";

abstract contract V2DeploymentTestBase is Test {
    uint256 internal constant DEPLOYER_KEY = 0xA11CE;

    DeploySystemV1 internal systemV1Script;
    DeployUnifiedVerifier internal unifiedVerifierScript;
    DeploySystemV2 internal systemV2Script;
    DeployV2Periphery internal v2PeripheryScript;
    ConfigureV2PaymentMethods internal paymentMethodsScript;
    DeployPythOracle internal pythOracleScript;

    DeploySystemV1.DeploymentResult internal v1SystemResult;
    DeployUnifiedVerifier.DeploymentResult internal v1UnifiedVerifierResult;
    DeploySystemV2.DeploymentResult internal v2SystemResult;
    DeployV2Periphery.DeploymentResult internal v2PeripheryResult;
    ConfigureV2PaymentMethods.DeploymentResult internal v2PaymentMethodsResult;
    DeployPythOracle.DeploymentResult internal pythResult;

    address internal deployer;
    address internal owner;
    address internal multiSig;
    address internal witness;
    address internal protocolFeeRecipient;
    address internal dustRecipient;

    function _setUpDeploymentHarness() internal {
        deployer = vm.addr(DEPLOYER_KEY);
        owner = makeAddr("owner");
        multiSig = makeAddr("multiSig");
        witness = makeAddr("witness");
        protocolFeeRecipient = makeAddr("protocolFeeRecipient");
        dustRecipient = makeAddr("dustRecipient");

        vm.deal(deployer, 100 ether);

        systemV1Script = new DeploySystemV1();
        unifiedVerifierScript = new DeployUnifiedVerifier();
        systemV2Script = new DeploySystemV2();
        v2PeripheryScript = new DeployV2Periphery();
        paymentMethodsScript = new ConfigureV2PaymentMethods();
        pythOracleScript = new DeployPythOracle();

        v1SystemResult = _runV1SystemDeployment();
        v1UnifiedVerifierResult = _runV1UnifiedVerifierDeployment();
    }

    function _runV1SystemDeployment() internal returns (DeploySystemV1.DeploymentResult memory deploymentResult) {
        DeploySystemV1.DeploymentConfig memory config = DeploySystemV1.DeploymentConfig({
            owner: owner,
            multiSig: deployer,
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

        deploymentResult = systemV1Script.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runV1UnifiedVerifierDeployment()
        internal
        returns (DeployUnifiedVerifier.DeploymentResult memory deploymentResult)
    {
        DeployUnifiedVerifier.DeploymentConfig memory config = DeployUnifiedVerifier.DeploymentConfig({
            multiSig: deployer,
            witness: witness,
            orchestrator: v1SystemResult.orchestrator,
            nullifierRegistry: v1SystemResult.nullifierRegistry,
            addWritePermission: true,
            transferOwnershipToMultiSig: true
        });

        deploymentResult = unifiedVerifierScript.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runV2SystemDeployment(bool transferVerifierOwnershipToMultiSig)
        internal
        returns (DeploySystemV2.DeploymentResult memory deploymentResult)
    {
        DeploySystemV2.DeploymentConfig memory config = DeploySystemV2.DeploymentConfig({
            owner: owner,
            multiSig: multiSig,
            orchestratorV1: v1SystemResult.orchestrator,
            paymentVerifierRegistry: v1SystemResult.paymentVerifierRegistry,
            escrowRegistry: v1SystemResult.escrowRegistry,
            relayerRegistry: v1SystemResult.relayerRegistry,
            nullifierRegistry: v1SystemResult.nullifierRegistry,
            simpleAttestationVerifier: v1UnifiedVerifierResult.simpleAttestationVerifier,
            dustRecipient: dustRecipient,
            dustThreshold: 100_000,
            maxIntentsPerDeposit: 100,
            intentExpirationPeriod: 1 days,
            protocolFee: 0.01e18,
            protocolFeeRecipient: protocolFeeRecipient,
            transferOwnershipToMultiSig: true,
            transferVerifierOwnershipToMultiSig: transferVerifierOwnershipToMultiSig
        });

        deploymentResult = systemV2Script.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runV2PeripheryDeployment(address spokePool, bool deployMockSpokePool, bool registerAcrossBridgeHook)
        internal
        returns (DeployV2Periphery.DeploymentResult memory deploymentResult)
    {
        DeployV2Periphery.DeploymentConfig memory config = DeployV2Periphery.DeploymentConfig({
            owner: owner,
            multiSig: multiSig,
            usdc: v1SystemResult.usdc,
            orchestratorRegistry: v2SystemResult.orchestratorRegistry,
            postIntentHookRegistry: v1SystemResult.postIntentHookRegistry,
            escrowRegistry: v1SystemResult.escrowRegistry,
            spokePool: spokePool,
            deployMockSpokePool: deployMockSpokePool,
            registerAcrossBridgeHook: registerAcrossBridgeHook,
            transferOwnershipToMultiSig: true
        });

        deploymentResult = v2PeripheryScript.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runV2PaymentMethodConfiguration(bool includeLuxon)
        internal
        returns (ConfigureV2PaymentMethods.DeploymentResult memory deploymentResult)
    {
        ConfigureV2PaymentMethods.DeploymentConfig memory config = ConfigureV2PaymentMethods.DeploymentConfig({
            multiSig: multiSig,
            unifiedPaymentVerifierV2: v2SystemResult.unifiedPaymentVerifierV2,
            paymentVerifierRegistry: v1SystemResult.paymentVerifierRegistry,
            includeLuxon: includeLuxon,
            transferOwnershipToMultiSig: true
        });

        deploymentResult = paymentMethodsScript.deployWithConfig(config, DEPLOYER_KEY);
    }

    function _runPythOracleDeployment(address configuredPyth, bool deployMockPyth)
        internal
        returns (DeployPythOracle.DeploymentResult memory deploymentResult)
    {
        DeployPythOracle.DeploymentConfig memory config = DeployPythOracle.DeploymentConfig({
            pyth: configuredPyth,
            deployMockPyth: deployMockPyth
        });

        deploymentResult = pythOracleScript.deployWithConfig(config, DEPLOYER_KEY);
    }
}
