// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {OrchestratorV3Fixture} from "./OrchestratorV3Fixture.sol";

abstract contract DisputeWindowBypassFixture is OrchestratorV3Fixture {
    event DisputeProtectionIntentStakeModeChanged(bytes32 indexed intentHash, address indexed stakeOwner, bool noStake);

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant PAYMENT_ID = keccak256("canonical-venmo-payment-id");
    uint64 internal constant RISK_WINDOW = 14 days;

    StakeVault internal vault;
    DisputeProtectionPolicy internal protection;
    NullifierRegistry internal disputeNullifiers;
    DisputeVerifier internal disputeVerifier;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV3 internal predecessor;
    UnifiedPaymentVerifierV4 internal upv;
    NullifierRegistryV2 internal nullifiers;
    IntentLifecycleHookV1 internal policy;
    IntentLifecycleHookV1 internal oldHook;

    function _defaultParams() internal view override returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = super._defaultParams();
        params.data = abi.encode(address(protection), abi.encode(false));
    }

    function setUp() public virtual override {
        vm.warp(1_000_000);
        super.setUp();
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        predecessor = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifiers, witnesses);
        predecessor.addPaymentMethod(METHOD);
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(predecessor), currencies);

        vault = new StakeVault(address(this), token, address(0), 1 days);
        disputeNullifiers = new NullifierRegistry();
        disputeVerifier = new DisputeVerifier(address(this), nullifiers, witnesses);
        protection = new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeNullifiers);
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        protection.setRiskWindow(METHOD, RISK_WINDOW);
        upv = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        upv.addPaymentMethod(METHOD);
        nullifiers.addWritePermission(address(upv));
        _routeVerifier(address(upv));
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(oldHook), true);
        policy = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(policy), true);
        orchestrator.setLifecycleHook(policy);
    }

    function _routeVerifier(address verifierAddress) internal {
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, verifierAddress, currencies);
    }

    function _setNoStake(bytes32 intentHash, bool noStake) internal {
        vm.prank(taker);
        protection.setIntentNoStake(orchestrator, intentHash, noStake);
    }

    function _stake() internal {
        token.transfer(taker, 500e6);
        vm.startPrank(taker);
        token.approve(address(vault), 500e6);
        vault.depositStake(500e6);
        vm.stopPrank();
    }

    function _signalUnstaked() internal returns (bytes32) {
        return _signal(taker, _unstakedParams());
    }

    function _unstakedParams() internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _defaultParams();
        params.data = abi.encode(address(protection), abi.encode(true));
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
        return _signedProof(
            intentHash, _data(intentHash, paymentId, suffix), INTENT_AMOUNT, WITNESS_KEY, upv.DOMAIN_SEPARATOR()
        );
    }

    function _signedProof(bytes32 hash, bytes memory data, uint256 amount, uint256 key, bytes32 domainSeparator)
        internal
        view
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
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

    function _settle(bytes32 intentHash, bytes memory proof) internal {
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
    }
}
