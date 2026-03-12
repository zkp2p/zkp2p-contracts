// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { Escrow } from "../../contracts/Escrow.sol";
import { Orchestrator } from "../../contracts/Orchestrator.sol";
import { ProtocolViewer } from "../../contracts/ProtocolViewer.sol";
import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";
import { PaymentVerifierRegistry } from "../../contracts/registries/PaymentVerifierRegistry.sol";
import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";
import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract DeploySystemV1 is Script {
    struct DeploymentConfig {
        address owner;
        address multiSig;
        address existingUsdc;
        uint256 usdcMintAmount;
        uint256 protocolTakerFee;
        address protocolFeeRecipient;
        address dustRecipient;
        uint256 dustThreshold;
        uint256 maxIntentsPerDeposit;
        uint256 intentExpirationPeriod;
        bool transferOwnershipToMultiSig;
    }

    struct DeploymentResult {
        address usdc;
        address paymentVerifierRegistry;
        address postIntentHookRegistry;
        address relayerRegistry;
        address nullifierRegistry;
        address escrowRegistry;
        address escrow;
        address orchestrator;
        address protocolViewer;
    }

    function run() external returns (DeploymentResult memory result) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        DeploymentConfig memory config = _loadConfig(deployer);

        vm.startBroadcast(deployerPrivateKey);

        if (config.existingUsdc == address(0)) {
            USDCMock usdcMock = new USDCMock(config.usdcMintAmount, "USDC", "USDC");
            result.usdc = address(usdcMock);
        } else {
            result.usdc = config.existingUsdc;
        }

        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        PostIntentHookRegistry postIntentHookRegistry = new PostIntentHookRegistry();
        RelayerRegistry relayerRegistry = new RelayerRegistry();
        NullifierRegistry nullifierRegistry = new NullifierRegistry();
        EscrowRegistry escrowRegistry = new EscrowRegistry();

        Escrow escrow = new Escrow(
            config.owner,
            block.chainid,
            address(paymentVerifierRegistry),
            config.dustRecipient,
            config.dustThreshold,
            config.maxIntentsPerDeposit,
            config.intentExpirationPeriod
        );

        Orchestrator orchestrator = new Orchestrator(
            config.owner,
            block.chainid,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            config.protocolTakerFee,
            config.protocolFeeRecipient
        );

        escrowRegistry.addEscrow(address(escrow));
        escrow.setOrchestrator(address(orchestrator));

        ProtocolViewer protocolViewer = new ProtocolViewer(address(escrow), address(orchestrator));

        if (config.transferOwnershipToMultiSig && config.multiSig != deployer) {
            paymentVerifierRegistry.transferOwnership(config.multiSig);
            postIntentHookRegistry.transferOwnership(config.multiSig);
            relayerRegistry.transferOwnership(config.multiSig);
            nullifierRegistry.transferOwnership(config.multiSig);
            escrowRegistry.transferOwnership(config.multiSig);

            if (escrow.owner() != config.multiSig) {
                escrow.transferOwnership(config.multiSig);
            }
            if (orchestrator.owner() != config.multiSig) {
                orchestrator.transferOwnership(config.multiSig);
            }
        }

        vm.stopBroadcast();

        result.paymentVerifierRegistry = address(paymentVerifierRegistry);
        result.postIntentHookRegistry = address(postIntentHookRegistry);
        result.relayerRegistry = address(relayerRegistry);
        result.nullifierRegistry = address(nullifierRegistry);
        result.escrowRegistry = address(escrowRegistry);
        result.escrow = address(escrow);
        result.orchestrator = address(orchestrator);
        result.protocolViewer = address(protocolViewer);

        _logResult(config, result);
        return result;
    }

    function _loadConfig(address deployer) internal view returns (DeploymentConfig memory config) {
        config.owner = vm.envOr("OWNER", deployer);
        config.multiSig = vm.envOr("MULTISIG", config.owner);
        config.existingUsdc = vm.envOr("USDC_ADDRESS", address(0));
        config.usdcMintAmount = vm.envOr("USDC_MINT_AMOUNT", uint256(1_000_000e6));
        config.protocolTakerFee = vm.envOr("PROTOCOL_TAKER_FEE", uint256(0));
        config.protocolFeeRecipient = vm.envOr("PROTOCOL_TAKER_FEE_RECIPIENT", config.owner);
        config.dustRecipient = vm.envOr("ESCROW_DUST_RECIPIENT", config.owner);
        config.dustThreshold = vm.envOr("ESCROW_DUST_THRESHOLD", uint256(100_000));
        config.maxIntentsPerDeposit = vm.envOr("MAX_INTENTS_PER_DEPOSIT", uint256(100));
        config.intentExpirationPeriod = vm.envOr("INTENT_EXPIRATION_PERIOD", uint256(1 days));
        config.transferOwnershipToMultiSig = vm.envOr("TRANSFER_OWNERSHIP_TO_MULTISIG", true);
    }

    function _logResult(DeploymentConfig memory config, DeploymentResult memory result) internal view {
        console2.log("DeploySystemV1 complete");
        console2.log("chainId", block.chainid);
        console2.log("owner", config.owner);
        console2.log("multiSig", config.multiSig);
        console2.log("usdc", result.usdc);
        console2.log("paymentVerifierRegistry", result.paymentVerifierRegistry);
        console2.log("postIntentHookRegistry", result.postIntentHookRegistry);
        console2.log("relayerRegistry", result.relayerRegistry);
        console2.log("nullifierRegistry", result.nullifierRegistry);
        console2.log("escrowRegistry", result.escrowRegistry);
        console2.log("escrow", result.escrow);
        console2.log("orchestrator", result.orchestrator);
        console2.log("protocolViewer", result.protocolViewer);
    }
}
