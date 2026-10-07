// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract StakePoliciesTest is OrchestratorV3Fixture {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant MARKER = keccak256("payment_policy");
    bytes32 internal constant POLICY = keccak256("venmo_balance");
    bytes32 internal constant GOODS_POLICY = keccak256("venmo_goods_and_services");
    bytes32 internal constant PERSONAL = keccak256("venmo_personal");
    bytes32 internal constant PAYPAL_PERSONAL = keccak256("paypal_personal");
    bytes32 internal constant PAYPAL_GOODS = keccak256("paypal_goods_and_services");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant PAYMENT_ID = keccak256("canonical-venmo-payment-id");
    uint64 internal constant RISK_WINDOW = 14 days;

    StakeVault internal vault;
    DisputeProtectionPolicy internal predecessor;
    DisputeProtectionPolicyV2 internal protection;
    NullifierRegistry internal disputeNullifiers;
    DisputeVerifier internal disputeVerifier;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV3 internal upv;
    NullifierRegistryV2 internal nullifiers;
    IntentLifecycleHookV2 internal policy;
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
        disputeNullifiers = new NullifierRegistry();
        disputeVerifier = new DisputeVerifier(address(this), nullifiers, witnesses);
        predecessor = new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeNullifiers);
        protection =
            new DisputeProtectionPolicyV2(address(this), vault, disputeVerifier, disputeNullifiers, predecessor);
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        protection.setRiskWindow(METHOD, RISK_WINDOW);
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, predecessor);
        predecessor.setLifecycleHookAuthorization(address(oldHook), true);
        policy = new IntentLifecycleHookV2(orchestratorRegistry, whitelist, protection);
        policy.initializePaymentVerifier(upv);
        policy.setPolicy(POLICY, METHOD, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 0, true);
        policy.setPolicy(GOODS_POLICY, METHOD, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 90 days, false);
        policy.setPolicy(PERSONAL, METHOD, IntentLifecycleHookV2.PolicyKind.DEFAULT, 0, false);
        protection.setLifecycleHookAuthorization(address(policy), true);
        upv.setAttestationVerifier(address(policy));
        orchestrator.setLifecycleHook(policy);
    }

    // Each matrix row executes the real O3 -> UPV3 -> witness checker -> hook -> DPP -> vault boundary.
    function testFuzz_FulfillmentMatrix(uint8 initial, uint8 proofKind, bool sponsored) public {
        initial = uint8(bound(initial, 0, 3));
        proofKind = uint8(bound(proofKind, 0, 2));
        address stakeOwner = sponsored ? other : taker;
        token.transfer(stakeOwner, 100e6);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), 100e6);
        vault.depositStake(100e6);
        if (sponsored) vault.setTakerAuthorization(taker, true);
        vm.stopPrank();
        if (sponsored) {
            vm.prank(taker);
            vault.selectStakeOwner(other);
        }
        bytes32 hash = initial == 0 ? _signalBalance() : _signalDefault();
        if (initial == 2) _select(hash, GOODS_POLICY);
        if (initial == 3) _select(hash, POLICY);
        bytes32 tag = proofKind == 0 ? PERSONAL : proofKind == 1 ? GOODS_POLICY : POLICY;
        (bytes32 selected,) = policy.policyIntents(hash);
        if (tag != selected) _select(hash, tag);
        bool staked = initial != 0 || proofKind != 2;
        assertEq(vault.lockedStake(stakeOwner), staked ? INTENT_AMOUNT : 0);
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(tag));
        vm.prank(other); // fulfillment is permissionless
        _settle(hash, proof);
        uint64 window = proofKind == 0 ? RISK_WINDOW : proofKind == 1 ? uint64(90 days) : 0;
        IDisputeProtectionPolicy.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(hash);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(stakeOwner), staked && window > 0 ? INTENT_AMOUNT : 0);
        assertEq(vault.freeStake(stakeOwner), staked && window > 0 ? 100e6 - INTENT_AMOUNT : 100e6);
        if (staked) {
            assertEq(record.stakeOwner, stakeOwner);
            assertEq(record.riskWindow, RISK_WINDOW);
            assertEq(record.releaseEligibleAt, block.timestamp + window);
            assertEq(
                uint256(record.status),
                uint256(
                    window == 0
                        ? IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED
                        : IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED
                )
            );
        } else {
            assertEq(uint256(record.status), 0);
        }
        assertEq(_intentOrchestrator(hash), address(0));
        assertTrue(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
    }

    function test_PayPalPersonalAndGoods() public {
        _addPaymentMethod(PAYPAL);
        protection.setRiskWindow(PAYPAL, RISK_WINDOW);
        policy.setPolicy(PAYPAL_PERSONAL, PAYPAL, IntentLifecycleHookV2.PolicyKind.DEFAULT, 0, false);
        policy.setPolicy(PAYPAL_GOODS, PAYPAL, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 90 days, false);
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.paymentMethod = PAYPAL;
        bytes32 hash = _signal(taker, params);
        (bytes32 selected,) = policy.policyIntents(hash);
        assertEq(selected, PAYPAL_PERSONAL);
        _select(hash, PAYPAL_GOODS);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(PAYPAL_GOODS)));
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + 90 days);
        hash = _signal(taker, params);
        _settle(hash, _proof(hash, keccak256("second-payment"), abi.encode(PAYPAL_PERSONAL)));
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_LateStakeSnapshotsCurrentDefaultOnceAndNeverRelocks() public {
        bytes32 hash = _signalBalance();
        protection.setRiskWindow(METHOD, 21 days);
        _stake();
        _select(hash, GOODS_POLICY);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(protection.getDisputeProtectionIntent(hash).riskWindow, 21 days);
        _select(hash, POLICY);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        protection.setRiskWindow(METHOD, 7 days);
        protection.setAdmissionsPaused(true);
        _setDisputeProtection(false);
        _select(hash, PERSONAL);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(PERSONAL)));
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + 21 days);
    }

    function test_PartialPositiveSettlementAndZeroSettlement() public {
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.amount = 100e6;
        bytes32 hash = _signal(taker, params);
        _select(hash, GOODS_POLICY);
        _settle(hash, _signedProof(hash, _data(hash, PAYMENT_ID, abi.encode(GOODS_POLICY)), 60e6, WITNESS_KEY));
        assertEq(vault.lockedStake(taker), 60e6);
        assertEq(vault.freeStake(taker), 440e6);
        hash = _signal(taker, params);
        _select(hash, POLICY);
        vm.recordLogs();
        _settle(
            hash, _signedProof(hash, _data(hash, keccak256("second-payment"), abi.encode(POLICY)), 60e6, WITNESS_KEY)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool settled;
        bool released;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(protection)) continue;
            if (
                logs[i].topics[0]
                    == keccak256("DisputeProtectionIntentSettled(bytes32,address,address,uint256,uint64,bool)")
            ) settled = true;
            if (logs[i].topics[0] == keccak256("DisputeProtectionIntentReleased(bytes32,address,uint256)")) {
                released = true;
                assertEq(abi.decode(logs[i].data, (uint256)), 100e6);
            }
        }
        assertTrue(settled && released);
        assertEq(vault.lockedStake(taker), 60e6);
        assertEq(vault.freeStake(taker), 440e6);
    }

    function test_ManualReleaseUsesSavedDefaultEvenWhenZeroSelected() public {
        _stake();
        bytes32 hash = _signalDefault();
        _select(hash, POLICY);
        protection.setRiskWindow(METHOD, 21 days);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(hash);
        assertEq(protection.getDisputeProtectionIntent(hash).releaseEligibleAt, block.timestamp + RISK_WINDOW);
    }

    function test_CancelWithZeroSelectedUnlocksExistingStake() public {
        _stake();
        bytes32 hash = _signalDefault();
        _select(hash, POLICY);
        vm.prank(taker);
        orchestrator.cancelIntent(hash);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(_intentOrchestrator(hash), address(0));
    }

    function test_AdmissionPauseOptOutAndZeroDefaultBlockLateStake() public {
        _stake();
        bytes32 hash = _signalBalance();
        protection.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _select(hash, PERSONAL);
        protection.setAdmissionsPaused(false);
        _setDisputeProtection(false);
        vm.expectRevert("ILH: Dispute protection disabled");
        _select(hash, PERSONAL);
        _setDisputeProtection(true);
        protection.setRiskWindow(METHOD, 0);
        vm.expectRevert("ILH: Dispute protection disabled");
        _select(hash, GOODS_POLICY);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_SelectionRequiresOwnerLiveOriginHookAndDifferentKnownPolicy() public {
        _stake();
        bytes32 hash = _signalDefault();
        vm.prank(other);
        vm.expectRevert("ILH: Only intent owner");
        policy.selectPaymentPolicy(hash, GOODS_POLICY);
        vm.expectRevert("ILH: Policy unchanged");
        _select(hash, PERSONAL);
        vm.expectRevert("ILH: Unknown policy");
        _select(hash, keccak256("unknown"));
        policy.setPolicy(PAYPAL_GOODS, PAYPAL, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 90 days, false);
        vm.expectRevert("ILH: Policy method mismatch");
        _select(hash, PAYPAL_GOODS);
        orchestratorRegistry.removeOrchestrator(address(orchestrator));
        vm.expectRevert("ILH: Unregistered origin");
        _select(hash, GOODS_POLICY);
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        vm.mockCall(
            address(orchestrator),
            abi.encodeWithSelector(IOrchestratorV3.getIntentLifecycleHook.selector, hash),
            abi.encode(oldHook)
        );
        vm.expectRevert("ILH: Wrong intent hook");
        _select(hash, GOODS_POLICY);
        vm.clearMockedCalls();
        vm.prank(taker);
        orchestrator.cancelIntent(hash);
        vm.expectRevert("ILH: No policy intent");
        _select(hash, GOODS_POLICY);
    }

    function test_ProofRejectsMissingUnknownWrongTagLengthSignerAndTampering() public {
        _stake();
        bytes32 hash = _signalDefault();
        bytes memory proof = _proof(hash, PAYMENT_ID, "");
        vm.expectRevert("UPV: Invalid attestation");
        _settle(hash, proof);
        proof = _proof(hash, PAYMENT_ID, abi.encode(GOODS_POLICY));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(hash, proof);
        proof = _proof(hash, PAYMENT_ID, abi.encode(keccak256("unknown")));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(hash, proof);
        proof = _proof(hash, PAYMENT_ID, abi.encode(PERSONAL, PERSONAL));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(hash, proof);
        proof = _signedProof(hash, _data(hash, PAYMENT_ID, abi.encode(PERSONAL)), INTENT_AMOUNT, 0xBAD);
        vm.expectRevert();
        _settle(hash, proof);
        UnifiedPaymentVerifierV3.PaymentAttestation memory a =
            abi.decode(_proof(hash, PAYMENT_ID, abi.encode(PERSONAL)), (UnifiedPaymentVerifierV3.PaymentAttestation));
        a.data = _data(hash, PAYMENT_ID, abi.encode(GOODS_POLICY));
        vm.expectRevert();
        _settle(hash, abi.encode(a));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
    }

    function test_PolicyRulesImmutableAndAdmissionToggleDoesNotBlockSelections() public {
        vm.expectRevert("ILH: Policy terms immutable");
        policy.setPolicy(GOODS_POLICY, METHOD, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 1 days, false);
        vm.expectRevert("ILH: Invalid default policy");
        policy.setPolicy(keccak256("second-default"), METHOD, IntentLifecycleHookV2.PolicyKind.DEFAULT, 0, false);
        vm.expectRevert("ILH: Invalid no-stake policy");
        policy.setPolicy(PERSONAL, METHOD, IntentLifecycleHookV2.PolicyKind.DEFAULT, 0, true);
        bytes32 hash = _signalBalance();
        policy.setPolicy(POLICY, METHOD, IntentLifecycleHookV2.PolicyKind.OVERRIDE, 0, false);
        vm.expectRevert("ILH: Admissions disabled");
        _signalCall(taker, _balanceParams());
        _stake();
        _select(hash, PERSONAL);
        _select(hash, POLICY);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_NoStakeEnvelopeRequiresDirectProtectedWhitelistedRoute() public {
        IOrchestratorV3.SignalIntentParams memory params = _balanceParams();
        params.postIntentHook = postIntentHook;
        vm.expectRevert("ILH: Only direct payout");
        _signalCall(taker, params);
        params = _balanceParams();
        params.data = abi.encode(MARKER);
        vm.expectRevert("ILH: Invalid policy envelope");
        _signalCall(taker, params);
        params.data = abi.encode(MARKER, POLICY, POLICY);
        vm.expectRevert("ILH: Invalid policy envelope");
        _signalCall(taker, params);
        params.data = abi.encode(MARKER, GOODS_POLICY);
        vm.expectRevert("ILH: Not a zero policy");
        _signalCall(taker, params);
        _setDisputeProtection(false);
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, _balanceParams());
    }

    function test_StakedPostHookBalanceWorksAndHookFailureRollsBackUnlock() public {
        _stake();
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(other);
        bytes32 hash = _signal(taker, params);
        _select(hash, POLICY);
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(POLICY));
        vm.mockCallRevert(address(postIntentHook), bytes(""), "payout failed");
        vm.expectRevert();
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(_intentOrchestrator(hash), address(orchestrator));
        vm.clearMockedCalls();
        _settle(hash, proof);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_ChangedVerifierCannotBypassSelectionOrSettlement() public {
        _stake();
        bytes32 hash = _signalDefault();
        bytes memory proof = _proof(hash, PAYMENT_ID, abi.encode(PERSONAL));
        upv.setAttestationVerifier(address(witnesses));
        vm.expectRevert("ILH: Verifier not installed");
        _select(hash, GOODS_POLICY);
        vm.expectRevert("ILH: Verifier not installed");
        _settle(hash, proof);
        upv.setAttestationVerifier(address(policy));
        _setMethodVerifier(METHOD, address(verifier));
        vm.expectRevert("ILH: Wrong payment verifier");
        _select(hash, GOODS_POLICY);
    }

    function test_ZeroWindowValidatesAmountAndOnlyAuthorizedHookCanSettle() public {
        _stake();
        bytes32 hash = _signalDefault();
        vm.expectRevert();
        protection.onIntentSettledWithWindow(hash, 1, 0);
        vm.prank(address(policy));
        vm.expectRevert("DPP: Invalid settlement amount");
        protection.onIntentSettledWithWindow(hash, 0, 0);
        vm.prank(address(policy));
        vm.expectRevert("DPP: Invalid settlement amount");
        protection.onIntentSettledWithWindow(hash, INTENT_AMOUNT + 1, 0);
    }

    function test_OldUnprotectedTaggedProofSurvivesCutoverAndWhitelistBypassStaysUnstaked() public {
        predecessor.setRiskWindow(METHOD, 0);
        orchestrator.setLifecycleHook(oldHook);
        bytes32 hash = _signalDefault();
        orchestrator.setLifecycleHook(policy);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(PERSONAL)));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        address[] memory allowed = new address[](1);
        allowed[0] = taker;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), allowed);
        hash = _signalDefault();
        assertEq(_intentOrchestrator(hash), address(0));
        assertEq(vault.lockedStake(taker), 0);
        _settle(hash, _proof(hash, keccak256("second-payment"), abi.encode(PERSONAL)));
    }

    function test_WhitelistRejectsExplicitBalanceButOrdinaryStakeRemainsAvailable() public {
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV2.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker
            )
        );
        _signalCall(taker, _balanceParams());
        _stake();
        bytes32 hash = _signalDefault();
        _select(hash, POLICY);
        _settle(hash, _proof(hash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_SponsorRevocationAffectsLateAdmissionButNotExistingLock() public {
        token.transfer(other, 100e6);
        vm.startPrank(other);
        token.approve(address(vault), 100e6);
        vault.depositStake(100e6);
        vault.setTakerAuthorization(taker, true);
        vm.stopPrank();
        vm.prank(taker);
        vault.selectStakeOwner(other);
        bytes32 staked = _signalDefault();
        bytes32 late = _signalBalance();
        vm.prank(other);
        vault.setTakerAuthorization(taker, false);
        vm.expectRevert();
        _select(late, PERSONAL);
        _select(staked, GOODS_POLICY);
        _settle(staked, _proof(staked, PAYMENT_ID, abi.encode(GOODS_POLICY)));
        assertEq(protection.getDisputeProtectionIntent(staked).stakeOwner, other);
        assertEq(vault.lockedStake(other), INTENT_AMOUNT);
    }

    function test_AdoptionRetainsDeadlineOwnerAmountAndTerminalLocalState() public {
        _usePredecessor();
        _stake();
        bytes32 hash = _signalDefault();
        _settle(hash, _signedProof(hash, _data(hash, PAYMENT_ID, ""), 30e6, WITNESS_KEY));
        IDisputeProtectionPolicy.DisputeProtectionIntent memory original = predecessor.getDisputeProtectionIntent(hash);
        _handover();
        assertEq(keccak256(abi.encode(protection.getDisputeProtectionIntent(hash))), keccak256(abi.encode(original)));
        vm.expectRevert();
        protection.releaseMaturedDisputeProtectionIntent(hash);
        vm.warp(original.releaseEligibleAt);
        protection.releaseMaturedDisputeProtectionIntent(hash);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), 500e6);
        assertEq(
            uint256(protection.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED)
        );
        assertEq(
            uint256(predecessor.getDisputeProtectionIntent(hash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        vm.expectRevert();
        protection.releaseMaturedDisputeProtectionIntent(hash);
        IDisputeVerifier.DisputeAttestation memory evidence = _dispute(hash, PAYMENT_ID);
        vm.expectRevert();
        protection.submitDispute(evidence);
    }

    function test_AdoptedDisputeCreatesClaimAndPreservesExistingClaimsAndDelegation() public {
        _usePredecessor();
        _stake();
        bytes32 first = _signalDefault();
        _settle(first, _proof(first, PAYMENT_ID, ""));
        predecessor.submitDispute(_dispute(first, PAYMENT_ID));
        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        bytes32 second = _signalDefault();
        bytes32 secondPayment = keccak256("second-payment");
        _settle(second, _proof(second, secondPayment, ""));
        _handover();
        uint64 deadline = protection.getDisputeProtectionIntent(second).releaseEligibleAt;
        vm.warp(deadline + 1); // Elapsed maturity does not remove dispute eligibility.
        protection.submitDispute(_dispute(second, secondPayment));
        assertEq(vault.claimable(depositor), INTENT_AMOUNT * 2);
        assertEq(vault.lockedStake(taker), 0);
        IDisputeVerifier.DisputeAttestation memory evidence = _dispute(second, secondPayment);
        vm.expectRevert();
        protection.submitDispute(evidence);
        vm.expectRevert();
        protection.releaseMaturedDisputeProtectionIntent(second);
        uint256 beforeBalance = token.balanceOf(depositor);
        vm.prank(depositor);
        vault.claim();
        assertEq(token.balanceOf(depositor), beforeBalance + INTENT_AMOUNT * 2);
    }

    function test_AdoptionRejectsPendingAndMismatchedLockWithoutImporting() public {
        _usePredecessor();
        _stake();
        bytes32 pending = _signalDefault();
        bytes32 settled = _signalDefault();
        _settle(settled, _proof(settled, PAYMENT_ID, ""));
        vm.prank(address(predecessor));
        vault.resizeLock(settled, 1, uint64(block.timestamp + 1 days));
        _handover();
        vm.expectRevert();
        protection.releaseMaturedDisputeProtectionIntent(pending);
        vm.expectRevert("DPP: Predecessor lock mismatch");
        protection.releaseMaturedDisputeProtectionIntent(settled);
        vm.prank(address(policy));
        vm.expectRevert();
        protection.onIntentSettledWithWindow(pending, INTENT_AMOUNT, 0);
        vm.prank(address(policy));
        protection.onIntentCancelled(settled); // no local state may be imported here
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT + 1);
    }

    function _usePredecessor() internal {
        vault.proposeController(address(predecessor));
        vm.warp(block.timestamp + vault.controllerChangeDelay());
        predecessor.acceptVaultController();
        predecessor.setRiskWindow(METHOD, RISK_WINDOW);
        disputeNullifiers.addWritePermission(address(predecessor));
        orchestrator.setLifecycleHook(oldHook);
        upv.setAttestationVerifier(address(witnesses));
    }

    function _handover() internal {
        predecessor.setAdmissionsPaused(true);
        vault.proposeController(address(protection));
        vm.warp(block.timestamp + vault.controllerChangeDelay());
        protection.acceptVaultController();
        upv.setAttestationVerifier(address(policy));
        orchestrator.setLifecycleHook(policy);
        disputeNullifiers.removeWritePermission(address(predecessor));
    }

    function _dispute(bytes32 hash, bytes32 paymentId)
        internal
        view
        returns (IDisputeVerifier.DisputeAttestation memory a)
    {
        bytes memory data =
            abi.encode(IDisputeVerifier.DisputeDetails(METHOD, paymentId, keccak256(abi.encode(paymentId)), 5000, USD));
        a = IDisputeVerifier.DisputeAttestation(hash, keccak256(data), new bytes[](1), data);
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(WITNESS_KEY, disputeVerifier.hashDisputeAttestation(a));
        a.signatures[0] = abi.encodePacked(r, ss, v);
    }

    function test_ServiceSignedProofSmoke() public {
        string memory attestor = vm.envOr("ATTESTOR_POLICY_SMOKE_ROOT", string(""));
        if (bytes(attestor).length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(block.chainid, 31337);
        _stake();
        string[3] memory modes = [string("personal"), "goods", "balance"];
        for (uint256 i; i < modes.length; i++) {
            bytes32 hash = _signalDefault();
            IOrchestratorV3.Intent memory intent = orchestrator.getIntent(hash);
            string[] memory command = new string[](11);
            command[0] = "node";
            command[1] = string.concat(attestor, "/node_modules/tsx/dist/cli.mjs");
            command[2] = "--tsconfig";
            command[3] = string.concat(attestor, "/tsconfig.json");
            command[4] = string.concat(attestor, "/scripts/stake-policy-smoke.ts");
            command[5] = vm.toString(address(upv));
            command[6] = vm.toString(hash);
            command[7] = vm.toString(intent.amount);
            command[8] = vm.toString(intent.timestamp);
            command[9] = modes[i];
            command[10] = vm.toString(i);
            bytes memory proof = vm.ffi(command);
            UnifiedPaymentVerifierV3.PaymentAttestation memory a =
                abi.decode(proof, (UnifiedPaymentVerifierV3.PaymentAttestation));
            assertEq(a.data.length, 480);
            (,, bytes32 tag) = abi.decode(
                a.data, (UnifiedPaymentVerifierV3.PaymentDetails, UnifiedPaymentVerifierV3.IntentSnapshot, bytes32)
            );
            (bytes32 current,) = policy.policyIntents(hash);
            if (current != tag) _select(hash, tag);
            _settle(hash, proof);
            assertEq(a.releaseAmount, i == 1 ? 45e6 : 50e6);
            assertEq(
                protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
                block.timestamp + (i == 0 ? RISK_WINDOW : i == 1 ? 90 days : 0)
            );
        }
        assertEq(token.balanceOf(taker), 145e6);
        assertEq(vault.lockedStake(taker), 95e6);
    }

    function _setMethodVerifier(bytes32 method, address newVerifier) internal {
        paymentVerifierRegistry.removePaymentMethod(method);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(method, newVerifier, currencies);
    }

    function _addPaymentMethod(bytes32 method) internal {
        upv.addPaymentMethod(method);
        bytes32[] memory supportedCurrencies = new bytes32[](1);
        supportedCurrencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(method, address(upv), supportedCurrencies);
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = method;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] = IEscrowV2.DepositPaymentMethodData(address(0), PAYEE, "");
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency(USD, CONVERSION_RATE, _emptyOracle());
        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, methods, methodData, currencies);
    }

    function _intentOrchestrator(bytes32 intentHash) internal view returns (address origin) {
        (, origin) = policy.policyIntents(intentHash);
    }

    function _setDisputeProtection(bool enabled) internal {
        vm.prank(depositor);
        protection.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, enabled);
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
        params.data = abi.encode(MARKER, POLICY);
    }

    function _data(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        return bytes.concat(
            abi.encode(
                UnifiedPaymentVerifierV3.PaymentDetails(
                    intent.paymentMethod, PAYEE, 5000, USD, block.timestamp * 1000, paymentId
                ),
                UnifiedPaymentVerifierV3.IntentSnapshot(
                    intentHash, intent.amount, intent.paymentMethod, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
                )
            ),
            suffix
        );
    }

    function _proof(bytes32 intentHash, bytes32 paymentId, bytes memory suffix) internal view returns (bytes memory) {
        return _signedProof(intentHash, _data(intentHash, paymentId, suffix), INTENT_AMOUNT, WITNESS_KEY);
    }

    function _signedProof(bytes32 hash, bytes memory data, uint256 amount, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                upv.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                        hash,
                        amount,
                        dataHash
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(UnifiedPaymentVerifierV3.PaymentAttestation(hash, amount, dataHash, signatures, data, ""));
    }

    function _select(bytes32 hash, bytes32 tag) internal {
        vm.prank(taker);
        policy.selectPaymentPolicy(hash, tag);
    }

    function _settle(bytes32 intentHash, bytes memory proof) internal {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
