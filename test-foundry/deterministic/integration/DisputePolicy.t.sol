// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputePolicyFixture} from "../helpers/DisputePolicyFixture.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NullifyingPaymentVerifierMock} from "contracts/mocks/NullifyingPaymentVerifierMock.sol";

contract PolicyPostIntentHook is IPostIntentHookV2 {
    function execute(HookExecutionContext calldata ctx, bytes calldata) external override {
        address recipient = abi.decode(ctx.intent.signalHookData, (address));
        IERC20(ctx.token).transferFrom(msg.sender, recipient, ctx.executableAmount);
    }
}

contract DisputePolicyTest is DisputePolicyFixture {
    function test_ZeroWindowUsesV3AndSharedPaymentBindingWithoutStake() public {
        bytes32 intentHash = _bypass();
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, 0);
        assertEq(policy.getPolicyIntent(intentHash).stakeOwner, address(0));
        assertEq(vault.lockedStake(taker), 0);
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(intentHash, address(0), depositor, INTENT_AMOUNT, 0, false);
        _complete(intentHash, att);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, PAYMENT));
        assertEq(payments.nullifierByIntentHash(intentHash), nullifier);
        assertEq(payments.intentHashByNullifier(nullifier), intentHash);
        assertEq(policy.getPolicyIntent(intentHash).releaseAmount, INTENT_AMOUNT);
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, 0);
    }

    function test_GenericRuleAppliesWithoutMakerConfiguration() public {
        policy.setPolicy(METHOD, SECOND_POLICY, 0, true);
        bytes32 intentHash = _signalPolicy(SECOND_POLICY);
        _complete(intentHash, _attestation(intentHash, PAYMENT, SECOND_POLICY, INTENT_AMOUNT));
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
    }

    function test_OrdinaryAttestationCannotSettleBypass() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_BalanceAttestationCannotSettleProtectedOrOpenOrder() public {
        _stake(INTENT_AMOUNT);
        bytes32 protectedIntent = _signalDefault();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(protectedIntent, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(protectedIntent, att);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.prank(depositor);
        policy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        bytes32 openIntent = _signalDefault();
        att = _attestation(openIntent, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(openIntent, att);
        _complete(openIntent, _attestation(openIntent, PAYMENT, bytes32(0), INTENT_AMOUNT));
    }

    function test_EachOrderSuppliesItsPolicyWithoutChangingEarlierOrders() public {
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _bypass();
        bytes32 ordinary = _signalDefault();
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        assertEq(policy.getPolicyIntent(ordinary).policyId, bytes32(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        _complete(ordinary, _attestation(ordinary, keccak256("ordinary"), bytes32(0), INTENT_AMOUNT));
    }

    function test_DisableRuleOnlyAffectsNewAdmissions() public {
        bytes32 intentHash = _bypass();
        policy.setPolicy(METHOD, POLICY, 0, false);
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(POLICY));
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_RecoveryRequiresActualStakeAndThenOrdinaryProof() public {
        bytes32 intentHash = _bypass();
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, uint256(0), INTENT_AMOUNT)
        );
        policy.adjustPolicy(intentHash, bytes32(0));
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, RISK);
        assertEq(policy.getPolicyIntent(intentHash).policyId, bytes32(0));
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(hook));
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(intentHash, att);
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), 20e6));
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
        assertEq(vault.lockedStake(taker), 20e6);
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + RISK);
        vm.prank(taker);
        vm.expectRevert("DPP: Admission not pending");
        policy.adjustPolicy(intentHash, bytes32(0));
    }

    function test_RecoveryRejectsForeignTakerAndExpiredOrder() public {
        bytes32 intentHash = _bypass();
        vm.prank(other);
        vm.expectRevert("DPP: Not policy taker");
        policy.adjustPolicy(intentHash, bytes32(0));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(taker);
        vm.expectRevert("DPP: Policy intent expired");
        policy.adjustPolicy(intentHash, bytes32(0));
    }

    function test_RecoveryRejectsProtectionOptOut() public {
        bytes32 intentHash = _bypass();
        vm.prank(depositor);
        policy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.PolicyAdmissionDisabled.selector, address(escrow), depositId, METHOD
            )
        );
        policy.adjustPolicy(intentHash, bytes32(0));
    }

    function test_CancelAndManualReleaseWorkWhenProofRouteBreaks() public {
        bytes32 cancelled = _bypass();
        upv.setAttestationVerifier(address(signatures));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        _status(cancelled, IDisputeProtectionPolicy.PolicyIntentStatus.CANCELLED);
        upv.setAttestationVerifier(address(policy));
        bytes32 manual = _bypass();
        upv.setAttestationVerifier(address(signatures));
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(manual, address(0), depositor, INTENT_AMOUNT, 0, true);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(manual);
        _status(manual, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
        assertEq(payments.nullifierByIntentHash(manual), bytes32(0));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_ZeroIntentWindowHasNoCollateralReleasePath() public {
        bytes32 intentHash = _bypass();
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        vm.warp(block.timestamp + RISK);
        bytes memory expected =
            abi.encodeWithSelector(IDisputeProtectionPolicy.DisputeProtectionIntentNotCovered.selector, intentHash);
        vm.expectRevert(expected);
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
        bytes32[] memory batch = new bytes32[](1);
        batch[0] = intentHash;
        vm.expectRevert(expected);
        policy.releaseMaturedDisputeProtectionIntents(batch);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_DefaultZeroWindowStillCreatesSelectedPolicyIntent() public {
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        bytes32 intentHash = _signalPolicy(POLICY);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_GlobalWindowChangeCannotRemovePendingCoverage() public {
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalDefault();
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, RISK);
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + RISK);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_RemovedPolicyCheckerCannotSettleOrdinaryProofAndRollsBackBinding() public {
        bytes32 intentHash = _bypass();
        upv.setAttestationVerifier(address(signatures));
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy checker changed");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_AlternativeVerifierWithRegistryWritePermissionCannotSettle() public {
        bytes32 intentHash = _bypass();
        NullifyingPaymentVerifierMock attackerVerifier = new NullifyingPaymentVerifierMock(payments, METHOD);
        payments.addWritePermission(address(attackerVerifier));
        _route(address(attackerVerifier));
        vm.expectRevert("DPP: Payment route changed");
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        _assertUnsettled(intentHash);
    }

    function test_ExtraRegistryWriterBlocksAdmissionAndVerification() public {
        bytes32 intentHash = _bypass();
        payments.addWritePermission(other);
        vm.expectRevert("DPP: Unsafe payment writers");
        _signalCall(taker, _policyParams(POLICY));
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Unsafe payment writers");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_ExactWireLengthAndSignatureBindPolicyTail() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        assertEq(att.data.length, 480);
        att.data = bytes.concat(att.data, bytes32(0));
        _sign(att);
        vm.expectRevert("DPP: Invalid policy payload");
        _complete(intentHash, att);
        att = _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        assembly { mstore(mload(add(att, 128)), 448) }
        _sign(att);
        vm.expectRevert("DPP: Invalid policy payload");
        _complete(intentHash, att);
        att = _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        att.data[479] ^= bytes1(uint8(1));
        vm.expectRevert("UPV: Data hash mismatch");
        _complete(intentHash, att);
    }

    function test_WrongSignerAndWrongIntentRejectWithoutConsumption() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(0xBAD, _digest(att));
        att.signatures[0] = abi.encodePacked(r, sigS, v);
        vm.expectRevert();
        _complete(intentHash, att);
        bytes32 another = _signalPolicy(POLICY);
        att = _attestation(another, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("UPV: Attestation hash mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_ReplayAcrossPoliciesAndLegacyHistoryRejects() public {
        bytes32 intentHash = _bypass();
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        policy.setPolicy(METHOD, SECOND_POLICY, 0, true);
        bytes32 another = _signalPolicy(SECOND_POLICY);
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(another, PAYMENT, SECOND_POLICY, INTENT_AMOUNT);
        vm.expectRevert("Nullifier has already been used");
        _complete(another, att);
        bytes32 oldPayment = keccak256("legacy-payment");
        legacy.addWritePermission(address(this));
        legacy.addNullifier(keccak256(abi.encodePacked(METHOD, oldPayment)));
        att = _attestation(another, oldPayment, SECOND_POLICY, INTENT_AMOUNT);
        vm.expectRevert("Nullifier has already been used");
        _complete(another, att);
    }

    function test_WhitelistNonMemberCannotUseNoStakeBypass() public {
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), new address[](0));
        vm.expectRevert("DPP: Zero-window whitelist enabled");
        _signalCall(taker, _policyParams(POLICY));
    }

    function test_UnknownPolicyAndUnauthorizedDirectVerificationReject() public {
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(SECOND_POLICY));
        vm.expectRevert("DPP: Unauthorized payment verifier");
        policy.verify(bytes32(0), new bytes[](0), new bytes(480));
    }

    function test_RecoveryRestoresDisputeCompensationButBypassDoesNot() public {
        bytes32 bypass = _bypass();
        _complete(bypass, _attestation(bypass, PAYMENT, POLICY, INTENT_AMOUNT));
        IDisputeVerifier.DisputeAttestation memory disputed = _dispute(bypass, PAYMENT);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.DisputeProtectionIntentNotCovered.selector, bypass)
        );
        policy.submitDispute(disputed);
        assertEq(vault.claimable(depositor), 0);

        bytes32 recovered = _bypass();
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.adjustPolicy(recovered, bytes32(0));
        bytes32 recoveredPayment = keccak256("recovered-payment");
        _complete(recovered, _attestation(recovered, recoveredPayment, bytes32(0), 20e6));
        policy.submitDispute(_dispute(recovered, recoveredPayment));
        assertEq(vault.claimable(depositor), 20e6);
        assertEq(vault.lockedStake(taker), 0);
        _status(recovered, IDisputeProtectionPolicy.PolicyIntentStatus.DISPUTED);
    }

    function test_SnapshottedHookRequiredBeforeAndAfterRecovery() public {
        bytes32 intentHash = _bypass();
        IntentLifecycleHookV1 anotherHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, policy);
        policy.setLifecycleHookAuthorization(address(anotherHook), true);
        vm.prank(address(anotherHook));
        vm.expectRevert("DPP: Wrong admission hook");
        policy.onIntentSettled(address(orchestrator), intentHash, INTENT_AMOUNT, true);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        vm.prank(address(anotherHook));
        vm.expectRevert("DPP: Wrong admission hook");
        policy.onIntentCancelled(address(orchestrator), intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        // Rotating the default hook does not move an already admitted order.
        orchestrator.setLifecycleHook(anotherHook);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.CANCELLED);
    }

    function test_PauseBlocksRecoveryButKeepsBypassFulfillmentAvailable() public {
        bytes32 intentHash = _bypass();
        policy.setAdmissionsPaused(true);
        vm.prank(taker);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        policy.adjustPolicy(intentHash, bytes32(0));
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_PolicyAndRouteIdentitiesCannotBeRewritten() public {
        policy.setPolicy(METHOD, POLICY, 0, true);
        vm.expectRevert("DPP: Route already registered");
        policy.registerPolicyRoute(address(orchestrator), address(upv), address(signatures));
    }

    function test_PolicyIdsAreScopedToPaymentMethod() public {
        bytes32 otherMethod = keccak256("another-method");
        vm.expectRevert("DPP: Method not enrolled");
        policy.setPolicy(otherMethod, POLICY, GOODS_WINDOW, true);
        policy.setPolicy(otherMethod, bytes32(0), RISK, true);
        policy.setPolicy(otherMethod, POLICY, GOODS_WINDOW, true);
        policy.setPolicy(METHOD, POLICY, 0, false);
        (uint64 window, bool registered, bool enabled) = policy.policyRules(otherMethod, POLICY);
        assertEq(window, GOODS_WINDOW);
        assertTrue(registered);
        assertTrue(enabled);
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(POLICY));
        policy.setPolicy(otherMethod, SECOND_POLICY, 0, true);
    }

    function test_DisabledZeroWindowRuleRemainsRegisteredAndCanUpdateFutureTerms() public {
        policy.setPolicy(METHOD, POLICY, 0, false);

        (uint64 window, bool registered, bool enabled) = policy.policyRules(METHOD, POLICY);
        assertEq(window, 0);
        assertTrue(registered);
        assertFalse(enabled);
        policy.setPolicy(METHOD, POLICY, 0, true);
        bytes32 intentHash = _bypass();
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_FullBytes32PolicyIdRoundTripsWithOriginalHook() public {
        bytes32 maximum = bytes32(type(uint256).max);
        policy.setPolicy(METHOD, maximum, 0, true);
        bytes32 intentHash = _signalPolicy(maximum);
        IDisputeProtectionPolicy.PolicyIntent memory selected = policy.getPolicyIntent(intentHash);
        assertEq(selected.policyId, maximum);
        assertEq(selected.lifecycleHook, address(hook));
        _complete(intentHash, _attestation(intentHash, PAYMENT, maximum, INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(hook));
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
    }

    function testFuzz_EveryPolicyBitMustMatch(bytes32 differentPolicy, bool standard) public {
        vm.assume(differentPolicy != (standard ? bytes32(0) : POLICY));
        if (standard) _stake(INTENT_AMOUNT);
        bytes32 intentHash = standard ? _signalDefault() : _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, differentPolicy, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
        assertEq(vault.lockedStake(taker), standard ? INTENT_AMOUNT : 0);
    }

    function test_GoodsAndServicesLocks90DaysAndReturnsCompletePolicy() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(GOODS_AND_SERVICES);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, GOODS_WINDOW);
        assertEq(policy.getPolicyIntent(intentHash).policyId, GOODS_AND_SERVICES);
        (address owner, uint256 amount, uint64 maturity) = vault.locks(intentHash);
        assertEq(owner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturity, type(uint64).max);
        // Disabling new admissions and changing defaults cannot shorten this order's terms.
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, false);
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        _complete(intentHash, _attestation(intentHash, PAYMENT, GOODS_AND_SERVICES, 20e6));
        uint64 eligibleAt = uint64(block.timestamp + GOODS_WINDOW);
        assertEq(vault.lockedStake(taker), 20e6);
        vm.warp(eligibleAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotReleaseEligible.selector, eligibleAt, eligibleAt - 1
            )
        );
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
        vm.warp(eligibleAt);
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
        (owner, amount, maturity) = vault.locks(intentHash);
        assertEq(owner, address(0));
        assertEq(amount, 0);
        assertEq(maturity, 0);
        IDisputeProtectionPolicy.PolicyIntent memory recorded = policy.getPolicyIntent(intentHash);
        assertEq(recorded.stakeOwner, taker);
        assertEq(recorded.depositor, depositor);
        assertEq(recorded.taker, taker);
        assertEq(recorded.paymentMethod, METHOD);
        assertEq(recorded.riskWindow, GOODS_WINDOW);
        assertEq(recorded.releaseEligibleAt, eligibleAt);
        assertEq(recorded.releaseAmount, 20e6);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.RELEASED);
    }

    function test_PositiveWindowStillRequiresExactPolicyEvidence() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        policy.setPolicy(METHOD, SECOND_POLICY, GOODS_WINDOW, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(GOODS_AND_SERVICES);
        bytes32[3] memory wrongPolicies = [bytes32(0), POLICY, SECOND_POLICY];
        for (uint256 policyIndex; policyIndex < wrongPolicies.length; ++policyIndex) {
            UnifiedPaymentVerifierV3.PaymentAttestation memory att =
                _attestation(intentHash, PAYMENT, wrongPolicies[policyIndex], INTENT_AMOUNT);
            vm.expectRevert("DPP: Policy mismatch");
            _complete(intentHash, att);
        }
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(policy.getPolicyIntent(intentHash).policyId, bytes32(0));
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, GOODS_WINDOW);
        assertEq(payments.nullifierByIntentHash(intentHash), bytes32(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + GOODS_WINDOW);
    }

    function test_PositivePolicyCannotSkipCheckerOrUseAlternateRegistryWriter() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(GOODS_AND_SERVICES);
        upv.setAttestationVerifier(address(signatures));
        UnifiedPaymentVerifierV3.PaymentAttestation memory ordinary =
            _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy checker changed");
        _complete(intentHash, ordinary);
        _assertUnsettled(intentHash);
        upv.setAttestationVerifier(address(policy));
        payments.addWritePermission(other);
        UnifiedPaymentVerifierV3.PaymentAttestation memory correct =
            _attestation(intentHash, PAYMENT, GOODS_AND_SERVICES, INTENT_AMOUNT);
        vm.expectRevert("DPP: Unsafe payment writers");
        _complete(intentHash, correct);
        payments.removeWritePermission(other);
        NullifyingPaymentVerifierMock alternative = new NullifyingPaymentVerifierMock(payments, METHOD);
        payments.addWritePermission(address(alternative));
        _route(address(alternative));
        vm.expectRevert("DPP: Payment route changed");
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        _assertUnsettled(intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_PositivePolicyRetainsDisputeCoveragePastDefaultWindow() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(GOODS_AND_SERVICES);
        _complete(intentHash, _attestation(intentHash, PAYMENT, GOODS_AND_SERVICES, 20e6));
        vm.warp(block.timestamp + RISK + 1);
        policy.submitDispute(_dispute(intentHash, PAYMENT));
        assertEq(vault.claimable(depositor), 20e6);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(policy.getPolicyIntent(intentHash).releaseAmount, 20e6);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.DISPUTED);
    }

    function test_PositivePolicyKeepsNormalWhitelistCancellationAndManualRelease() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), new address[](0));
        _stake(INTENT_AMOUNT * 2);
        bytes32 cancelled = _signalPolicy(GOODS_AND_SERVICES);
        bytes32 manual = _signalPolicy(GOODS_AND_SERVICES);
        upv.setAttestationVerifier(address(signatures));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        _status(cancelled, IDisputeProtectionPolicy.PolicyIntentStatus.CANCELLED);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(manual);
        _status(manual, IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED);
        assertEq(policy.getPolicyIntent(manual).releaseEligibleAt, block.timestamp + GOODS_WINDOW);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_PolicyWindowIsBoundedAndUpdatable() public {
        uint64 maximum = policy.MAX_RISK_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(IDisputeProtectionPolicy.InvalidRiskWindow.selector, maximum + 1));
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, maximum + 1, true);
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, maximum, true);
        (uint64 window, bool registered, bool enabled) = policy.policyRules(METHOD, GOODS_AND_SERVICES);
        assertTrue(registered);
        assertEq(window, maximum);
        assertTrue(enabled);
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, 0, true);
        (window, registered, enabled) = policy.policyRules(METHOD, GOODS_AND_SERVICES);
        assertEq(window, 0);
        assertTrue(registered && enabled);
    }

    function testFuzz_PositivePolicySnapshotsItsWindow(uint64 window) public {
        window = uint64(bound(window, 1, policy.MAX_RISK_WINDOW()));
        policy.setPolicy(METHOD, SECOND_POLICY, window, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(SECOND_POLICY);
        policy.setPolicy(METHOD, SECOND_POLICY, 0, false);
        _complete(intentHash, _attestation(intentHash, PAYMENT, SECOND_POLICY, INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, window);
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + window);
        vm.warp(block.timestamp + window);
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_ZeroWindowReleaseUsesExistingAmountBound() public {
        bytes32 intentHash = _bypass();
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT * 2));
        assertEq(policy.getPolicyIntent(intentHash).releaseAmount, INTENT_AMOUNT);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
    }

    function test_DefaultZeroWindowRecordsOriginAndSettlesWithoutStake() public {
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        bytes32 intentHash = _signalDefault();
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
        assertEq(policy.getPolicyIntent(intentHash).policyId, bytes32(0));
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(hook));
        assertEq(vault.lockedStake(taker), 0);
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, 0);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.DisputeProtectionIntentNotCovered.selector, intentHash)
        );
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
    }

    function test_DefaultZeroWindowRecoveryUsesNewPositiveTermsAndLocksFirst() public {
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        bytes32 intentHash = _signalDefault();
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(vault.lockedStake(taker), 0);
        policy.setPolicy(METHOD, bytes32(0), RISK, true);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, 0);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, uint256(0), INTENT_AMOUNT)
        );
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, 0);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, bytes32(0));
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(hook));
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + RISK);
    }

    function test_DisabledDefaultDoesNotOpenRouteOrDisableEnabledSibling() public {
        policy.setPolicy(METHOD, bytes32(0), 0, false);
        assertTrue(policy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _defaultParams());
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(bytes32(0)));
        bytes32 intentHash = _bypass();
        policy.setPolicy(METHOD, POLICY, 0, false);
        assertTrue(policy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(POLICY));
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_PauseAndWhitelistApplyToZeroWindowDefault() public {
        policy.setPolicy(METHOD, bytes32(0), 0, true);
        policy.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _signalCall(taker, _defaultParams());
        policy.setAdmissionsPaused(false);
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert("DPP: Zero-window whitelist enabled");
        _signalCall(taker, _defaultParams());
    }

    function test_DefaultProofCannotSkipPolicyChecker() public {
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalDefault();
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(hook));
        upv.setAttestationVerifier(address(signatures));
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy checker changed");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_RuleUpdatesAffectOnlyFutureAdmissions() public {
        _stake(INTENT_AMOUNT);
        bytes32 oldIntent = _bypass();
        policy.setPolicy(METHOD, POLICY, GOODS_WINDOW, true);
        bytes32 newIntent = _signalPolicy(POLICY);
        assertEq(policy.getPolicyIntent(oldIntent).riskWindow, 0);
        assertEq(policy.getPolicyIntent(newIntent).riskWindow, GOODS_WINDOW);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        _complete(oldIntent, _attestation(oldIntent, PAYMENT, POLICY, INTENT_AMOUNT));
        _complete(newIntent, _attestation(newIntent, keccak256("second-payment"), POLICY, INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(oldIntent).releaseEligibleAt, 0);
        assertEq(policy.getPolicyIntent(newIntent).releaseEligibleAt, block.timestamp + GOODS_WINDOW);
    }

    function test_CatalogRequiresDefaultEnrollmentAndNonzeroMethod() public {
        bytes32 method = keccak256("unmanaged");
        upv.addPaymentMethod(method);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(method, address(upv), currencies);
        assertFalse(policy.isPolicyAdmissionEnabled(address(escrow), depositId, method));
        // Admission for unsupported escrow tuples is still owned by the escrow, not the policy catalog.
        vm.expectRevert("DPP: Method not enrolled");
        policy.setPolicy(method, POLICY, 0, true);
        vm.expectRevert("DPP: Zero method");
        policy.setPolicy(bytes32(0), bytes32(0), 0, true);
    }

    function _dispute(bytes32 intentHash, bytes32 paymentId)
        internal
        view
        returns (IDisputeVerifier.DisputeAttestation memory att)
    {
        att.intentHash = intentHash;
        att.data = abi.encode(IDisputeVerifier.DisputeDetails(METHOD, paymentId, keccak256("dispute"), 5000, USD));
        att.dataHash = keccak256(att.data);
        bytes32 digest = DisputeVerifier(address(policy.disputeVerifier())).hashDisputeAttestation(att);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(SIGNER_KEY, digest);
        att.signatures = new bytes[](1);
        att.signatures[0] = abi.encodePacked(r, sigS, v);
    }

    function test_WhitelistOrdinaryEvidenceRequiresMatchingPolicy() public {
        address[] memory members = new address[](1);
        members[0] = taker;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), members);
        bytes32 intentHash = _signalDefault();
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.NONE);
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(intentHash, att);
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_V3DelegatesSignatureVerificationExactlyOnce() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        bytes memory verification = abi.encodeCall(signatures.verify, (_digest(att), att.signatures, att.data));
        vm.expectCall(address(policy), verification, 1);
        vm.expectCall(address(signatures), verification, 1);
        _complete(intentHash, att);
        assertEq(payments.nullifierByIntentHash(intentHash), keccak256(abi.encodePacked(METHOD, PAYMENT)));
    }

    function test_UnknownOrUnfundedRuntimePolicyRollsBackAdmission() public {
        uint256 counter = orchestrator.intentCounter();
        bytes32 intentHash = _intentHash(counter);
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, _policyParams(SECOND_POLICY));
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(taker, _policyParams(GOODS_AND_SERVICES));
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(policy.getPolicyIntent(intentHash).lifecycleHook, address(0));
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.NONE);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, bytes32(0));
        assertEq(vault.lockedStake(taker), 0);
        _stake(INTENT_AMOUNT);
        assertEq(_signalPolicy(GOODS_AND_SERVICES), intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_LifecyclePolicyIsSeparateFromPostHookPayload() public {
        _stake(INTENT_AMOUNT);
        IOrchestratorV3.SignalIntentParams memory params = _policyParams(bytes32(0));
        params.postIntentHook = new PolicyPostIntentHook();
        params.data = abi.encode(other);
        bytes32 ordinary = _signal(taker, params);
        assertEq(policy.getPolicyIntent(ordinary).policyId, bytes32(0));
        _complete(ordinary, _attestation(ordinary, PAYMENT, bytes32(0), INTENT_AMOUNT));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);

        params.lifecycleHookData = abi.encode(POLICY);
        bytes32 balance = _signal(taker, params);
        assertEq(orchestrator.getIntent(balance).data, params.data);
        assertEq(policy.getPolicyIntent(balance).policyId, POLICY);
        _complete(balance, _attestation(balance, keccak256("post-hook-balance"), POLICY, INTENT_AMOUNT));
        assertEq(token.balanceOf(other), INTENT_AMOUNT * 2);
        assertEq(policy.getPolicyIntent(balance).stakeOwner, address(0));
    }

    function testFuzz_NonemptySignalRequiresFullPolicyWord(uint8 length) public {
        length = uint8(bound(length, 1, 31));
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.lifecycleHookData = new bytes(length);
        uint256 counter = orchestrator.intentCounter();
        vm.expectRevert("Hook: Invalid policy data");
        _signalCall(taker, params);
        assertEq(orchestrator.intentCounter(), counter);
        assertEq(vault.lockedStake(taker), 0);
    }

    function testFuzz_LifecyclePolicyPreservesOpaquePostHookData(bytes memory hookData) public {
        vm.assume(hookData.length <= 256);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.lifecycleHookData = abi.encode(POLICY);
        params.data = hookData;
        bytes32 intentHash = _signal(taker, params);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, 0);
        assertEq(orchestrator.getIntent(intentHash).data, params.data);
    }

    function test_UnknownLifecyclePolicyDoesNotFallBackToDefault() public {
        _stake(INTENT_AMOUNT);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.lifecycleHookData = abi.encode(other);
        vm.expectRevert("DPP: Policy unavailable");
        _signalCall(taker, params);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_UpstreamRejectsMethodMismatchAndClosedIntentBeforeDpp() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        (
            UnifiedPaymentVerifierV3.PaymentDetails memory payment,
            UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot,
        ) = abi.decode(
            att.data, (UnifiedPaymentVerifierV3.PaymentDetails, UnifiedPaymentVerifierV3.IntentSnapshot, bytes32)
        );
        bytes32 differentMethod = keccak256("another-method");
        upv.addPaymentMethod(differentMethod);
        payment.method = differentMethod;
        snapshot.paymentMethod = differentMethod;
        att.data = abi.encode(payment, snapshot, POLICY);
        _sign(att);
        vm.mockCallRevert(address(policy), abi.encodeWithSelector(policy.verify.selector), "DPP must not be reached");
        vm.expectRevert("UPV: Snapshot method mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);

        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.IntentNotFound.selector, intentHash));
        _complete(intentHash, att);
        assertEq(payments.nullifierByIntentHash(intentHash), bytes32(0));
    }

    function test_AdjustToGoodsPolicyLocksBeforeChangingAndUsesMatchingProof() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        bytes32 intentHash = _bypass();
        bytes memory originalData = orchestrator.getIntent(intentHash).data;
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, uint256(0), INTENT_AMOUNT)
        );
        policy.adjustPolicy(intentHash, GOODS_AND_SERVICES);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, 0);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, GOODS_AND_SERVICES);
        assertEq(orchestrator.getIntent(intentHash).data, originalData);
        assertEq(policy.getPolicyIntent(intentHash).policyId, GOODS_AND_SERVICES);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, GOODS_WINDOW);
        UnifiedPaymentVerifierV3.PaymentAttestation memory oldEvidence =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Policy mismatch");
        _complete(intentHash, oldEvidence);
        _complete(intentHash, _attestation(intentHash, PAYMENT, GOODS_AND_SERVICES, INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + GOODS_WINDOW);
    }

    function test_AdjustPositiveCoverageReusesOriginalLockAndCannotUnlockIt() public {
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalDefault();
        vm.prank(taker);
        policy.adjustPolicy(intentHash, GOODS_AND_SERVICES);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, GOODS_WINDOW);
        (address owner, uint256 amount, uint64 maturity) = vault.locks(intentHash);
        assertEq(owner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturity, type(uint64).max);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, POLICY);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, GOODS_WINDOW);
        assertEq(policy.getPolicyIntent(intentHash).stakeOwner, owner);
        assertEq(vault.lockedStake(owner), amount);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        assertEq(policy.getPolicyIntent(intentHash).releaseEligibleAt, block.timestamp + GOODS_WINDOW);
        vm.warp(block.timestamp + RISK);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotReleaseEligible.selector,
                uint64(1_000_000 + GOODS_WINDOW),
                uint64(block.timestamp)
            )
        );
        policy.releaseMaturedDisputeProtectionIntent(intentHash);
        assertEq(vault.lockedStake(owner), amount);
    }

    function test_AdjustRejectsUnavailablePolicyAndCancelledOrder() public {
        bytes32 intentHash = _bypass();
        vm.prank(taker);
        vm.expectRevert("DPP: Policy unavailable");
        policy.adjustPolicy(intentHash, GOODS_AND_SERVICES);
        policy.setPolicy(METHOD, GOODS_AND_SERVICES, GOODS_WINDOW, false);
        vm.prank(taker);
        vm.expectRevert("DPP: Policy unavailable");
        policy.adjustPolicy(intentHash, GOODS_AND_SERVICES);
        assertEq(policy.getPolicyIntent(intentHash).policyId, POLICY);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        vm.prank(taker);
        vm.expectRevert("DPP: Admission not pending");
        policy.adjustPolicy(intentHash, bytes32(0));
    }

    function testFuzz_AdjustmentWindowNeverDecreases(uint64 firstWindow, uint64 nextWindow) public {
        firstWindow = uint64(bound(firstWindow, 0, policy.MAX_RISK_WINDOW()));
        nextWindow = uint64(bound(nextWindow, 0, policy.MAX_RISK_WINDOW()));
        policy.setPolicy(METHOD, POLICY, firstWindow, true);
        policy.setPolicy(METHOD, SECOND_POLICY, nextWindow, true);
        _stake(INTENT_AMOUNT);
        bytes32 intentHash = _signalPolicy(POLICY);
        vm.prank(taker);
        policy.adjustPolicy(intentHash, SECOND_POLICY);
        uint64 expectedWindow = firstWindow > nextWindow ? firstWindow : nextWindow;
        assertEq(policy.getPolicyIntent(intentHash).riskWindow, expectedWindow);
        assertEq(vault.lockedStake(taker), expectedWindow == 0 ? 0 : INTENT_AMOUNT);
        _complete(intentHash, _attestation(intentHash, PAYMENT, SECOND_POLICY, INTENT_AMOUNT));
        assertEq(
            policy.getPolicyIntent(intentHash).releaseEligibleAt,
            expectedWindow == 0 ? 0 : block.timestamp + expectedWindow
        );
    }

}
