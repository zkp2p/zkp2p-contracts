// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";

import {OrchestratorV4Fixture} from "./OrchestratorV4Fixture.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";

abstract contract DisputeProtectionStackV2Fixture is OrchestratorV4Fixture {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint64 internal constant RISK_WINDOW = 14 days;
    uint256 internal constant PROTOCOL_FEE = 5e15;
    uint256 internal constant REFERRAL_FEE = 3e15;
    uint256 internal constant NET = INTENT_AMOUNT - INTENT_AMOUNT * PROTOCOL_FEE / 1e18 - INTENT_AMOUNT * REFERRAL_FEE / 1e18;
    StakeVault internal vault;
    DisputeProtectionPolicyV2 internal protection;
    NullifierRegistry internal disputeNullifiers;
    DisputeVerifier internal disputeVerifier;
    WhitelistPolicy internal whitelist;
    MultiAttestationVerifier internal witnesses;
    UnifiedPaymentVerifierV4 internal upv;
    NullifierRegistryV2 internal nullifiers;

    function setUp() public virtual override {
        vm.warp(1_000_000);
        super.setUp();
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        upv = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifiers, witnesses);
        upv.addPaymentMethod(METHOD);
        nullifiers.addWritePermission(address(upv));
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(upv), currencies);
        vault = new StakeVault(address(this), token, address(0), 0);
        disputeNullifiers = new NullifierRegistry();
        disputeVerifier = new DisputeVerifier(address(this), nullifiers, witnesses);
        protection = new DisputeProtectionPolicyV2(address(this), vault, disputeVerifier, disputeNullifiers);
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        protection.setRiskWindow(METHOD, RISK_WINDOW);
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        IntentLifecycleHookV2 hook = new IntentLifecycleHookV2(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(hook), true);
        orchestrator.setLifecycleHook(hook);
        orchestrator.setProtocolFee(PROTOCOL_FEE);
    }

    function _defaultParams() internal view override returns (IOrchestratorV4.SignalIntentParams memory params) {
        params = super._defaultParams();
        params.to = other;
        params.referralFees = new IReferralFee.ReferralFee[](1);
        params.referralFees[0] = IReferralFee.ReferralFee(referrer, REFERRAL_FEE);
    }

    function _stake(StakeVault target, address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(target), amount);
        target.depositStake(amount);
        vm.stopPrank();
    }

    function _paymentId(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode("payment", id));
    }

    function _proof(bytes32 id, IOrchestratorV4.Intent memory intent, uint256 amount, bool balanceFunded) internal view returns (bytes memory) {
        bytes memory data = abi.encode(
            IPaymentVerifierV2.PaymentDetails(intent.paymentMethod, PAYEE, amount / 10000, USD, block.timestamp * 1000, _paymentId(id)),
            IPaymentVerifierV2.IntentSnapshot(id, intent.amount, intent.paymentMethod, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0)
        );
        assertEq(data.length, 448);
        // Explicit extension word 0; the payment/snapshot payload itself has no balance flag.
        data = bytes.concat(data, abi.encode(uint256(balanceFunded ? 1 : 0)));
        return _signedProof(id, data, amount);
    }

    function _signedProof(bytes32 id, bytes memory data, uint256 amount) internal view returns (bytes memory) {
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", upv.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"), id, amount, dataHash))
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(UnifiedPaymentVerifierV4.PaymentAttestation(id, amount, dataHash, signatures, data, ""));
    }

    function _settle(bytes32 id, uint256 amount, bool balanceFunded) internal {
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(_proof(id, orchestrator.getIntent(id), amount, balanceFunded), id, "", ""));
    }
}
