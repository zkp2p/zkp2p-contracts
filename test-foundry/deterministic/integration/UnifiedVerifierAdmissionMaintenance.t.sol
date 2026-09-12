// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Orchestrator} from "contracts/Orchestrator.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

/// @notice Tests the admission-only maintenance prerequisite for a shared-verifier cutover.
contract UnifiedVerifierAdmissionMaintenanceTest is OrchestratorV3Fixture {
    uint256 internal constant WITNESS_KEY = 0xCAFE;
    Orchestrator internal legacyV1;
    OrchestratorV2 internal legacyV2;
    UnifiedPaymentVerifierV3 internal predecessor;
    NullifierRegistryV2 internal nullifiers;

    function setUp() public override {
        super.setUp();
        vm.warp(1_000_000);
        legacyV1 = new Orchestrator(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(new PostIntentHookRegistry()),
            address(relayerRegistry),
            0,
            protocolFeeRecipient
        );
        legacyV2 = new OrchestratorV2(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(relayerRegistry),
            0,
            protocolFeeRecipient
        );
        legacyV1.setAllowMultipleIntents(true);
        legacyV2.setAllowMultipleIntents(true);
        orchestratorRegistry.addOrchestrator(address(legacyV1));
        orchestratorRegistry.addOrchestrator(address(legacyV2));
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        predecessor = new UnifiedPaymentVerifierV3(
            orchestratorRegistry, nullifiers, new SimpleAttestationVerifier(vm.addr(WITNESS_KEY))
        );
        nullifiers.addWritePermission(address(predecessor));
        predecessor.addPaymentMethod(METHOD);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(predecessor), currencies);
    }

    function test_ClosedEscrowAdmissionPreservesPaidSettlementAndUnpaidCancellationForEveryCaller() public {
        bytes32[3] memory paid;
        bytes32[3] memory unpaid;
        for (uint256 kind; kind < 3; ++kind) {
            paid[kind] = _startIntent(kind);
            unpaid[kind] = _startIntent(kind);
        }
        // Both conditions are necessary: an empty allowlist alone is not maintenance.
        escrowRegistry.setAcceptAllEscrows(true);
        escrowRegistry.setAcceptAllEscrows(false);
        escrowRegistry.removeEscrow(address(escrow));
        assertEq(escrowRegistry.getWhitelistedEscrows().length, 0);
        for (uint256 kind; kind < 3; ++kind) {
            vm.expectRevert(abi.encodeWithSelector(IOrchestrator.EscrowNotWhitelisted.selector, address(escrow)));
            _callSignal(kind);

            bytes32 paymentId = keccak256(abi.encode("paid-before-maintenance", kind));
            IOrchestrator(_caller(kind))
                .fulfillIntent(IOrchestrator.FulfillIntentParams(_proof(paid[kind], paymentId), paid[kind], "", ""));
            assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, paymentId))), paid[kind]);
            vm.prank(taker);
            IOrchestrator(_caller(kind)).cancelIntent(unpaid[kind]);
            assertEq(IOrchestrator(_caller(kind)).getAccountIntents(taker).length, 0);
        }
        assertEq(token.balanceOf(taker), 3 * INTENT_AMOUNT);
        assertEq(escrow.getDepositIntentHashes(depositId).length, 0);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6 - 3 * INTENT_AMOUNT);
        assertEq(paymentVerifierRegistry.getVerifier(METHOD), address(predecessor));
        assertTrue(nullifiers.isWriter(address(predecessor)));
    }

    function test_PausingOrDeauthorizingBeforeDrainStrandsPaidSettlement() public {
        bytes32 intentHash = _startIntent(1);
        bytes memory proof = _proof(intentHash, keccak256("already-paid"));
        legacyV2.pauseOrchestrator();
        vm.expectRevert("Pausable: paused");
        legacyV2.fulfillIntent(IOrchestratorV2.FulfillIntentParams(proof, intentHash, "", ""));
        legacyV2.unpauseOrchestrator();
        orchestratorRegistry.removeOrchestrator(address(legacyV2));
        vm.expectRevert("Only orchestrator can call");
        legacyV2.fulfillIntent(IOrchestratorV2.FulfillIntentParams(proof, intentHash, "", ""));
        assertEq(nullifiers.nullifierByIntentHash(intentHash), bytes32(0));
        assertEq(legacyV2.getIntent(intentHash).owner, taker);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function _caller(uint256 kind) internal view returns (address) {
        if (kind == 0) return address(legacyV1);
        if (kind == 1) return address(legacyV2);
        return address(orchestrator);
    }

    function _startIntent(uint256 kind) internal returns (bytes32) {
        _callSignal(kind);
        bytes32[] memory intents = IOrchestrator(_caller(kind)).getAccountIntents(taker);
        return intents[intents.length - 1];
    }

    function _callSignal(uint256 kind) internal {
        vm.prank(taker);
        if (kind == 0) {
            legacyV1.signalIntent(
                IOrchestrator.SignalIntentParams({
                    escrow: address(escrow),
                    depositId: depositId,
                    amount: INTENT_AMOUNT,
                    to: taker,
                    paymentMethod: METHOD,
                    fiatCurrency: USD,
                    conversionRate: CONVERSION_RATE,
                    referrer: address(0),
                    referrerFee: 0,
                    gatingServiceSignature: "",
                    signatureExpiration: 0,
                    postIntentHook: IPostIntentHook(address(0)),
                    data: ""
                })
            );
        } else {
            IOrchestratorV2(_caller(kind))
                .signalIntent(
                    IOrchestratorV2.SignalIntentParams({
                    escrow: address(escrow),
                    depositId: depositId,
                    amount: INTENT_AMOUNT,
                    to: taker,
                    paymentMethod: METHOD,
                    fiatCurrency: USD,
                    conversionRate: CONVERSION_RATE,
                    referralFees: _emptyReferralFees(),
                    gatingServiceSignature: "",
                    signatureExpiration: 0,
                    postIntentHook: IPostIntentHookV2(address(0)),
                    preIntentHookData: "",
                    data: ""
                })
                );
        }
    }

    function _proof(bytes32 intentHash, bytes32 paymentId) internal view returns (bytes memory) {
        bytes memory data = abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5_000, USD, block.timestamp * 1000, paymentId),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash, INTENT_AMOUNT, METHOD, USD, PAYEE, CONVERSION_RATE, block.timestamp, 0
            )
        );
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                predecessor.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                        intentHash,
                        INTENT_AMOUNT,
                        dataHash
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifierV3.PaymentAttestation(intentHash, INTENT_AMOUNT, dataHash, signatures, data, "")
        );
    }
}
