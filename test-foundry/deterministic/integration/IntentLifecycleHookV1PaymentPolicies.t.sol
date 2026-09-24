// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
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

contract IntentLifecycleHookV1PaymentPoliciesTest is OrchestratorV3Fixture {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant MARKER = keccak256("payment_policy");
    bytes32 internal constant POLICY = keccak256("venmo_balance");
    bytes32 internal constant GOODS_POLICY = keccak256("venmo_goods_and_services");
    bytes32 internal constant PAYPAL_POLICY = keccak256("paypal_balance");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant PAYMENT_ID = keccak256("canonical-venmo-payment-id");
    uint64 internal constant RISK_WINDOW = 14 days;

    StakeVault internal vault;
    DisputeProtectionPolicy internal protection;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV3 internal upv;
    NullifierRegistryV2 internal nullifiers;
    IntentLifecycleHookV1 internal policy;
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

        policy = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        policy.initializePaymentVerifier(upv);
        policy.setPolicy(POLICY, METHOD, true);
        policy.setPolicy(GOODS_POLICY, METHOD, true);
        protection.setLifecycleHookAuthorization(address(policy), true);
        upv.setAttestationVerifier(address(policy));
        orchestrator.setLifecycleHook(policy);
    }

    function test_VerifierBindingRequiresCurrentDisputeGovernanceAndCapturesWitnesses() public {
        IntentLifecycleHookV1 hook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        vm.prank(other);
        vm.expectRevert("ILH: Only dispute governance");
        hook.initializePaymentVerifier(upv);
        protection.transferOwnership(other);
        vm.prank(other);
        protection.acceptOwnership();
        vm.expectRevert("ILH: Only dispute governance");
        hook.initializePaymentVerifier(upv);
        upv.setAttestationVerifier(address(witnesses));
        vm.prank(other);
        hook.initializePaymentVerifier(upv);
        assertEq(address(hook.paymentVerifier()), address(upv));
        assertEq(address(hook.signatureVerifier()), address(witnesses));
    }

    function test_VerifierBindingCannotBeChanged() public {
        vm.expectRevert("ILH: Verifier already bound");
        policy.initializePaymentVerifier(upv);
        assertEq(address(policy.paymentVerifier()), address(upv));
        assertEq(address(policy.signatureVerifier()), address(witnesses));
    }

    function test_VerifierBindingRejectsInvalidDependenciesAndDifferentRegistry() public {
        IntentLifecycleHookV1 hook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        vm.expectRevert(IntentLifecycleHookV1.ZeroAddress.selector);
        hook.initializePaymentVerifier(UnifiedPaymentVerifierV3(address(0)));
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.InvalidDependency.selector, other));
        hook.initializePaymentVerifier(UnifiedPaymentVerifierV3(other));
        UnifiedPaymentVerifierV3 foreignVerifier =
            new UnifiedPaymentVerifierV3(new OrchestratorRegistry(), nullifiers, witnesses);
        vm.expectRevert("ILH: Registry mismatch");
        hook.initializePaymentVerifier(foreignVerifier);
        assertEq(address(hook.paymentVerifier()), address(0));
    }

    function test_VerifierBindingRejectsInstallationBeforeBinding() public {
        IntentLifecycleHookV1 hook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        upv.setAttestationVerifier(address(hook));
        vm.expectRevert("ILH: Cannot verify own signatures");
        hook.initializePaymentVerifier(upv);
        assertEq(address(hook.paymentVerifier()), address(0));
    }

    function test_BalanceSettlesWithoutStakeUsingSameVerifierAndNullifier() public {
        bytes32 intentHash = _signalBalance();
        assertEq(vault.lockedStake(taker), 0);
        assertEq(_intentOrchestrator(intentHash), address(orchestrator));
        assertEq(orchestrator.getIntent(intentHash).paymentMethod, METHOD);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertTrue(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(_intentOrchestrator(intentHash), address(0));
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

    function test_PendingOrdinaryIntentRetainsOriginalHookAndProofAfterReplacement() public {
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

    function test_ExistingDisputeProtectionOptOutBlocksBothPoliciesUntilReenabled() public {
        orchestrator.setLifecycleHook(oldHook);
        _setDisputeProtection(false);
        orchestrator.setLifecycleHook(policy);
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, _balanceParams());
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(MARKER, GOODS_POLICY);
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, params);
        _setDisputeProtection(true);
        bytes32 intentHash = _signal(taker, params);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(GOODS_POLICY)));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_DisablingDisputeProtectionDoesNotChangePendingIntent() public {
        bytes32 intentHash = _signalBalance();
        _setDisputeProtection(false);
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, _balanceParams());
        bytes memory ordinaryProof = _proof(intentHash, PAYMENT_ID, "");
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, ordinaryProof);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
    }

    function test_ZeroRiskWindowStopsNewPoliciesWithoutChangingPendingIntent() public {
        bytes32 intentHash = _signalBalance();
        protection.setRiskWindow(METHOD, 0);
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, _balanceParams());
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_OrdinaryProofCannotSettleBalanceIntentOrConsumeNullifier() public {
        bytes32 intentHash = _signalBalance();
        bytes memory proof = _proof(intentHash, PAYMENT_ID, "");
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(_intentOrchestrator(intentHash), address(orchestrator));
    }

    function test_UnknownOrOversizedSignedPolicyRejected() public {
        bytes32 intentHash = _signalBalance();
        bytes memory proof = _proof(intentHash, PAYMENT_ID, abi.encode(keccak256("other-policy")));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
        proof = _proof(intentHash, PAYMENT_ID, abi.encode(POLICY, POLICY));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(intentHash, proof);
    }

    function test_UnsignedPolicyAppendAndRemovalRejected() public {
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
        bytes32 intentHash = _signalBalance();
        witnesses.addWitness(vm.addr(0xB0B));
        witnesses.setRequiredSignatures(2);
        bytes memory proof = _proof(intentHash, PAYMENT_ID, abi.encode(POLICY));
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        _settle(intentHash, proof);
    }

    function test_CancellationClearsBalanceEnrollmentAndUnlocksEscrow() public {
        bytes32 intentHash = _signalBalance();
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(_intentOrchestrator(intentHash), address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_VerifierRollbackBlocksBalanceSignalAndSettlementButAllowsManualRelease() public {
        bytes32 intentHash = _signalBalance();
        upv.setAttestationVerifier(address(witnesses));
        vm.expectRevert("ILH: Verifier not installed");
        _signalCall(taker, _balanceParams());
        bytes memory ordinaryProof = _proof(intentHash, PAYMENT_ID, "");
        vm.expectRevert("ILH: Verifier not installed");
        _settle(intentHash, ordinaryProof);
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(_intentOrchestrator(intentHash), address(0));
    }

    function test_BalanceRequiresDirectPayoutAndPreservesWhitelist() public {
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(MARKER, POLICY);
        params.postIntentHook = postIntentHook;
        vm.expectRevert("ILH: Only direct payout");
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
        bytes32 intentHash = _signalBalance();
        vm.prank(address(orchestratorMock));
        vm.expectRevert("ILH: Foreign intent");
        policy.onIntentCancelled(intentHash);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentLifecycleHookV1.UnauthorizedOrchestrator.selector, other));
        policy.onIntentCancelled(intentHash);
    }

    function test_OnlyCurrentVerifierGovernanceConfiguresPermanentlyBoundPolicies() public {
        vm.prank(other);
        vm.expectRevert("ILH: Only governance");
        policy.setPolicy(PAYPAL_POLICY, PAYPAL, true);
        vm.expectRevert("ILH: Zero policy or method");
        policy.setPolicy(bytes32(0), METHOD, true);
        vm.expectRevert("ILH: Zero policy or method");
        policy.setPolicy(PAYPAL_POLICY, bytes32(0), true);
        policy.setPolicy(POLICY, METHOD, false);
        (bytes32 method, bool enabled) = policy.policies(POLICY);
        assertEq(method, METHOD);
        assertFalse(enabled);
        vm.expectRevert("ILH: Policy method immutable");
        policy.setPolicy(POLICY, PAYPAL, true);
        upv.transferOwnership(other);
        vm.expectRevert("ILH: Only governance");
        policy.setPolicy(POLICY, METHOD, true);
        vm.prank(other);
        policy.setPolicy(POLICY, METHOD, true);
    }

    function test_GlobalDisableOnlyStopsNewAdmissions() public {
        bytes32 intentHash = _signalBalance();
        policy.setPolicy(POLICY, METHOD, false);
        vm.expectRevert("ILH: Admissions disabled");
        _signalCall(taker, _balanceParams());
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
    }

    function test_PolicyMarkerRejectsMalformedUnknownAndZeroSelections() public {
        bytes32 marker = MARKER;
        bytes[] memory malformed = new bytes[](4);
        malformed[0] = abi.encode(marker);
        malformed[1] = abi.encodePacked(marker, bytes31(0));
        malformed[2] = abi.encodePacked(marker, POLICY, bytes1(0));
        malformed[3] = abi.encode(marker, POLICY, POLICY);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        for (uint256 index = 0; index < malformed.length; index++) {
            params.data = malformed[index];
            vm.expectRevert("ILH: Invalid policy envelope");
            _signalCall(taker, params);
        }
        params.data = abi.encode(marker, keccak256("unknown_policy"));
        vm.expectRevert("ILH: Unknown policy");
        _signalCall(taker, params);
        params.data = abi.encode(marker, bytes32(0));
        vm.expectRevert("ILH: Unknown policy");
        _signalCall(taker, params);
        assertEq(orchestrator.getAccountIntents(taker).length, 0);
    }

    function test_TwoVenmoPoliciesRequireTheirOwnSignedTagWithoutNewOptIn() public {
        IOrchestratorV3.SignalIntentParams memory goodsParams = _defaultParams();
        goodsParams.data = abi.encode(MARKER, GOODS_POLICY);
        bytes32 balance = _signalBalance();
        bytes32 goods = _signal(taker, goodsParams);
        (bytes32 requiredPolicy,) = policy.policyIntents(goods);
        assertEq(requiredPolicy, GOODS_POLICY);
        bytes memory proof = _proof(goods, PAYMENT_ID, abi.encode(POLICY));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(goods, proof);
        proof = _proof(balance, PAYMENT_ID, abi.encode(GOODS_POLICY));
        vm.expectRevert("UPV: Invalid attestation");
        _settle(balance, proof);
        _settle(goods, _proof(goods, PAYMENT_ID, abi.encode(GOODS_POLICY)));
        proof = _proof(balance, PAYMENT_ID, abi.encode(POLICY));
        vm.expectRevert("Nullifier has already been used");
        _settle(balance, proof);
        bytes32 nextPayment = keccak256("another-policy-payment");
        _settle(balance, _proof(balance, nextPayment, abi.encode(POLICY)));
        goods = _signal(taker, goodsParams);
        proof = _proof(goods, nextPayment, abi.encode(GOODS_POLICY));
        vm.expectRevert("Nullifier has already been used");
        _settle(goods, proof);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_DisputeProtectionOptOutIsScopedToEachDeposit() public {
        _setDisputeProtection(false);
        vm.startPrank(depositor);
        uint256 anotherDeposit = _createDeposit(address(0), delegate);
        vm.stopPrank();
        vm.expectRevert("ILH: Dispute protection disabled");
        _signalCall(taker, _balanceParams());
        IOrchestratorV3.SignalIntentParams memory params = _balanceParams();
        params.depositId = anotherDeposit;
        bytes32 intentHash = _signal(taker, params);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(POLICY)));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_FuturePayPalPolicyIsIsolatedFromVenmoAndReusesItsOwnMethod() public {
        _addPaymentMethod(PAYPAL);
        protection.setRiskWindow(PAYPAL, RISK_WINDOW);
        _setDisputeProtection(false);
        policy.setPolicy(PAYPAL_POLICY, PAYPAL, true);
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(MARKER, PAYPAL_POLICY);
        vm.expectRevert("ILH: Policy method mismatch");
        _signalCall(taker, params);
        params.paymentMethod = PAYPAL;
        params.data = abi.encode(MARKER, POLICY);
        vm.expectRevert("ILH: Policy method mismatch");
        _signalCall(taker, params);
        params.data = abi.encode(MARKER, PAYPAL_POLICY);
        bytes32 intentHash = _signal(taker, params);
        _settle(intentHash, _proof(intentHash, PAYMENT_ID, abi.encode(PAYPAL_POLICY)));
        assertTrue(nullifiers.isNullified(keccak256(abi.encodePacked(PAYPAL, PAYMENT_ID))));
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_ChangedMethodRouteBlocksPolicySignalAndSettlementButAllowsCancellation() public {
        bytes32 intentHash = _signalBalance();
        _setMethodVerifier(METHOD, address(verifier));
        vm.expectRevert("ILH: Wrong payment verifier");
        _signalCall(taker, _balanceParams());
        bytes memory uncheckedProof = abi.encode(INTENT_AMOUNT, block.timestamp, PAYEE, USD, intentHash);
        vm.expectRevert("ILH: Wrong payment verifier");
        _settle(intentHash, uncheckedProof);
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(token.balanceOf(taker), 0);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(_intentOrchestrator(intentHash), address(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, 500e6);
    }

    function test_ChangedMethodRouteStillAllowsMakerManualRelease() public {
        bytes32 intentHash = _signalBalance();
        _setMethodVerifier(METHOD, address(verifier));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(_intentOrchestrator(intentHash), address(0));
    }

    function test_ForeignOrchestratorCannotSettlePolicyIntent() public {
        bytes32 intentHash = _signalBalance();
        vm.prank(address(orchestratorMock));
        vm.expectRevert("ILH: Foreign intent");
        policy.settleIntent(
            IIntentLifecycleHook.SettlementContext(
                intentHash, address(token), taker, INTENT_AMOUNT, INTENT_AMOUNT, false
            )
        );
        assertEq(_intentOrchestrator(intentHash), address(orchestrator));
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
