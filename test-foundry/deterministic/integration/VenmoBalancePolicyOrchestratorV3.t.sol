// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {VenmoBalancePolicy} from "contracts/hooks/VenmoBalancePolicy.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract VenmoBalancePolicyOrchestratorV3Test is OrchestratorV3Fixture {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant POLICY = keccak256("venmo_balance");
    bytes32 internal constant PAYMENT_ID = keccak256("canonical-venmo-payment-id");
    uint64 internal constant RISK_WINDOW = 14 days;

    StakeVault internal vault;
    DisputeProtectionPolicy internal protection;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV3 internal upv;
    NullifierRegistryV2 internal nullifiers;
    VenmoBalancePolicy internal policy;
    IntentLifecycleHookV1 internal oldHook;

    function setUp() public override {
        vm.warp(1_000_000);
        super.setUp();
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        upv = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifiers, witnesses);
        upv.addPaymentMethod(METHOD);
        nullifiers.addWritePermission(address(upv));
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(upv), currencies);

        vault = new StakeVault(address(this), token, address(0), 1 days);
        NullifierRegistry disputeNullifiers = new NullifierRegistry();
        protection = new DisputeProtectionPolicy(
            address(this), vault, new DisputeVerifier(address(this), nullifiers, witnesses), disputeNullifiers
        );
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        protection.setRiskWindow(METHOD, RISK_WINDOW);
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(oldHook), true);

        policy = new VenmoBalancePolicy(upv, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(policy), true);
        upv.setAttestationVerifier(address(policy));
        orchestrator.setLifecycleHook(policy);
    }

    function test_BalanceSettlesWithoutStakeUsingSameVerifierAndNullifier() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        assertEq(vault.lockedStake(taker), 0);
        assertEq(policy.balanceIntentOrchestrator(intentHash), address(orchestrator));
        assertEq(orchestrator.getIntent(intentHash).paymentMethod, METHOD);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertTrue(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(policy.balanceIntentOrchestrator(intentHash), address(0));
        assertEq(uint256(protection.getDisputeProtectionIntent(intentHash).status), 0);
    }

    function test_OrdinaryVenmoKeeps448ByteProofAndFourteenDayStake() public {
        _stake();
        bytes32 intentHash = _signalDefault();
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(_data(intentHash, PAYMENT_ID, "").length, 448);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, ""));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(intentHash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_ExistingIntentRetainsOldHookAndProofAfterInstallation() public {
        orchestrator.setLifecycleHook(oldHook);
        upv.setAttestationVerifier(address(witnesses));
        _stake();
        bytes32 intentHash = _signalDefault();
        bytes memory proof = _proof(intentHash, PAYMENT_ID, "");
        upv.setAttestationVerifier(address(policy));
        orchestrator.setLifecycleHook(policy);
        _settle(intentHash, proof);
        assertEq(protection.getDisputeProtectionIntent(intentHash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_BalanceDisabledByDefaultAndOnlyDepositorCanEnable() public {
        vm.expectRevert("VBP: Balance disabled");
        _signalCall(taker, _balanceParams());
        vm.prank(delegate);
        vm.expectRevert("VBP: Only depositor");
        policy.setBalanceEnabled(address(escrow), depositId, true);
        vm.expectRevert("VBP: Invalid escrow");
        policy.setBalanceEnabled(address(0xBAD), depositId, true);
    }

    function test_DisablingOfferDoesNotChangePendingIntent() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        _enable(false);
        vm.expectRevert("VBP: Balance disabled");
        _signalCall(taker, _balanceParams());
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
    }

    function test_OrdinaryProofCannotSettleBalanceIntentOrConsumeNullifier() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        bytes memory proof = _proof(intentHash, PAYMENT_ID, "");
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(policy.balanceIntentOrchestrator(intentHash), address(orchestrator));
    }

    function test_UnknownOrOversizedSignedPolicyRejected() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        bytes memory proof = _proof(intentHash, PAYMENT_ID, abi.encode(keccak256("other-policy")));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
        proof = _proof(intentHash, PAYMENT_ID, abi.encode(POLICY, POLICY));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
    }

    function test_UnsignedPolicyAppendAndRemovalRejected() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
            abi.decode(_proof(intentHash, PAYMENT_ID, ""), (UnifiedPaymentVerifierV3.PaymentAttestation));
        attestation.data = bytes.concat(attestation.data, abi.encode(POLICY));
        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _settle(intentHash, abi.encode(attestation));

        _stake();
        bytes32 ordinary = _signalDefault();
        attestation =
            abi.decode(_proof(ordinary, PAYMENT_ID, abi.encode(POLICY)), (UnifiedPaymentVerifierV3.PaymentAttestation));
        attestation.data = _data(ordinary, PAYMENT_ID, "");
        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _settle(ordinary, abi.encode(attestation));
    }

    function test_ReplayBetweenOrdinaryAndBalanceRejectedBothDirections() public {
        _enable(true);
        _stake();
        bytes32 ordinary = _signalDefault();
        _settle(ordinary, _proof(ordinary, PAYMENT_ID, ""));
        bytes32 balance = _signalBalance();
        bytes memory proof = _proof(balance, PAYMENT_ID, abi.encode(POLICY));
        vm.expectRevert("Nullifier has already been used");
        _settle(balance, proof);
        bytes32 secondPayment = keccak256("second-payment");
        _settle(balance, _proof(balance, secondPayment, abi.encode(POLICY)));
        ordinary = _signalDefault();
        proof = _proof(ordinary, secondPayment, "");
        vm.expectRevert("Nullifier has already been used");
        _settle(ordinary, proof);
    }

    function test_OriginalWitnessThresholdStillApplies() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        witnesses.addWitness(vm.addr(0xB0B));
        witnesses.setRequiredSignatures(2);
        bytes memory proof = _proof(intentHash, PAYMENT_ID, abi.encode(POLICY));
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        _settle(intentHash, proof);
    }

    function test_CancellationClearsBalanceEnrollmentAndUnlocksEscrow() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(policy.balanceIntentOrchestrator(intentHash), address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_VerifierRollbackBlocksBalanceSignalAndSettlementButAllowsManualRelease() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        upv.setAttestationVerifier(address(witnesses));
        vm.expectRevert("VBP: Verifier not installed");
        _signalCall(taker, _balanceParams());
        bytes memory ordinaryProof = _proof(intentHash, PAYMENT_ID, "");
        vm.expectRevert("VBP: Verifier not installed");
        _settle(intentHash, ordinaryProof);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(policy.balanceIntentOrchestrator(intentHash), address(0));
    }

    function test_BalanceRequiresDirectPayoutAndPreservesWhitelist() public {
        _enable(true);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(POLICY);
        params.postIntentHook = postIntentHook;
        vm.expectRevert("VBP: Only direct payout");
        _signalCall(taker, params);
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV1.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker
            )
        );
        _signalCall(taker, _balanceParams());
        address[] memory allowed = new address[](1);
        allowed[0] = taker;
        vm.prank(depositor);
        whitelist.addWhitelistedAddresses(address(escrow), depositId, allowed);
        _signalBalance();
    }

    function test_OrdinaryPostHookDataAndStakeRemainUnchanged() public {
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = hex"123456";
        bytes32 intentHash = _signal(taker, params);
        assertEq(orchestrator.getIntent(intentHash).data, params.data);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_ForeignOrchestratorCannotClearBalanceEnrollment() public {
        _enable(true);
        bytes32 intentHash = _signalBalance();
        vm.prank(address(orchestratorMock));
        vm.expectRevert("VBP: Foreign intent");
        policy.onIntentCancelled(intentHash);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        policy.onIntentCancelled(intentHash);
    }

    function _enable(bool enabled) internal {
        vm.prank(depositor);
        policy.setBalanceEnabled(address(escrow), depositId, enabled);
    }

    function _stake() internal {
        token.transfer(taker, 500e6);
        vm.startPrank(taker);
        token.approve(address(vault), 500e6);
        vault.depositStake(500e6);
        vm.stopPrank();
    }

    function _signalBalance() internal returns (bytes32) {
        return _signal(taker, _balanceParams());
    }

    function _balanceParams() internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _defaultParams();
        params.data = abi.encode(POLICY);
    }

    function _data(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        return bytes.concat(
            abi.encode(
                UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId),
                UnifiedPaymentVerifierV3.IntentSnapshot(
                    intentHash, intent.amount, METHOD, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
                )
            ),
            suffix
        );
    }

    function _proof(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        bytes memory data = _data(intentHash, paymentId, suffix);
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                upv.DOMAIN_SEPARATOR(),
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

    function _settle(bytes32 intentHash, bytes memory proof) internal {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
