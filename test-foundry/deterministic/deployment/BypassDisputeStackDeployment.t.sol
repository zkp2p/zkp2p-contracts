// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
import {OrchestratorV4} from "contracts/OrchestratorV4.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";

/// @dev Models deployer-owned lanes 45/46; Safe ownership acceptance is outside this model.
contract BypassDisputeStackDeploymentTest is OrchestratorV3Fixture {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint64 internal constant RISK_WINDOW = 14 days;
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant PAYMENT_ID = keccak256("pre-cutover-payment");

    NullifierRegistryV2 internal nullifiers;
    NullifierRegistry internal disputeNullifiers;
    MultiAttestationVerifier internal witnesses;
    DisputeVerifier internal disputeVerifier;
    WhitelistPolicy internal whitelist;
    UnifiedPaymentVerifierV3 internal predecessor;
    UnifiedPaymentVerifierV4 internal successor;
    StakeVault internal predecessorVault;
    StakeVault internal freshVault;
    DisputeProtectionPolicy internal predecessorPolicy;
    DisputeProtectionPolicyV2 internal freshPolicy;
    IntentLifecycleHookV1 internal predecessorHook;
    IntentLifecycleHookV2 internal freshHook;
    OrchestratorV4 internal orchestratorV4;
    UnifiedPaymentVerifierV4 internal staleVerifier;
    StakeVault internal staleVault;
    DisputeProtectionPolicy internal stalePolicy;
    bytes32[] internal originalMethods;
    mapping(bytes32 => bytes32[]) internal originalCurrencies;

    function setUp() public override {
        vm.warp(1_000_000);
        super.setUp();
        _deployPredecessor();
        _deployLane45();
    }

    function _deployPredecessor() private {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        predecessor = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifiers, witnesses);
        nullifiers.addWritePermission(address(predecessor));
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        _registerMethod(METHOD, _currencies(false));
        _registerMethod(PAYPAL, _currencies(true));
        _registerMethod(ZELLE, _currencies(false));
        originalMethods = paymentVerifierRegistry.getPaymentMethods();

        predecessorVault = new StakeVault(address(this), token, address(0), 2 days);
        disputeNullifiers = new NullifierRegistry();
        disputeVerifier = new DisputeVerifier(address(this), nullifiers, witnesses);
        predecessorPolicy =
            new DisputeProtectionPolicy(address(this), predecessorVault, disputeVerifier, disputeNullifiers);
        predecessorVault.initializeController(address(predecessorPolicy));
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        predecessorHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, predecessorPolicy);
        predecessorPolicy.setLifecycleHookAuthorization(address(predecessorHook), true);
        predecessorPolicy.setRiskWindow(PAYPAL, RISK_WINDOW);
        predecessorPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        disputeNullifiers.addWritePermission(address(predecessorPolicy));
        orchestrator.setLifecycleHook(predecessorHook);
    }

    function _currencies(bool multi) private pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](multi ? 3 : 1);
        currencies[0] = USD;
        if (multi) {
            currencies[1] = keccak256("EUR");
            currencies[2] = keccak256("GBP");
        }
    }

    function _registerMethod(bytes32 method, bytes32[] memory currencies) private {
        predecessor.addPaymentMethod(method);
        paymentVerifierRegistry.addPaymentMethod(method, address(predecessor), currencies);
        originalCurrencies[method] = currencies;
    }

    function _deployLane45() private {
        freshVault = new StakeVault(address(this), token, address(0), 0);
        freshPolicy = new DisputeProtectionPolicyV2(
            address(this),
            freshVault,
            disputeVerifier,
            disputeNullifiers
        );
        freshVault.initializeController(address(freshPolicy));
        freshHook = new IntentLifecycleHookV2(orchestratorRegistry, whitelist, freshPolicy);
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), true);
        // Lane 45 copies nonzero windows in the pinned paypal, venmo order.
        freshPolicy.setRiskWindow(PAYPAL, predecessorPolicy.getRiskWindow(PAYPAL));
        freshPolicy.setRiskWindow(METHOD, predecessorPolicy.getRiskWindow(METHOD));
        successor = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        for (uint256 index; index < originalMethods.length; index++) {
            successor.addPaymentMethod(originalMethods[index]);
        }
        orchestratorV4 = new OrchestratorV4(
            address(this),
            orchestrator.chainId(),
            address(orchestrator.escrowRegistry()),
            address(orchestrator.paymentVerifierRegistry()),
            address(orchestrator.relayerRegistry()),
            orchestrator.protocolFee(),
            orchestrator.protocolFeeRecipient()
        );
        orchestratorV4.setLifecycleHook(freshHook);
        if (orchestrator.allowMultipleIntents()) orchestratorV4.setAllowMultipleIntents(true);
    }

    function _activateLane46() private {
        disputeNullifiers.addWritePermission(address(freshPolicy));
        _rotateVerifierAndRegister(address(predecessor));
    }

    function _rotateVerifierAndRegister(address retiredVerifier) private {
        assertFalse(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
        nullifiers.addWritePermission(address(successor));
        for (uint256 remaining = originalMethods.length; remaining > 0; remaining--) {
            paymentVerifierRegistry.removePaymentMethod(originalMethods[remaining - 1]);
        }
        for (uint256 index; index < originalMethods.length; index++) {
            bytes32 method = originalMethods[index];
            paymentVerifierRegistry.addPaymentMethod(method, address(successor), originalCurrencies[method]);
        }
        nullifiers.removeWritePermission(retiredVerifier);
        orchestratorRegistry.addOrchestrator(address(orchestratorV4));
    }

    function test_ZeroDelayVaultInitializesBeforeLiabilities() public {
        assertEq(predecessorVault.controllerChangeDelay(), 2 days);
        assertEq(freshVault.controllerChangeDelay(), 0);
        assertEq(freshVault.controller(), address(freshPolicy));
        assertEq(freshPolicy.getRiskWindow(PAYPAL), RISK_WINDOW);
        assertEq(freshPolicy.getRiskWindow(METHOD), RISK_WINDOW);
        assertEq(freshPolicy.getRiskWindow(ZELLE), 0);
        StakeVault uninitialized = new StakeVault(address(this), token, address(0), 0);
        token.approve(address(uninitialized), INTENT_AMOUNT);
        uninitialized.depositStake(INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.ControllerInitializationWithLiabilities.selector, INTENT_AMOUNT, 0)
        );
        uninitialized.initializeController(address(freshPolicy));
        assertEq(uninitialized.controller(), address(0));
        assertEq(uninitialized.totalStaked(), INTENT_AMOUNT);
    }

    function test_ActivationPreservesRegistryOrderAndCurrencies() public {
        bytes32[] memory beforeMethods = paymentVerifierRegistry.getPaymentMethods();
        assertEq(beforeMethods.length, 3);
        assertEq(beforeMethods[0], METHOD);
        assertEq(beforeMethods[1], PAYPAL);
        assertEq(beforeMethods[2], ZELLE);
        assertEq(successor.getPaymentMethods(), beforeMethods);
        for (uint256 index; index < beforeMethods.length; index++) {
            assertEq(paymentVerifierRegistry.getVerifier(beforeMethods[index]), address(predecessor));
            assertEq(
                paymentVerifierRegistry.getCurrencies(beforeMethods[index]), originalCurrencies[beforeMethods[index]]
            );
        }
        _activateLane46();
        assertEq(paymentVerifierRegistry.getPaymentMethods(), beforeMethods);
        for (uint256 index; index < beforeMethods.length; index++) {
            assertEq(paymentVerifierRegistry.getVerifier(beforeMethods[index]), address(successor));
            assertEq(
                paymentVerifierRegistry.getCurrencies(beforeMethods[index]), originalCurrencies[beforeMethods[index]]
            );
        }
    }

    function test_ActivationRotatesPaymentWriterAndRetainsPredecessorDisputeWriter() public {
        address[] memory expected = new address[](1);
        expected[0] = address(predecessor);
        assertEq(nullifiers.getWriters(), expected);
        expected[0] = address(predecessorPolicy);
        assertEq(disputeNullifiers.getWriters(), expected);
        assertEq(address(orchestrator.lifecycleHook()), address(predecessorHook));
        _activateLane46();
        expected[0] = address(successor);
        assertEq(nullifiers.getWriters(), expected);
        expected = new address[](2);
        expected[0] = address(predecessorPolicy);
        expected[1] = address(freshPolicy);
        assertEq(disputeNullifiers.getWriters(), expected);
        assertEq(address(orchestrator.lifecycleHook()), address(predecessorHook));
        assertEq(address(orchestratorV4.lifecycleHook()), address(freshHook));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestrator)));
        assertTrue(predecessorPolicy.isLifecycleHookAuthorized(address(predecessorHook)));
        assertTrue(freshPolicy.isLifecycleHookAuthorized(address(freshHook)));
        assertEq(predecessorVault.controller(), address(predecessorPolicy));
    }

    function test_ActivationPreservesReplayDomainAndRevokesUPV3Writes() public {
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(predecessorVault), INTENT_AMOUNT);
        predecessorVault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 first = _signalDefault();
        _settle(first, _signedProof(first, PAYMENT_ID, predecessor.DOMAIN_SEPARATOR(), false));
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, PAYMENT_ID));
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        _activateLane46();
        bytes32 second = _signalO4();
        bytes memory proof = _signedProof(second, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true);
        vm.expectRevert("Nullifier has already been used");
        _settleO4(second, proof);
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(nullifiers.nullifierByIntentHash(first), nullifier);
        assertEq(nullifiers.nullifierByIntentHash(second), bytes32(0));
        assertEq(orchestratorV4.getIntent(second).owner, taker);
        _assertRetiredVerifierCannotWrite(second);
    }

    function _assertRetiredVerifierCannotWrite(bytes32 intentHash) private {
        bytes32 paymentId = keccak256("fresh-payment-retired-verifier");
        bytes memory proof = _signedProof(intentHash, paymentId, predecessor.DOMAIN_SEPARATOR(), false);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.UnauthorizedWriter.selector, address(predecessor)));
        vm.prank(address(orchestratorV4));
        predecessor.verifyPayment(IPaymentVerifier.VerifyPaymentData(intentHash, proof, ""));
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, paymentId))));
    }

    function test_ForwardRemoveAndReaddReordersSwapAndPopRegistry() public {
        // Interleaving forward removals with re-adds changes order. Removing ALL methods first
        // and re-adding a saved original list would preserve order even with forward removals.
        for (uint256 index; index < originalMethods.length; index++) {
            bytes32 method = originalMethods[index];
            paymentVerifierRegistry.removePaymentMethod(method);
            paymentVerifierRegistry.addPaymentMethod(method, address(successor), originalCurrencies[method]);
        }
        bytes32[] memory actual = paymentVerifierRegistry.getPaymentMethods();
        assertEq(actual.length, 3);
        assertEq(actual[0], PAYPAL);
        assertEq(actual[1], METHOD);
        assertEq(actual[2], ZELLE);
        assertNotEq(keccak256(abi.encode(actual)), keccak256(abi.encode(originalMethods)));
    }

    function test_O4SignalRevertsBeforeRegistration() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        vm.expectRevert(
            abi.encodeWithSelector(IntentLifecycleHookV2.UnauthorizedOrchestrator.selector, address(orchestratorV4))
        );
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
    }

    function test_O4ConfigMatchesO3() public view {
        assertEq(orchestratorV4.owner(), orchestrator.owner());
        assertFalse(orchestratorV4.paused());
        assertEq(orchestratorV4.chainId(), orchestrator.chainId());
        assertEq(address(orchestratorV4.escrowRegistry()), address(orchestrator.escrowRegistry()));
        assertEq(address(orchestratorV4.paymentVerifierRegistry()), address(orchestrator.paymentVerifierRegistry()));
        assertEq(address(orchestratorV4.relayerRegistry()), address(orchestrator.relayerRegistry()));
        assertEq(orchestratorV4.protocolFee(), orchestrator.protocolFee());
        assertEq(orchestratorV4.protocolFeeRecipient(), orchestrator.protocolFeeRecipient());
        assertEq(orchestratorV4.allowMultipleIntents(), orchestrator.allowMultipleIntents());
        assertEq(address(orchestratorV4.lifecycleHook()), address(freshHook));
        assertFalse(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
    }

    function test_O3PendingIntentFulfilsThroughUPV4AfterCutover() public {
        _stake(predecessorVault);
        bytes32 id = _signalDefault();
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        _activateLane46();
        _settle(id, _signedProof(id, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(
            uint256(predecessorPolicy.getDisputeProtectionIntent(id).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(address(orchestrator.lifecycleHook()), address(predecessorHook));
    }

    function test_O3PendingIntentFulfilsThroughUPV4WithExtensionAfterCutover() public {
        _stake(predecessorVault);
        bytes32 id = _signalDefault();
        _activateLane46();
        _settle(id, _signedProof(id, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true, false, hex"010203deadbeef"));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(uint256(predecessorPolicy.getDisputeProtectionIntent(id).status), uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED));
    }

    function test_O4FulfilsThroughUPV4WithExtensionAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        _settleO4(id, _signedProof(id, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true, true, abi.encode(bytes32(0), keccak256("reserved"))));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(orchestratorV4.getIntent(id).owner, address(0));
    }

    function test_O4DeferredSettlementAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        assertEq(freshVault.stakeBalance(taker), 0);
        _settleO4(id, _signedProof(id, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true));
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(address(freshVault)), INTENT_AMOUNT);
        (address owner, uint256 amount,) = freshVault.locks(id);
        assertEq(owner, other);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(id).collateralSource),
            uint256(P.CollateralSource.DEFERRED_PAYOUT)
        );
    }

    function test_O4BalanceFundedPaysNowAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        _settleO4(id, _signedProof(id, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true, true));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(freshVault)), 0);
        assertEq(freshVault.lockedStake(other), 0);
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.BYPASS)
        );
    }

    function test_O4ManualReleasePaysNowAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        uint256 vaultBalance = token.balanceOf(address(freshVault));
        vm.prank(depositor);
        orchestratorV4.releaseFundsToPayer(id);
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(freshVault)), vaultBalance);
        assertEq(freshVault.lockedStake(other), 0);
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(id).collateralSource),
            uint256(P.CollateralSource.MANUAL_RELEASE)
        );
    }

    function test_O4IgnoresAugustOptOutUntilDepositorOptsOutAgain() public {
        vm.prank(depositor);
        predecessorPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        _deployLane45();
        _activateLane46();
        assertFalse(predecessorPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
        assertTrue(freshPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
        bytes32 protectedId = _signalO4();
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(protectedId).status),
            uint256(P.DisputeProtectionIntentStatus.PENDING)
        );
        _settleO4(protectedId, _signedProof(protectedId, PAYMENT_ID, successor.DOMAIN_SEPARATOR(), true));
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(protectedId).collateralSource),
            uint256(P.CollateralSource.DEFERRED_PAYOUT)
        );
        assertEq(freshVault.lockedStake(other), INTENT_AMOUNT);
        vm.prank(depositor);
        freshPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        assertFalse(freshPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
        bytes32 optedOutId = _signalO4();
        assertEq(
            uint256(freshPolicy.getDisputeProtectionIntent(optedOutId).status),
            uint256(P.DisputeProtectionIntentStatus.NONE)
        );
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV2.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker
            )
        );
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
    }

    function test_StagingModelRestoresO3HookAndRetiresStaleVerifier() public {
        _prepareStaging();
        _stake(staleVault);
        bytes32 pending = _signalDefault();
        assertEq(staleVault.lockedStake(taker), INTENT_AMOUNT);
        bytes32[] memory opened = new bytes32[](1);
        opened[0] = pending;
        // Staging commits these two actions before checking the drain precondition.
        orchestrator.setLifecycleHook(predecessorHook);
        disputeNullifiers.addWritePermission(address(freshPolicy));
        vm.expectRevert("Stale bypass intents still open");
        this.rotateStaging(opened);
        assertFalse(nullifiers.isWriter(address(successor)));
        assertFalse(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
        vm.prank(taker);
        orchestrator.cancelIntent(pending);
        this.rotateStaging(opened);
        assertEq(address(orchestrator.lifecycleHook()), address(predecessorHook));
        address[] memory expected = new address[](1);
        expected[0] = address(successor);
        assertEq(nullifiers.getWriters(), expected);
        assertTrue(disputeNullifiers.isWriter(address(stalePolicy)));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
        bytes32 id = _signalO4();
        bytes memory proof = _signedProof(id, PAYMENT_ID, staleVerifier.DOMAIN_SEPARATOR(), true);
        vm.expectRevert(
            abi.encodeWithSelector(INullifierRegistryV2.UnauthorizedWriter.selector, address(staleVerifier))
        );
        vm.prank(address(orchestratorV4));
        staleVerifier.verifyPayment(IPaymentVerifier.VerifyPaymentData(id, proof, ""));
    }

    function _stake(StakeVault target) private {
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(target), INTENT_AMOUNT);
        target.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
    }

    function _defaultV4Params() private view returns (IOrchestratorV4.SignalIntentParams memory) {
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        return IOrchestratorV4.SignalIntentParams({
            escrow: params.escrow,
            depositId: params.depositId,
            amount: params.amount,
            to: params.to,
            paymentMethod: params.paymentMethod,
            fiatCurrency: params.fiatCurrency,
            conversionRate: params.conversionRate,
            referralFees: params.referralFees,
            gatingServiceSignature: params.gatingServiceSignature,
            signatureExpiration: params.signatureExpiration,
            postIntentHook: params.postIntentHook,
            preIntentHookData: params.preIntentHookData,
            data: params.data,
            lifecycleHookData: ""
        });
    }

    function _signalO4() private returns (bytes32 id) {
        id = bytes32(
            uint256(keccak256(abi.encodePacked(address(orchestratorV4), orchestratorV4.intentCounter())))
                % CIRCOM_PRIME_FIELD
        );
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        params.to = other;
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
    }

    function _prepareStaging() private {
        orchestrator.setAllowMultipleIntents(false);
        _deployLane45();
        staleVerifier = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        nullifiers.removeWritePermission(address(predecessor));
        nullifiers.addWritePermission(address(staleVerifier));
        for (uint256 remaining = originalMethods.length; remaining > 0; remaining--) {
            paymentVerifierRegistry.removePaymentMethod(originalMethods[remaining - 1]);
        }
        for (uint256 index; index < originalMethods.length; index++) {
            bytes32 method = originalMethods[index];
            staleVerifier.addPaymentMethod(method);
            paymentVerifierRegistry.addPaymentMethod(method, address(staleVerifier), originalCurrencies[method]);
        }
        staleVault = new StakeVault(address(this), token, address(0), 0);
        stalePolicy = new DisputeProtectionPolicy(address(this), staleVault, disputeVerifier, disputeNullifiers);
        staleVault.initializeController(address(stalePolicy));
        // The held no-stake policy is absent; V1 models its pending/cancelled lifecycle.
        IntentLifecycleHookV1 staleHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, stalePolicy);
        stalePolicy.setLifecycleHookAuthorization(address(staleHook), true);
        stalePolicy.setRiskWindow(METHOD, RISK_WINDOW);
        disputeNullifiers.addWritePermission(address(stalePolicy));
        orchestrator.setLifecycleHook(staleHook);
        assertEq(orchestratorV4.allowMultipleIntents(), orchestrator.allowMultipleIntents());
        assertEq(paymentVerifierRegistry.getVerifier(METHOD), address(staleVerifier));
    }

    function rotateStaging(bytes32[] calldata opened) external {
        require(msg.sender == address(this));
        for (uint256 index; index < opened.length; index++) {
            require(
                stalePolicy.getDisputeProtectionIntent(opened[index]).status
                    != IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING,
                "Stale bypass intents still open"
            );
        }
        _rotateVerifierAndRegister(address(staleVerifier));
    }

    function _attestationData(bytes32 intentHash, bytes32 paymentId) private view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        if (intent.owner == address(0)) intent = abi.decode(abi.encode(orchestratorV4.getIntent(intentHash)), (IOrchestratorV3.Intent));
        return abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash, intent.amount, METHOD, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
            )
        );
    }

    function _signedProof(bytes32 intentHash, bytes32 paymentId, bytes32 domain, bool v4)
        private
        view
        returns (bytes memory)
    {
        return _signedProof(intentHash, paymentId, domain, v4, false);
    }

    function _signedProof(bytes32 intentHash, bytes32 paymentId, bytes32 domain, bool v4, bool balanceFunded)
        private
        view
        returns (bytes memory)
    {
        return _signedProof(intentHash, paymentId, domain, v4, balanceFunded, "");
    }

    function _signedProof(bytes32 intentHash, bytes32 paymentId, bytes32 domain, bool v4, bool balanceFunded, bytes memory extensionData)
        private view returns (bytes memory)
    {
        bytes memory data = _attestationData(intentHash, paymentId);
        assertEq(data.length, 448);
        // Plain UPV4 proofs need no extension. When present, word 0 is the balance flag.
        if (v4 && (balanceFunded || extensionData.length != 0)) {
            data = bytes.concat(data, abi.encode(uint256(balanceFunded ? 1 : 0)));
        }
        data = bytes.concat(data, extensionData);
        bytes32 dataHash = keccak256(data);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                intentHash,
                INTENT_AMOUNT,
                dataHash
            )
        );
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
            vm.sign(WITNESS_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(signatureR, signatureS, recovery);
        return abi.encode(
            UnifiedPaymentVerifierV3.PaymentAttestation(intentHash, INTENT_AMOUNT, dataHash, signatures, data, "")
        );
    }

    function _settleO4(bytes32 intentHash, bytes memory proof) private {
        orchestratorV4.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, intentHash, "", ""));
    }

    function _settle(bytes32 intentHash, bytes memory proof) private {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
