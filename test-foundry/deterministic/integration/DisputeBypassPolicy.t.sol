// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {NullifyingPaymentVerifierMock} from "contracts/mocks/NullifyingPaymentVerifierMock.sol";

contract DisputeBypassPolicyTest is OrchestratorV3Fixture {
    bytes32 internal constant POLICY = keccak256("venmo-balance-bypass");
    bytes32 internal constant SECOND_POLICY = keccak256("another-approved-rule");
    bytes32 internal constant PAYMENT = keccak256("canonical-payment-id");
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint64 internal constant RISK = 30 days;

    DisputeProtectionPolicy internal policy;
    IntentLifecycleHookV1 internal hook;
    WhitelistPolicy internal whitelist;
    StakeVault internal vault;
    NullifierRegistry internal legacy;
    NullifierRegistryV2 internal payments;
    SimpleAttestationVerifier internal signatures;
    UnifiedPaymentVerifierV3 internal upv;

    function setUp() public override {
        super.setUp();
        vm.warp(1_000_000);
        legacy = new NullifierRegistry();
        payments = new NullifierRegistryV2(legacy);
        signatures = new SimpleAttestationVerifier(vm.addr(SIGNER_KEY));
        upv = new UnifiedPaymentVerifierV3(orchestratorRegistry, payments, signatures);
        upv.addPaymentMethod(METHOD);
        payments.addWritePermission(address(upv));
        _route(address(upv));
        vault = new StakeVault(address(this), token, address(0), 1 days);
        NullifierRegistry disputes = new NullifierRegistry();
        policy = new DisputeProtectionPolicy(
            address(this), vault, new DisputeVerifier(address(this), payments, signatures), disputes
        );
        vault.initializeController(address(policy));
        disputes.addWritePermission(address(policy));
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        hook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, policy);
        policy.setLifecycleHookAuthorization(address(hook), true);
        policy.setRiskWindow(METHOD, RISK);
        orchestrator.setLifecycleHook(hook);
        upv.setAttestationVerifier(address(policy));
        policy.registerBypassRoute(address(hook), address(orchestrator), address(upv), address(signatures));
        policy.registerBypassPolicy(POLICY, METHOD);
    }

    function test_BypassUsesExistingVerifierAndSharedPaymentBindingWithoutStake() public {
        bytes32 intentHash = _bypass();
        assertEq(vault.lockedStake(taker), 0);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_SETTLED);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, PAYMENT));
        assertEq(payments.nullifierByIntentHash(intentHash), nullifier);
        assertEq(payments.intentHashByNullifier(nullifier), intentHash);
        assertEq(policy.getDisputeProtectionIntent(intentHash).releaseAmount, INTENT_AMOUNT);
    }

    function test_GenericRuleAppliesWithoutMakerConfiguration() public {
        policy.registerBypassPolicy(SECOND_POLICY, METHOD);
        _choose(SECOND_POLICY);
        bytes32 intentHash = _signalDefault();
        _complete(intentHash, _attestation(intentHash, PAYMENT, SECOND_POLICY, INTENT_AMOUNT));
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_SETTLED);
    }

    function test_OrdinaryAttestationCannotSettleBypass() public {
        bytes32 intentHash = _bypass();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, bytes32(0), INTENT_AMOUNT);
        vm.expectRevert("DPP: Bypass policy mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_BalanceAttestationCannotSettleProtectedOrOpenOrder() public {
        _stake(INTENT_AMOUNT);
        bytes32 protectedIntent = _signalDefault();
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(protectedIntent, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Bypass admission required");
        _complete(protectedIntent, att);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        vm.prank(depositor);
        policy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        bytes32 openIntent = _signalDefault();
        att = _attestation(openIntent, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Bypass admission required");
        _complete(openIntent, att);
        _complete(openIntent, _attestation(openIntent, PAYMENT, bytes32(0), INTENT_AMOUNT));
    }

    function test_ChoiceChangeDoesNotRewriteAdmittedOrder() public {
        bytes32 intentHash = _bypass();
        _choose(bytes32(0));
        assertEq(policy.getBypassAdmission(intentHash).policyId, POLICY);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_DisableRuleOnlyAffectsNewAdmissions() public {
        bytes32 intentHash = _bypass();
        policy.setBypassPolicyEnabled(POLICY, false);
        vm.expectRevert("DPP: Bypass policy unavailable");
        _signalCall(taker, _defaultParams());
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_RecoveryRequiresActualStakeAndThenOrdinaryProof() public {
        bytes32 intentHash = _bypass();
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, taker, uint256(0), INTENT_AMOUNT)
        );
        policy.convertBypassToProtected(intentHash);
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_PENDING);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.convertBypassToProtected(intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        UnifiedPaymentVerifierV3.PaymentAttestation memory att =
            _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("DPP: Bypass admission required");
        _complete(intentHash, att);
        _complete(intentHash, _attestation(intentHash, PAYMENT, bytes32(0), 20e6));
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED);
        assertEq(vault.lockedStake(taker), 20e6);
        assertEq(policy.getDisputeProtectionIntent(intentHash).releaseEligibleAt, block.timestamp + RISK);
        vm.prank(taker);
        vm.expectRevert("DPP: Bypass not pending");
        policy.convertBypassToProtected(intentHash);
    }

    function test_RecoveryRejectsForeignTakerAndExpiredOrder() public {
        bytes32 intentHash = _bypass();
        vm.prank(other);
        vm.expectRevert("DPP: Not bypass taker");
        policy.convertBypassToProtected(intentHash);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(taker);
        vm.expectRevert("DPP: Bypass expired");
        policy.convertBypassToProtected(intentHash);
    }

    function test_RecoveryRejectsProtectionOptOut() public {
        bytes32 intentHash = _bypass();
        vm.prank(depositor);
        policy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionNotEnabled.selector, address(escrow), depositId, METHOD
            )
        );
        policy.convertBypassToProtected(intentHash);
    }

    function test_CancelAndManualReleaseWorkWhenProofRouteBreaks() public {
        bytes32 cancelled = _bypass();
        upv.setAttestationVerifier(address(signatures));
        vm.prank(taker);
        orchestrator.cancelIntent(cancelled);
        _status(cancelled, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_CANCELLED);
        upv.setAttestationVerifier(address(policy));
        bytes32 manual = _bypass();
        upv.setAttestationVerifier(address(signatures));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(manual);
        _status(manual, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_MANUAL_RELEASED);
        assertEq(payments.nullifierByIntentHash(manual), bytes32(0));
        assertEq(vault.lockedStake(taker), 0);
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
        _signalCall(taker, _defaultParams());
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
        bytes32 another = _signalDefault();
        att = _attestation(another, PAYMENT, POLICY, INTENT_AMOUNT);
        vm.expectRevert("UPV: Attestation hash mismatch");
        _complete(intentHash, att);
        _assertUnsettled(intentHash);
    }

    function test_ReplayAcrossPoliciesAndLegacyHistoryRejects() public {
        bytes32 intentHash = _bypass();
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
        policy.registerBypassPolicy(SECOND_POLICY, METHOD);
        _choose(SECOND_POLICY);
        bytes32 another = _signalDefault();
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
        _choose(POLICY);
        vm.expectRevert("DPP: Bypass whitelist enabled");
        _signalCall(taker, _defaultParams());
    }

    function test_UnknownPolicyAndUnauthorizedDirectVerificationReject() public {
        vm.prank(taker);
        vm.expectRevert("DPP: Bypass policy unavailable");
        policy.setBypassPolicyChoice(address(escrow), depositId, METHOD, SECOND_POLICY);
        vm.expectRevert("DPP: Unauthorized payment verifier");
        policy.verify(bytes32(0), new bytes[](0), new bytes(480));
    }

    function test_RecoveryRestoresDisputeCompensationButBypassDoesNot() public {
        bytes32 bypass = _bypass();
        _complete(bypass, _attestation(bypass, PAYMENT, POLICY, INTENT_AMOUNT));
        IDisputeVerifier.DisputeAttestation memory disputed = _dispute(bypass, PAYMENT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                bypass,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_SETTLED
            )
        );
        policy.submitDispute(disputed);
        assertEq(vault.claimable(depositor), 0);

        bytes32 recovered = _bypass();
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.convertBypassToProtected(recovered);
        bytes32 recoveredPayment = keccak256("recovered-payment");
        _complete(recovered, _attestation(recovered, recoveredPayment, bytes32(0), 20e6));
        policy.submitDispute(_dispute(recovered, recoveredPayment));
        assertEq(vault.claimable(depositor), 20e6);
        assertEq(vault.lockedStake(taker), 0);
        _status(recovered, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.DISPUTED);
    }

    function test_SnapshottedHookRequiredBeforeAndAfterRecovery() public {
        bytes32 intentHash = _bypass();
        IntentLifecycleHookV1 anotherHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, policy);
        policy.setLifecycleHookAuthorization(address(anotherHook), true);
        vm.prank(address(anotherHook));
        vm.expectRevert("DPP: Wrong admission hook");
        policy.onIntentSettled(intentHash, INTENT_AMOUNT, true);
        _stake(INTENT_AMOUNT);
        vm.prank(taker);
        policy.convertBypassToProtected(intentHash);
        vm.prank(address(anotherHook));
        vm.expectRevert("DPP: Wrong admission hook");
        policy.onIntentCancelled(intentHash);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        // Rotating the default hook does not move an already admitted order.
        orchestrator.setLifecycleHook(anotherHook);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED);
    }

    function test_PauseBlocksRecoveryButKeepsBypassFulfillmentAvailable() public {
        bytes32 intentHash = _bypass();
        policy.setAdmissionsPaused(true);
        vm.prank(taker);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        policy.convertBypassToProtected(intentHash);
        _complete(intentHash, _attestation(intentHash, PAYMENT, POLICY, INTENT_AMOUNT));
    }

    function test_PolicyAndRouteIdentitiesCannotBeRewritten() public {
        vm.expectRevert("DPP: Policy already registered");
        policy.registerBypassPolicy(POLICY, keccak256("another-method"));
        vm.expectRevert("DPP: Route already registered");
        policy.registerBypassRoute(address(hook), address(orchestrator), address(upv), address(signatures));
        vm.prank(taker);
        vm.expectRevert("DPP: Bypass policy unavailable");
        policy.setBypassPolicyChoice(address(escrow), depositId, keccak256("another-method"), POLICY);
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

    function _route(address paymentVerifier) internal {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, paymentVerifier, currencies);
    }

    function _choose(bytes32 policyId) internal {
        vm.prank(taker);
        policy.setBypassPolicyChoice(address(escrow), depositId, METHOD, policyId);
    }

    function _bypass() internal returns (bytes32) {
        _choose(POLICY);
        return _signalDefault();
    }

    function _stake(uint256 amount) internal {
        token.transfer(taker, amount);
        vm.startPrank(taker);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _status(bytes32 intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus expected)
        internal
        view
    {
        assertEq(uint256(policy.getDisputeProtectionIntent(intentHash).status), uint256(expected));
    }

    function _assertUnsettled(bytes32 intentHash) internal view {
        assertEq(payments.nullifierByIntentHash(intentHash), bytes32(0));
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(token.balanceOf(taker), 0);
        _status(intentHash, IDisputeProtectionPolicy.DisputeProtectionIntentStatus.BYPASS_PENDING);
    }

    function _attestation(bytes32 intentHash, bytes32 paymentId, bytes32 policyId, uint256 releaseAmount)
        internal
        view
        returns (UnifiedPaymentVerifierV3.PaymentAttestation memory att)
    {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        UnifiedPaymentVerifierV3.PaymentDetails memory payment =
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId);
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot = UnifiedPaymentVerifierV3.IntentSnapshot(
            intentHash, intent.amount, METHOD, USD, PAYEE, intent.conversionRate, intent.timestamp, 0
        );
        att.intentHash = intentHash;
        att.releaseAmount = releaseAmount;
        att.data = abi.encode(payment, snapshot, policyId);
        _sign(att);
    }

    function _sign(UnifiedPaymentVerifierV3.PaymentAttestation memory att) internal view {
        att.dataHash = keccak256(att.data);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(SIGNER_KEY, _digest(att));
        att.signatures = new bytes[](1);
        att.signatures[0] = abi.encodePacked(r, sigS, v);
    }

    function _digest(UnifiedPaymentVerifierV3.PaymentAttestation memory att) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                att.intentHash,
                att.releaseAmount,
                att.dataHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", upv.DOMAIN_SEPARATOR(), structHash));
    }

    function _complete(bytes32 intentHash, UnifiedPaymentVerifierV3.PaymentAttestation memory att) internal {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(abi.encode(att), intentHash, "", ""));
    }
}
