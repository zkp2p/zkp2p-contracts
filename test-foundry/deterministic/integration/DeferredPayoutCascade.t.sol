// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeProtectionStackV2Fixture} from "../helpers/DisputeProtectionStackV2Fixture.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";

contract DeferredPayoutCascadeTest is DisputeProtectionStackV2Fixture {
    bytes32 internal constant CONDITIONS = keccak256("signed conditions");

    function test_ConditionedBalanceFundedSettlement() public {
        _conditionedSettlement(true, false);
    }

    function test_ConditionedStakeSettlement() public {
        _conditionedSettlement(false, true);
    }

    function test_ConditionedDeferredSettlement() public {
        _conditionedSettlement(false, false);
    }

    function _conditionedSettlement(bool balanceFunded, bool staked) internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
        if (staked) _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalWithConditions(CONDITIONS);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, balanceFunded),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes[4] memory invalidExtensions = [bytes(""), new bytes(31), abi.encode(bytes32(0)), abi.encode(keccak256("wrong"))];
        uint256 escrowBalance = token.balanceOf(address(escrow));
        uint256 vaultBalance = token.balanceOf(address(vault));
        for (uint256 i; i < invalidExtensions.length; ++i) {
            bytes memory invalidProof = _signedProof(
                id, bytes.concat(attestation.data, invalidExtensions[i]), INTENT_AMOUNT
            );
            vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.ConditionsNotAttested.selector, id));
            orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(invalidProof, id, "", ""));
            assertEq(orchestrator.intentConditions(id), CONDITIONS);
            assertEq(orchestrator.getIntent(id).owner, taker);
            assertEq(token.balanceOf(address(escrow)), escrowBalance);
            assertEq(token.balanceOf(address(vault)), vaultBalance);
            assertEq(token.balanceOf(other), 0);
            assertEq(token.balanceOf(protocolFeeRecipient), 0);
            assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
        }
        bytes memory proof = _signedProof(
            id, bytes.concat(attestation.data, abi.encode(CONDITIONS), hex"010203"), INTENT_AMOUNT
        );
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, "", ""));
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(other), balanceFunded || staked ? NET : 0);
        P.CollateralSource source = balanceFunded ? P.CollateralSource.BYPASS
            : staked ? P.CollateralSource.STAKE : P.CollateralSource.DEFERRED_PAYOUT;
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(source));
        if (balanceFunded) _assertLock(id, address(0), 0);
        else if (staked) _assertLock(id, taker, INTENT_AMOUNT);
        else _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), balanceFunded ? 0 : staked ? INTENT_AMOUNT : NET);
        _assertFees();
    }

    function test_BalanceFundedPaysNowWithoutLock() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, true);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.BYPASS));
        _assertFees();
    }

    function test_DeferredSettlementWithSignedExtension() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, false),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes memory proof = _signedProof(id, bytes.concat(attestation.data, hex"deadbeef0102"), INTENT_AMOUNT);
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, "", ""));
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_UnconditionedIntentRejectsNonZeroAttestedHash() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, true),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        assertEq(attestation.data.length, 480);
        bytes memory proof = _signedProof(id, bytes.concat(attestation.data, abi.encode(CONDITIONS)), INTENT_AMOUNT);
        uint256 escrowBalance = token.balanceOf(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.ConditionsNotAttested.selector, id));
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, "", ""));
        assertEq(orchestrator.intentConditions(id), bytes32(0));
        assertEq(orchestrator.getIntent(id).owner, taker);
        assertEq(token.balanceOf(address(escrow)), escrowBalance);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(protocolFeeRecipient), 0);
        assertEq(token.balanceOf(referrer), 0);
        assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, _paymentId(id)))), bytes32(0));

        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(abi.encode(attestation), id, "", ""));
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_UnconditionedIntentAcceptsZeroAttestedHashWithTrailingBytes() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, false),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes memory proof = _signedProof(
            id, bytes.concat(attestation.data, abi.encode(bytes32(0)), hex"010203"), INTENT_AMOUNT
        );
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, "", ""));
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_StakeCoveredPaysNowAndLocksStake() public {
        _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, false);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, taker, INTENT_AMOUNT);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.STAKE));
        _assertFees();
    }

    function test_UncoveredDefersNetToRecipient() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, false);
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(vault.totalAccounted(), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_DeferredDisputePaysDepositorNet() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, false);
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, _paymentId(id)));
        assertEq(nullifiers.intentHashByNullifier(paymentNullifier), id);
        assertEq(nullifiers.nullifierByIntentHash(id), paymentNullifier);
        bytes32 disputeId = keccak256("dispute");
        bytes memory data = abi.encode(IDisputeVerifier.DisputeDetails(METHOD, _paymentId(id), disputeId, 5000, USD));
        IDisputeVerifier.DisputeAttestation memory attestation =
            IDisputeVerifier.DisputeAttestation(id, keccak256(data), new bytes[](1), data);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, disputeVerifier.hashDisputeAttestation(attestation));
        attestation.signatures[0] = abi.encodePacked(r, s, v);
        protection.submitDispute(attestation);
        assertEq(vault.claimable(depositor), NET);
        assertEq(vault.lockedStake(other), 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.DISPUTED));
        uint256 beforeBalance = token.balanceOf(depositor);
        vm.prank(depositor);
        vault.claim();
        assertEq(token.balanceOf(depositor) - beforeBalance, NET);
        assertEq(token.balanceOf(other), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_DeferredReleaseThenTakerClaimFor() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, false);
        _release(id);
        vm.prank(taker);
        protection.claimFor(id);
        assertEq(token.balanceOf(other), NET);
        assertEq(token.balanceOf(taker), 0);
        assertEq(protection.getDisputeProtectionIntent(id).claimedAmount, NET);
        assertEq(vault.totalAccounted(), 0);
    }

    function test_DeferredRecipientCanWithdrawStakeDirectly() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, false);
        _release(id);
        vm.prank(other);
        vault.withdrawStake(NET);
        assertEq(token.balanceOf(other), NET);
        assertEq(vault.totalAccounted(), 0);
    }

    function test_PostIntentHookRunsOnPayNowAndNotOnDeferred() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.postIntentHook = postIntentHook;
        params.data = abi.encode(other);
        bytes32 paid = _signal(taker, params);
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(_proof(paid, orchestrator.getIntent(paid), INTENT_AMOUNT, true), paid, "", hex"abcd"));
        assertEq(postIntentHook.lastPostIntentHookData(), hex"abcd");
        assertEq(token.balanceOf(other), NET);
        bytes32 deferred = _signal(taker, params);
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(_proof(deferred, orchestrator.getIntent(deferred), INTENT_AMOUNT, false), deferred, "", hex"1234"));
        assertEq(postIntentHook.lastPostIntentHookData(), hex"abcd");
        assertEq(token.balanceOf(other), NET);
        _assertLock(deferred, other, NET);
        assertEq(token.allowance(address(orchestrator), address(postIntentHook)), 0);
    }

    function test_ManualReleasePaysOutImmediately() public {
        bytes32 id = _signalDefault();
        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(token.balanceOf(address(vault)), vaultBefore);
        assertEq(vault.totalAccounted(), 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.MANUAL_RELEASE));
        _assertFees();
    }

    function test_OverpaymentIsCappedBeforeCascade() public {
        _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalDefault();
        _settle(id, 2 * INTENT_AMOUNT, false);
        assertEq(protection.getDisputeProtectionIntent(id).releaseAmount, INTENT_AMOUNT);
        _assertLock(id, taker, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_OrchestratorV3FulfilsThroughUPV4() public {
        OrchestratorV3 v3 = new OrchestratorV3(address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry), address(relayerRegistry), PROTOCOL_FEE, protocolFeeRecipient);
        orchestratorRegistry.addOrchestrator(address(v3));
        StakeVault oldVault = new StakeVault(address(this), token, address(0), 0);
        DisputeProtectionPolicy oldPolicy = new DisputeProtectionPolicy(address(this), oldVault, disputeVerifier, disputeNullifiers);
        oldVault.initializeController(address(oldPolicy));
        oldPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        IntentLifecycleHookV1 oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, oldPolicy);
        oldPolicy.setLifecycleHookAuthorization(address(oldHook), true);
        disputeNullifiers.addWritePermission(address(oldPolicy));
        v3.setLifecycleHook(oldHook);
        _stake(oldVault, taker, INTENT_AMOUNT);
        bytes32 id = bytes32(uint256(keccak256(abi.encodePacked(address(v3), v3.intentCounter()))) % CIRCOM_PRIME_FIELD);
        vm.prank(taker);
        v3.signalIntent(abi.decode(abi.encode(_defaultParams()), (IOrchestratorV3.SignalIntentParams)));
        assertEq(oldVault.lockedStake(taker), INTENT_AMOUNT);
        v3.fulfillIntent(IOrchestratorV3.FulfillIntentParams(_proof(id, abi.decode(abi.encode(v3.getIntent(id)), (IOrchestratorV4.Intent)), INTENT_AMOUNT, true), id, "", ""));
        assertEq(token.balanceOf(other), NET);
        assertEq(oldVault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(uint256(oldPolicy.getDisputeProtectionIntent(id).status), uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED));
        assertEq(nullifiers.nullifierByIntentHash(id), keccak256(abi.encodePacked(METHOD, _paymentId(id))));
        _assertFees();
    }

    function _assertLock(bytes32 id, address owner, uint256 amount) internal view {
        (address actualOwner, uint256 actualAmount,) = vault.locks(id);
        assertEq(actualOwner, owner);
        assertEq(actualAmount, amount);
    }

    function _assertFees() internal view {
        assertEq(token.balanceOf(protocolFeeRecipient), INTENT_AMOUNT * PROTOCOL_FEE / 1e18);
        assertEq(token.balanceOf(referrer), INTENT_AMOUNT * REFERRAL_FEE / 1e18);
        assertEq(token.balanceOf(address(orchestrator)), 0);
    }

    function _release(bytes32 id) internal {
        vm.warp(protection.getDisputeProtectionIntent(id).releaseEligibleAt);
        protection.releaseMaturedDisputeProtectionIntent(id);
        assertEq(vault.lockedStake(other), 0);
        assertEq(vault.freeStake(other), NET);
    }
}
