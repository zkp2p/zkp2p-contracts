// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { IAttestationVerifier } from "../../contracts/interfaces/IAttestationVerifier.sol";
import { INullifierRegistry } from "../../contracts/interfaces/INullifierRegistry.sol";
import { IOrchestratorRegistry } from "../../contracts/interfaces/IOrchestratorRegistry.sol";
import { EscrowV2 } from "../../contracts/EscrowV2.sol";
import { OrchestratorV2 } from "../../contracts/OrchestratorV2.sol";
import { UnifiedPaymentVerifier } from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";

contract DeploySystemV2 is Script {
    struct DeploymentConfig {
        address owner;
        address multiSig;
        address orchestratorV1;
        address paymentVerifierRegistry;
        address escrowRegistry;
        address relayerRegistry;
        address nullifierRegistry;
        address simpleAttestationVerifier;
        address dustRecipient;
        uint256 dustThreshold;
        uint256 maxIntentsPerDeposit;
        uint256 intentExpirationPeriod;
        uint256 protocolFee;
        address protocolFeeRecipient;
        bool transferOwnershipToMultiSig;
        bool transferVerifierOwnershipToMultiSig;
    }

    struct DeploymentResult {
        address orchestratorRegistry;
        address escrowV2;
        address orchestratorV2;
        address unifiedPaymentVerifierV2;
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

        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        EscrowV2 escrowV2 = new EscrowV2(
            deployer,
            block.chainid,
            address(orchestratorRegistry),
            config.paymentVerifierRegistry,
            config.dustRecipient,
            config.dustThreshold,
            config.maxIntentsPerDeposit,
            config.intentExpirationPeriod
        );
        OrchestratorV2 orchestratorV2 = new OrchestratorV2(
            deployer,
            block.chainid,
            config.escrowRegistry,
            config.paymentVerifierRegistry,
            config.relayerRegistry,
            config.protocolFee,
            config.protocolFeeRecipient
        );
        UnifiedPaymentVerifier unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(config.nullifierRegistry),
            IAttestationVerifier(config.simpleAttestationVerifier)
        );

        orchestratorRegistry.addOrchestrator(config.orchestratorV1);
        orchestratorRegistry.addOrchestrator(address(orchestratorV2));
        EscrowRegistry(config.escrowRegistry).addEscrow(address(escrowV2));
        NullifierRegistry(config.nullifierRegistry).addWritePermission(address(unifiedPaymentVerifierV2));

        if (finalOwner != deployer) {
            if (orchestratorRegistry.owner() != finalOwner) {
                orchestratorRegistry.transferOwnership(finalOwner);
            }
            if (escrowV2.owner() != finalOwner) {
                escrowV2.transferOwnership(finalOwner);
            }
            if (orchestratorV2.owner() != finalOwner) {
                orchestratorV2.transferOwnership(finalOwner);
            }
        }

        if (config.transferVerifierOwnershipToMultiSig && config.multiSig != deployer) {
            if (unifiedPaymentVerifierV2.owner() != config.multiSig) {
                unifiedPaymentVerifierV2.transferOwnership(config.multiSig);
            }
        }

        vm.stopBroadcast();

        result.orchestratorRegistry = address(orchestratorRegistry);
        result.escrowV2 = address(escrowV2);
        result.orchestratorV2 = address(orchestratorV2);
        result.unifiedPaymentVerifierV2 = address(unifiedPaymentVerifierV2);

        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.owner = vm.envOr("OWNER", deployer);
        config.multiSig = vm.envOr("MULTISIG", config.owner);
        config.orchestratorV1 = vm.envAddress("ORCHESTRATOR_V1_ADDRESS");
        config.paymentVerifierRegistry = vm.envAddress("PAYMENT_VERIFIER_REGISTRY_ADDRESS");
        config.escrowRegistry = vm.envAddress("ESCROW_REGISTRY_ADDRESS");
        config.relayerRegistry = vm.envAddress("RELAYER_REGISTRY_ADDRESS");
        config.nullifierRegistry = vm.envAddress("NULLIFIER_REGISTRY_ADDRESS");
        config.simpleAttestationVerifier = vm.envAddress("SIMPLE_ATTESTATION_VERIFIER_ADDRESS");
        config.dustRecipient = vm.envOr("ESCROW_V2_DUST_RECIPIENT", config.owner);
        config.dustThreshold = vm.envOr("ESCROW_V2_DUST_THRESHOLD", uint256(100_000));
        config.maxIntentsPerDeposit = vm.envOr("ESCROW_V2_MAX_INTENTS_PER_DEPOSIT", uint256(100));
        config.intentExpirationPeriod = vm.envOr("ESCROW_V2_INTENT_EXPIRATION_PERIOD", uint256(1 days));
        config.protocolFee = vm.envOr("ORCHESTRATOR_V2_PROTOCOL_FEE", uint256(0));
        config.protocolFeeRecipient = vm.envOr("ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT", config.owner);
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
        config.transferVerifierOwnershipToMultiSig = vm.envOr("TRANSFER_VERIFIER_OWNERSHIP_TO_MULTISIG", false);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal view {
        console2.log("DeploySystemV2 complete");
        console2.log("chainId", block.chainid);
        console2.log("owner", config.owner);
        console2.log("multiSig", config.multiSig);
        console2.log("orchestratorRegistry", result.orchestratorRegistry);
        console2.log("escrowV2", result.escrowV2);
        console2.log("orchestratorV2", result.orchestratorV2);
        console2.log("unifiedPaymentVerifierV2", result.unifiedPaymentVerifierV2);
    }
}
