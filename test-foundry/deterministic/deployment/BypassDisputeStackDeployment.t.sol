// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
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
    DisputeProtectionPolicy internal freshPolicy;
    IntentLifecycleHookV1 internal predecessorHook;
    IntentLifecycleHookV1 internal freshHook;
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
        freshPolicy = new DisputeProtectionPolicy(address(this), freshVault, disputeVerifier, disputeNullifiers);
        freshVault.initializeController(address(freshPolicy));
        freshHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, freshPolicy);
        freshPolicy.setLifecycleHookAuthorization(address(freshHook), true);
        // Lane 45 copies nonzero windows in the pinned paypal, venmo order.
        freshPolicy.setRiskWindow(PAYPAL, predecessorPolicy.getRiskWindow(PAYPAL));
        freshPolicy.setRiskWindow(METHOD, predecessorPolicy.getRiskWindow(METHOD));
        successor = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        for (uint256 index; index < originalMethods.length; index++) {
            successor.addPaymentMethod(originalMethods[index]);
        }
    }

    function _activateLane46() private {
        disputeNullifiers.addWritePermission(address(freshPolicy));
        nullifiers.addWritePermission(address(successor));
        for (uint256 remaining = originalMethods.length; remaining > 0; remaining--) {
            paymentVerifierRegistry.removePaymentMethod(originalMethods[remaining - 1]);
        }
        for (uint256 index; index < originalMethods.length; index++) {
            bytes32 method = originalMethods[index];
            paymentVerifierRegistry.addPaymentMethod(method, address(successor), originalCurrencies[method]);
        }
        nullifiers.removeWritePermission(address(predecessor));
        orchestrator.setLifecycleHook(freshHook);
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
        assertEq(address(orchestrator.lifecycleHook()), address(freshHook));
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
        bytes32 first = _signalProtected(predecessorPolicy, false);
        _settle(first, _signedProof(first, PAYMENT_ID, predecessor.DOMAIN_SEPARATOR()));
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, PAYMENT_ID));
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        _activateLane46();
        bytes32 second = _signalProtected(freshPolicy, true);
        bytes memory proof = _signedProof(second, PAYMENT_ID, successor.DOMAIN_SEPARATOR());
        vm.expectRevert("Nullifier has already been used");
        _settle(second, proof);
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(nullifiers.nullifierByIntentHash(first), nullifier);
        assertEq(nullifiers.nullifierByIntentHash(second), bytes32(0));
        assertEq(orchestrator.getIntent(second).owner, taker);
        _assertRetiredVerifierCannotWrite(second);
    }

    function _assertRetiredVerifierCannotWrite(bytes32 intentHash) private {
        bytes32 paymentId = keccak256("fresh-payment-retired-verifier");
        bytes memory proof = _signedProof(intentHash, paymentId, predecessor.DOMAIN_SEPARATOR());
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.UnauthorizedWriter.selector, address(predecessor)));
        vm.prank(address(orchestrator));
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

    function _signalProtected(DisputeProtectionPolicy protection, bool noStake) private returns (bytes32) {
        IOrchestratorV3.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encode(address(protection), abi.encode(noStake));
        return _signal(taker, params);
    }

    function _attestationData(bytes32 intentHash, bytes32 paymentId) private view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        return abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash, intent.amount, METHOD, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
            ),
            true
        );
    }

    function _signedProof(bytes32 intentHash, bytes32 paymentId, bytes32 domain) private view returns (bytes memory) {
        bytes memory data = _attestationData(intentHash, paymentId);
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

    function _settle(bytes32 intentHash, bytes memory proof) private {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
