// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "./OrchestratorV3Fixture.sol";
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
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";

abstract contract DisputePolicyFixture is OrchestratorV3Fixture {
    bytes32 internal constant POLICY = keccak256("balance");
    bytes32 internal constant SECOND_POLICY = keccak256("another-policy");
    bytes32 internal constant GOODS_AND_SERVICES = keccak256("goods-and-services");
    uint64 internal constant GOODS_WINDOW = 90 days;
    bytes32 internal constant PAYMENT = keccak256("canonical-payment-id");
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint64 internal constant RISK = 14 days;

    DisputeProtectionPolicy internal policy;
    IntentLifecycleHookV1 internal hook;
    WhitelistPolicy internal whitelist;
    StakeVault internal vault;
    NullifierRegistry internal legacy;
    NullifierRegistryV2 internal payments;
    SimpleAttestationVerifier internal signatures;
    UnifiedPaymentVerifierV3 internal upv;

    event DisputeProtectionIntentSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 releaseAmount,
        uint64 releaseEligibleAt,
        bool isManualRelease
    );

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
        policy.setPolicy(METHOD, bytes32(0), RISK, true);
        orchestrator.setLifecycleHook(hook);
        upv.setAttestationVerifier(address(policy));
        policy.registerPolicyRoute(address(orchestrator), address(upv), address(signatures));
        policy.setPolicy(METHOD, POLICY, 0, true);
    }

    function _route(address paymentVerifier) internal {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, paymentVerifier, currencies);
    }

    function _policyParams(bytes32 policyId) internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _defaultParams();
        params.lifecycleHookData = abi.encode(policyId);
    }

    function _signalPolicy(bytes32 policyId) internal returns (bytes32) {
        return _signal(taker, _policyParams(policyId));
    }

    function _bypass() internal returns (bytes32) {
        return _signalPolicy(POLICY);
    }

    function _stake(uint256 amount) internal {
        token.transfer(taker, amount);
        vm.startPrank(taker);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _status(bytes32 intentHash, IDisputeProtectionPolicy.PolicyIntentStatus expected)
        internal
        view
    {
        assertEq(uint256(policy.getPolicyIntent(intentHash).status), uint256(expected));
    }

    function _assertUnsettled(bytes32 intentHash) internal view {
        assertEq(payments.nullifierByIntentHash(intentHash), bytes32(0));
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(token.balanceOf(taker), 0);
        _status(intentHash, IDisputeProtectionPolicy.PolicyIntentStatus.PENDING);
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
