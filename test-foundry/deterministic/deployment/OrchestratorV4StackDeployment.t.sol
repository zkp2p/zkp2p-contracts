// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";
import {OrchestratorV4} from "contracts/OrchestratorV4.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
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
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {UnifiedPaymentVerifierV3CallerHarness} from "../../mocks/UnifiedPaymentVerifierV3Harness.sol";

/// @dev Models deployer-owned lanes 45/46; Safe ownership acceptance is outside this model.
contract OrchestratorV4StackDeploymentTest is OrchestratorV3Fixture {
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
    WhitelistPolicy internal freshWhitelist;
    AddressGroupRegistry internal freshGroupRegistry;
    UnifiedPaymentVerifierV3 internal predecessor;
    UnifiedPaymentVerifierV4 internal successor;
    StakeVault internal predecessorVault;
    StakeVaultV2 internal freshVault;
    DisputeProtectionPolicy internal predecessorPolicy;
    DisputeProtectionPolicyV2 internal freshPolicy;
    IntentLifecycleHookV1 internal predecessorHook;
    OrchestratorV4 internal orchestratorV4;
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
        freshGroupRegistry = new AddressGroupRegistry();
        freshWhitelist = new WhitelistPolicy(freshGroupRegistry, escrowRegistry, orchestratorRegistry);
        freshVault = new StakeVaultV2(address(this), token);
        freshPolicy = new DisputeProtectionPolicyV2(
            address(this), freshVault, disputeVerifier, disputeNullifiers, orchestratorRegistry
        );
        freshVault.setController(address(freshPolicy), true);
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
            orchestrator.protocolFeeRecipient(),
            freshWhitelist
        );
        orchestratorV4.setSettlementPolicy(freshPolicy);
        if (orchestrator.allowMultipleIntents()) orchestratorV4.setAllowMultipleIntents(true);
    }

    function _activateLane46() private {
        assertFalse(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
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
        orchestratorRegistry.addOrchestrator(address(orchestratorV4));
    }

    function test_VaultAuthorizesPolicyWithPreexistingStake() public {
        assertEq(predecessorVault.controllerChangeDelay(), 2 days);
        assertTrue(freshVault.isController(address(freshPolicy)));
        StakeVaultV2 unauthorized = new StakeVaultV2(address(this), token);
        token.approve(address(unauthorized), INTENT_AMOUNT);
        unauthorized.depositStake(INTENT_AMOUNT);
        unauthorized.setController(address(freshPolicy), true);
        assertTrue(unauthorized.isController(address(freshPolicy)));
        assertEq(unauthorized.totalStaked(), INTENT_AMOUNT);
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
        assertEq(address(orchestratorV4.settlementPolicy()), address(freshPolicy));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestrator)));
        assertEq(address(freshPolicy.orchestratorRegistry()), address(orchestratorRegistry));
        assertTrue(predecessorPolicy.isLifecycleHookAuthorized(address(predecessorHook)));
        assertEq(predecessorVault.controller(), address(predecessorPolicy));
    }

    function test_ActivationPreservesReplayDomainAndRevokesUPV3Writes() public {
        _stake(address(predecessorVault));
        bytes32 first = _signalDefault();
        _settle(first, _predecessorProof(first, PAYMENT_ID));
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, PAYMENT_ID));
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        _activateLane46();
        bytes32 second = _signalO4();
        bytes memory proof = _successorProof(second, PAYMENT_ID, abi.encode(uint256(RISK_WINDOW)));
        vm.expectRevert("Nullifier has already been used");
        _settleO4(second, proof);
        assertEq(nullifiers.intentHashByNullifier(nullifier), first);
        assertEq(nullifiers.nullifierByIntentHash(first), nullifier);
        assertEq(nullifiers.nullifierByIntentHash(second), bytes32(0));
        assertEq(orchestratorV4.getIntent(second).owner, taker);
        _assertRetiredVerifierCannotWrite();
    }

    function _assertRetiredVerifierCannotWrite() private {
        // UPV3 only decodes the old intent layout; use O3 to reach the revoked-writer check.
        _stake(address(predecessorVault));
        bytes32 intentHash = _signalDefault();
        bytes32 paymentId = keccak256("fresh-payment-retired-verifier");
        bytes memory proof = _predecessorProof(intentHash, paymentId);
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

    function test_O4SignalRevertsBeforeRegistration() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrowV2.UnauthorizedCaller.selector, address(orchestratorV4), address(orchestratorRegistry)
            )
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
        assertEq(address(orchestratorV4.settlementPolicy()), address(freshPolicy));
        assertEq(address(orchestratorV4.whitelistPolicy()), address(freshWhitelist));
        assertNotEq(address(freshWhitelist), address(whitelist));
        assertEq(address(freshWhitelist.groupRegistry()), address(freshGroupRegistry));
        assertNotEq(address(freshGroupRegistry), address(whitelist.groupRegistry()));
        assertEq(address(predecessorHook.whitelistPolicy()), address(whitelist));
        assertFalse(orchestratorRegistry.isOrchestrator(address(orchestratorV4)));
    }

    function test_ExistingWhitelistDoesNotRestrictO4() public {
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), new address[](0));
        _deployLane45();
        assertTrue(whitelist.enabled(address(escrow), depositId, METHOD));
        assertFalse(freshWhitelist.enabled(address(escrow), depositId, METHOD));
        assertEq(address(freshWhitelist.groupRegistry()), address(freshGroupRegistry));
        assertEq(address(orchestratorV4.whitelistPolicy()), address(freshWhitelist));
        _activateLane46();
        bytes32 id = _signalO4();
        assertEq(orchestratorV4.getIntent(id).owner, taker);
        assertTrue(whitelist.enabled(address(escrow), depositId, METHOD));
        assertEq(address(predecessorHook.whitelistPolicy()), address(whitelist));
    }

    function test_O3PendingIntentFulfilsThroughUPV4AfterCutover() public {
        _stake(address(predecessorVault));
        bytes32 id = _signalDefault();
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        _activateLane46();
        _settle(id, _successorProof(id, PAYMENT_ID, abi.encode(uint256(RISK_WINDOW))));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(
            uint256(predecessorPolicy.getDisputeProtectionIntent(id).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(address(orchestrator.lifecycleHook()), address(predecessorHook));
    }

    function test_O3PendingIntentIgnoresSettlementDataAfterCutover() public {
        _stake(address(predecessorVault));
        bytes32 id = _signalDefault();
        _activateLane46();
        _settle(id, _successorProof(id, PAYMENT_ID, hex"010203deadbeef"));
        assertEq(token.balanceOf(taker), INTENT_AMOUNT);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(predecessorVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(
            uint256(predecessorPolicy.getDisputeProtectionIntent(id).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
    }

    function test_O4DeferredSettlementAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        assertEq(freshVault.stakeBalance(taker), 0);
        uint64 window = 37 hours;
        _settleO4(id, _successorProof(id, PAYMENT_ID, abi.encode(uint256(window))));
        assertEq(freshPolicy.getProtection(id).depositor, depositor);
        assertEq(freshPolicy.getProtection(id).paymentMethod, METHOD);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(address(freshVault)), INTENT_AMOUNT);
        (address owner, uint256 amount, uint64 maturesAt) = freshVault.locks(id);
        assertEq(owner, other);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, block.timestamp + window);
    }

    function test_O4StakeSettlementUsesAttestedWindowAfterCutover() public {
        _activateLane46();
        _stake(address(freshVault));
        bytes32 id = _signalO4();
        assertEq(freshVault.lockedStake(taker), 0);
        uint64 window = 3 days;
        _settleO4(id, _successorProof(id, PAYMENT_ID, abi.encode(uint256(window))));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(freshVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(freshPolicy.getProtection(id).depositor, depositor);
        (address owner, uint256 amount, uint64 maturesAt) = freshVault.locks(id);
        assertEq(owner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, block.timestamp + window);
    }

    function test_O4WindowZeroPaysNowAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        _settleO4(id, _successorProof(id, PAYMENT_ID, abi.encode(uint256(0))));
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(freshVault)), 0);
        assertEq(freshVault.lockedStake(other), 0);
        assertEq(freshPolicy.getProtection(id).depositor, address(0));
    }

    function test_O4WhitelistedTakerSkipsPolicyAfterCutover() public {
        _activateLane46();
        address[] memory takers = new address[](1);
        takers[0] = taker;
        vm.prank(depositor);
        freshWhitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), takers);
        bytes32 id = _signalO4();
        assertTrue(orchestratorV4.getIntent(id).takerWhitelisted);
        bytes memory proof = _successorProof(id, PAYMENT_ID, abi.encode(uint256(RISK_WINDOW)));
        vm.mockCallRevert(address(freshPolicy), bytes(""), bytes("policy called"));
        vm.mockCallRevert(address(freshVault), bytes(""), bytes("vault called"));
        vm.recordLogs();
        _settleO4(id, proof);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(freshPolicy));
        }
        vm.clearMockedCalls();
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(freshVault)), 0);
        assertEq(freshPolicy.getProtection(id).depositor, address(0));
    }

    function test_O4ManualReleasePaysNowAfterCutover() public {
        _activateLane46();
        bytes32 id = _signalO4();
        uint256 vaultBalance = token.balanceOf(address(freshVault));
        vm.prank(depositor);
        orchestratorV4.releaseFundsToPayer(id, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), INTENT_AMOUNT);
        assertEq(token.balanceOf(address(freshVault)), vaultBalance);
        assertEq(freshVault.lockedStake(other), 0);
        assertEq(freshPolicy.getProtection(id).depositor, address(0));
    }

    function test_O4ProtectionIgnoresAugustOptOut() public {
        vm.prank(depositor);
        predecessorPolicy.setDisputeProtectionEnabled(address(escrow), depositId, METHOD, false);
        _deployLane45();
        _activateLane46();
        assertFalse(predecessorPolicy.isDisputeProtectionEnabled(address(escrow), depositId, METHOD));
        bytes32 protectedId = _signalO4();
        assertEq(freshPolicy.getProtection(protectedId).depositor, address(0));
        _settleO4(protectedId, _successorProof(protectedId, PAYMENT_ID, abi.encode(uint256(RISK_WINDOW))));
        assertEq(freshPolicy.getProtection(protectedId).depositor, depositor);
        assertEq(freshVault.lockedStake(other), INTENT_AMOUNT);
        vm.prank(depositor);
        freshWhitelist.setEnabled(address(escrow), depositId, METHOD, true);
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.TakerNotWhitelisted.selector, taker, address(escrow), depositId, METHOD
            )
        );
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
    }

    function test_O4GroupArbitratorComesFromTheFreshRegistryAfterCutover() public {
        _activateLane46();
        address arbitrator = makeAddr("arbitrator");
        address[] memory members = new address[](1);
        members[0] = taker;
        bytes32[] memory groups = new bytes32[](1);
        vm.startPrank(depositor);
        groups[0] = freshGroupRegistry.createGroup("o4-staging");
        freshGroupRegistry.setArbitrator(groups[0], arbitrator);
        freshGroupRegistry.addMembers(groups[0], members);
        freshWhitelist.configureDeposit(address(escrow), depositId, METHOD, false, groups, new address[](0));
        vm.stopPrank();
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        params.to = other;
        params.groupId = groups[0];
        bytes32 id = _nextO4IntentHash();
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
        assertEq(orchestratorV4.getIntent(id).arbitrator, arbitrator);
        assertFalse(orchestratorV4.getIntent(id).takerWhitelisted);
        vm.prank(arbitrator);
        orchestratorV4.releaseFundsToPayer(id, INTENT_AMOUNT / 2);
        assertEq(token.balanceOf(other), INTENT_AMOUNT / 2);
        assertEq(freshPolicy.getProtection(id).depositor, address(0));
    }

    function test_CutoverEndsV1FulfilmentThroughTheSharedRegistry() public {
        // A V1 orchestrator stays registered on Base and staging and routes through the same payment registry.
        UnifiedPaymentVerifierV3CallerHarness v1 = new UnifiedPaymentVerifierV3CallerHarness();
        orchestratorRegistry.addOrchestrator(address(v1));
        bytes32 beforeCutover = _setV1Intent(v1, keccak256("v1-before-cutover"));
        v1.verifyPayment(
            IPaymentVerifier(paymentVerifierRegistry.getVerifier(METHOD)),
            IPaymentVerifier.VerifyPaymentData(
                beforeCutover, _predecessorProof(beforeCutover, INTENT_AMOUNT, block.timestamp, keccak256("v1-before")), ""
            )
        );
        _activateLane46();
        bytes32 afterCutover = _setV1Intent(v1, keccak256("v1-after-cutover"));
        bytes32 paymentId = keccak256("v1-after");
        bytes memory proof =
            _successorProof(afterCutover, INTENT_AMOUNT, block.timestamp, paymentId, abi.encode(uint256(0)));
        IPaymentVerifier routed = IPaymentVerifier(paymentVerifierRegistry.getVerifier(METHOD));
        assertEq(address(routed), address(successor));
        vm.expectRevert("UPV: Unsupported orchestrator");
        v1.verifyPayment(routed, IPaymentVerifier.VerifyPaymentData(afterCutover, proof, ""));
        assertFalse(nullifiers.isNullified(keccak256(abi.encodePacked(METHOD, paymentId))));
    }

    function _setV1Intent(UnifiedPaymentVerifierV3CallerHarness v1, bytes32 intentHash) private returns (bytes32) {
        v1.setIntent(
            intentHash,
            IOrchestrator.Intent(
                taker, taker, address(escrow), depositId, INTENT_AMOUNT, block.timestamp, METHOD, USD,
                CONVERSION_RATE, PAYEE, address(0), 0, IPostIntentHook(address(0)), ""
            )
        );
        return intentHash;
    }

    function _stake(address target) private {
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(target, INTENT_AMOUNT);
        // StakeVault and StakeVaultV2 share the depositStake(uint256) selector.
        StakeVaultV2(target).depositStake(INTENT_AMOUNT);
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
            payerCommitment: "",
            groupId: bytes32(0)
        });
    }

    function _nextO4IntentHash() private view returns (bytes32) {
        return bytes32(
            uint256(keccak256(abi.encodePacked(address(orchestratorV4), orchestratorV4.intentCounter())))
                % CIRCOM_PRIME_FIELD
        );
    }

    function _signalO4() private returns (bytes32 id) {
        id = _nextO4IntentHash();
        IOrchestratorV4.SignalIntentParams memory params = _defaultV4Params();
        params.to = other;
        vm.prank(taker);
        orchestratorV4.signalIntent(params);
    }

    function _intentAmountAndTimestamp(bytes32 intentHash) private view returns (uint256 amount, uint256 timestamp) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        if (intent.owner != address(0)) return (intent.amount, intent.timestamp);
        IOrchestratorV4.Intent memory intentV4 = orchestratorV4.getIntent(intentHash);
        return (intentV4.amount, intentV4.timestamp);
    }

    /// @dev UPV3 payload: abi.encode(PaymentDetails, IntentSnapshot), 448 bytes.
    function _predecessorProof(bytes32 intentHash, bytes32 paymentId) private view returns (bytes memory) {
        (uint256 amount, uint256 timestamp) = _intentAmountAndTimestamp(intentHash);
        return _predecessorProof(intentHash, amount, timestamp, paymentId);
    }

    function _predecessorProof(bytes32 intentHash, uint256 amount, uint256 timestamp, bytes32 paymentId)
        private
        view
        returns (bytes memory)
    {
        bytes memory data = abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash, amount, METHOD, USD, PAYEE, CONVERSION_RATE, timestamp, 0
            )
        );
        assertEq(data.length, 448);
        return _signedProof(intentHash, data, predecessor.DOMAIN_SEPARATOR());
    }

    /// @dev UPV4 payload: abi.encode(PaymentDetails, IntentSnapshot, bytes settlementData).
    function _successorProof(bytes32 intentHash, bytes32 paymentId, bytes memory settlementData)
        private
        view
        returns (bytes memory)
    {
        (uint256 amount, uint256 timestamp) = _intentAmountAndTimestamp(intentHash);
        return _successorProof(intentHash, amount, timestamp, paymentId, settlementData);
    }

    function _successorProof(
        bytes32 intentHash,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes memory settlementData
    ) private view returns (bytes memory) {
        bytes memory data = abi.encode(
            IPaymentVerifierV2.PaymentDetails(METHOD, PAYEE, 5000, USD, block.timestamp * 1000, paymentId),
            IPaymentVerifierV2.IntentSnapshot(
                intentHash, amount, METHOD, USD, PAYEE, CONVERSION_RATE, timestamp, 0, bytes32(0)
            ),
            settlementData
        );
        return _signedProof(intentHash, data, successor.DOMAIN_SEPARATOR());
    }

    function _signedProof(bytes32 intentHash, bytes memory data, bytes32 domain) private pure returns (bytes memory) {
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
        orchestratorV4.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, intentHash, ""));
    }

    function _settle(bytes32 intentHash, bytes memory proof) private {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
