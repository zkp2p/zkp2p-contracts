// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";

import {DisputeProtectionStackV2Fixture} from "../helpers/DisputeProtectionStackV2Fixture.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";

contract DeferredPayoutCascadeTest is DisputeProtectionStackV2Fixture {
    bytes32 internal constant CONDITIONS = keccak256("signed conditions");

    function test_ConditionsHashWithoutGatingServiceRejectedByOrchestrator() public {
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.data = abi.encodePacked(CONDITIONS);
        bytes32 id = _intentHash(orchestrator.intentCounter());
        vm.expectRevert(IOrchestratorV4.DataRequiresGatingService.selector);
        _signalCall(taker, params);
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function test_ConditionedZeroWindowSettlement() public {
        _conditionedSettlement(true, false);
    }

    function test_ConditionedStakeSettlement() public {
        _conditionedSettlement(false, true);
    }

    function test_ConditionedDeferredSettlement() public {
        _conditionedSettlement(false, false);
    }

    function _conditionedSettlement(bool payNow, bool staked) internal {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
        if (staked) _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalWithPolicyData(abi.encodePacked(CONDITIONS));
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, payNow ? 0 : RISK_WINDOW),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes[4] memory invalidExtensions = [bytes(""), new bytes(31), abi.encode(bytes32(0)), abi.encode(keccak256("wrong"))];
        uint256 escrowBalance = token.balanceOf(address(escrow));
        uint256 vaultBalance = token.balanceOf(address(vault));
        for (uint256 i; i < invalidExtensions.length; ++i) {
            bytes memory invalidProof = _signedProof(
                id, bytes.concat(attestation.data, invalidExtensions[i]), INTENT_AMOUNT
            );
            vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, id));
            orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(invalidProof, id, ""));
            assertEq(orchestrator.getIntent(id).data, abi.encodePacked(CONDITIONS));
            assertEq(orchestrator.getIntent(id).owner, taker);
            assertEq(token.balanceOf(address(escrow)), escrowBalance);
            assertEq(token.balanceOf(address(vault)), vaultBalance);
            assertEq(token.balanceOf(other), 0);
            assertEq(token.balanceOf(protocolFeeRecipient), 0);
            assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
        }
        bytes memory proof = _signedProof(
            id, bytes.concat(attestation.data, abi.encode(CONDITIONS, keccak256("reserved"))), INTENT_AMOUNT
        );
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(other), payNow || staked ? NET : 0);
        P.CollateralSource source = payNow ? P.CollateralSource.NONE
            : staked ? P.CollateralSource.STAKE : P.CollateralSource.DEFERRED_PAYOUT;
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(source));
        if (payNow) _assertLock(id, address(0), 0);
        else if (staked) _assertLock(id, taker, INTENT_AMOUNT);
        else _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), payNow ? 0 : staked ? INTENT_AMOUNT : NET);
        _assertFees();
    }

    function test_RelayerTakerPaysNowWithoutStakeRecordEventOrVaultCall() public {
        relayerRegistry.addRelayer(taker);
        assertEq(vault.freeStake(taker), 0);
        bytes32 id = _signalDefault();
        vm.mockCallRevert(address(vault), bytes(""), bytes("vault called"));
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        assertEq(token.balanceOf(address(vault)), 0);
        _assertLock(id, address(0), 0);
        _assertFees();
    }

    function test_OptedOutRelayerTakerUsesStakeOwnerCollateral() public {
        relayerRegistry.addRelayer(taker);
        vm.prank(depositor);
        protection.setDepositOptOutForRelayerBypass(address(escrow), depositId, true);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));
        _stake(vault, delegate, INTENT_AMOUNT);
        vm.prank(delegate);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(delegate);
        bytes32 id = _signalDefault();
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.STAKE));
        _assertLock(id, delegate, INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT);
        _assertFees();
    }

    function test_OptedOutRelayerTakerDefersUncoveredPayout() public {
        relayerRegistry.addRelayer(taker);
        vm.prank(depositor);
        protection.setDepositOptOutForRelayerBypass(address(escrow), depositId, true);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));
        bytes32 id = _signalDefault();
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _assertDeferredSettlement(id);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.SETTLED));
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(vault.totalAccounted(), NET);
    }

    function testFuzz_RelayerWhitelistBypassTakesPrecedence(bool optOut) public {
        vm.prank(depositor);
        protection.setDepositOptOutForRelayerBypass(address(escrow), depositId, optOut);
        relayerRegistry.addRelayer(taker);
        _whitelistTaker();
        bytes32 id = _signalDefault();
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.NONE));
        _assertLock(id, address(0), 0);
        _assertFees();
    }

    function testFuzz_RelayerManualReleaseCreatesNoRecord(bool optOut) public {
        vm.prank(depositor);
        protection.setDepositOptOutForRelayerBypass(address(escrow), depositId, optOut);
        relayerRegistry.addRelayer(taker);
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(other), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.NONE));
    }

    function test_ZeroWindowPaysNormallyWithoutRecord() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, 0);
        assertEq(token.balanceOf(other), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(token.balanceOf(address(vault)), 0);
        _assertFees();
    }

    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, P.CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt);

    function _expectDeferredSettlement(bytes32 id) internal {
        vm.expectEmit(true, true, true, true, address(protection));
        emit DisputeProtectionIntentSettled(
            id, taker, depositor, other, METHOD, RISK_WINDOW, P.CollateralSource.DEFERRED_PAYOUT,
            other, INTENT_AMOUNT, NET, uint64(block.timestamp + RISK_WINDOW)
        );
    }

    function _whitelistTaker() internal returns (AddressGroupRegistry groups, bytes32 group) {
        groups = AddressGroupRegistry(address(whitelist.groupRegistry()));
        group = groups.createGroup("Takers");
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.addMembers(group, members);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = group;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, ids, new address[](0));
    }

    function _settleWhitelistedWithoutRecord(bytes32 id) internal {
        vm.recordLogs();
        vm.record();
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        (, bytes32[] memory writes) = vm.accesses(address(protection));

        assertEq(writes.length, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) assertTrue(logs[i].emitter != address(protection));
        vm.clearMockedCalls();
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
    }

    function _assertDeferredSettlement(bytes32 id) internal {
        _expectDeferredSettlement(id);
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_WhitelistedTakerBypassesWithInsufficientStake() public {
        _whitelistTaker();
        _stake(vault, taker, INTENT_AMOUNT - 1);
        bytes32 id = _signalDefault();
        assertEq(uint256(protection.getDisputeProtectionIntent(id).status), uint256(P.DisputeProtectionIntentStatus.NONE));
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.lockedStake(other), 0);
        assertEq(vault.freeStake(taker), INTENT_AMOUNT - 1);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT - 1);
        P.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(id);
        assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.NONE));
        assertEq(uint256(record.status), uint256(P.DisputeProtectionIntentStatus.NONE));
        assertEq(record.lockedAmount, 0);
        _assertFees();
    }

    function test_AllowedTakerWithWhitelistDisabledAtSettlementIsProtected() public {
        _whitelistTaker();
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        assertTrue(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        _assertDeferredSettlement(id);
    }

    function test_TakerRemovedAfterSignalIsProtected() public {
        (AddressGroupRegistry groups, bytes32 group) = _whitelistTaker();
        bytes32 id = _signalDefault();
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.removeMembers(group, members);
        _assertDeferredSettlement(id);
    }

    function test_WhitelistedRecipientDoesNotBypass() public {
        (AddressGroupRegistry groups, bytes32 group) = _whitelistTaker();
        bytes32 id = _signalDefault();
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.removeMembers(group, members);
        members[0] = other;
        groups.addMembers(group, members);
        assertTrue(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, other));
        assertFalse(whitelist.isTakerAllowed(address(escrow), depositId, METHOD, taker));
        _assertDeferredSettlement(id);
    }

    function test_WhitelistedTakerManualReleaseCreatesNoRecord() public {
        _whitelistTaker();
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.NONE));
        _assertFees();
    }

    function test_ZeroHashDataIsUnconditioned() public {
        vm.startPrank(depositor);
        depositId = _createDeposit(gatingService, delegate);
        vm.stopPrank();
        bytes32 id = _signalWithPolicyData(abi.encodePacked(bytes32(0)));
        _assertDeferredSettlement(id);
    }

    function test_EnabledWhitelistRejectsNonMemberBeforeEscrowLock() public {
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, true);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV4.TakerNotWhitelisted.selector, address(escrow), depositId, METHOD, taker));
        _signalCall(taker, _defaultParams());
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
    }

    function test_ZeroWindowPaysNowWithoutLock() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, 0);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.NONE));
        _assertFees();
    }

    function test_DeferredSettlementWithSignedExtension() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, RISK_WINDOW),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes memory proof = _signedProof(id, bytes.concat(attestation.data, abi.encode(bytes32(0), keccak256("reserved"))), INTENT_AMOUNT);
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_UnconditionedIntentRejectsNonZeroAttestedHash() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, 0),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        assertEq(attestation.data.length, 480);
        bytes memory proof = _signedProof(id, bytes.concat(attestation.data, abi.encode(CONDITIONS)), INTENT_AMOUNT);
        uint256 escrowBalance = token.balanceOf(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(P.ConditionsNotAttested.selector, id));
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
        assertEq(orchestrator.getIntent(id).data, "");
        assertEq(orchestrator.getIntent(id).owner, taker);
        assertEq(token.balanceOf(address(escrow)), escrowBalance);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(protocolFeeRecipient), 0);
        assertEq(token.balanceOf(referrer), 0);
        assertEq(nullifiers.nullifierByIntentHash(id), bytes32(0));
        assertEq(nullifiers.intentHashByNullifier(keccak256(abi.encodePacked(METHOD, _paymentId(id)))), bytes32(0));

        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(abi.encode(attestation), id, ""));
        assertEq(orchestrator.getIntent(id).owner, address(0));
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_UnconditionedIntentAcceptsZeroAttestedHashWithTrailingBytes() public {
        bytes32 id = _signalDefault();
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(
            _proof(id, orchestrator.getIntent(id), INTENT_AMOUNT, RISK_WINDOW),
            (UnifiedPaymentVerifierV4.PaymentAttestation)
        );
        bytes memory proof = _signedProof(
            id, bytes.concat(attestation.data, abi.encode(bytes32(0)), hex"010203"), INTENT_AMOUNT
        );
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
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
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, taker, INTENT_AMOUNT);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.STAKE));
        _assertFees();
    }

    function test_UncoveredDefersNetToRecipient() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(vault.totalAccounted(), NET);
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
        _assertFees();
    }

    function test_DeferredDisputePaysDepositorNet() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
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
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
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
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        _release(id);
        vm.prank(other);
        vault.withdrawStake(NET);
        assertEq(token.balanceOf(other), NET);
        assertEq(vault.totalAccounted(), 0);
    }

    function test_NoPostIntentHookRunsOnPayNowOrDeferred() public {
        bytes32 paid = _signalDefault();
        _settle(paid, INTENT_AMOUNT, 0);
        assertEq(token.balanceOf(other), NET);
        bytes32 deferred = _signalDefault();
        _settle(deferred, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), NET);
        _assertLock(deferred, other, NET);
        assertEq(postIntentHook.lastPostIntentHookData(), "");
        assertEq(token.balanceOf(address(postIntentHook)), 0);
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
        assertEq(uint256(protection.getDisputeProtectionIntent(id).collateralSource), uint256(P.CollateralSource.NONE));
        _assertFees();
    }

    function test_OverpaymentIsCappedBeforeCascade() public {
        _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalDefault();
        vm.expectEmit(true, true, true, true, address(protection));
        emit DisputeProtectionIntentSettled(
            id, taker, depositor, other, METHOD, RISK_WINDOW, P.CollateralSource.STAKE,
            taker, INTENT_AMOUNT, INTENT_AMOUNT, uint64(block.timestamp + RISK_WINDOW)
        );
        _settle(id, 2 * INTENT_AMOUNT, RISK_WINDOW);
        assertEq(protection.getDisputeProtectionIntent(id).lockedAmount, INTENT_AMOUNT);
        _assertLock(id, taker, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_OrchestratorV3FulfilsThroughUPV4() public {
        OrchestratorV3 v3 = new OrchestratorV3(address(this), CHAIN_ID, address(escrowRegistry), address(paymentVerifierRegistry), address(relayerRegistry), PROTOCOL_FEE, protocolFeeRecipient);
        orchestratorRegistry.addOrchestrator(address(v3));
        StakeVault oldVault = new StakeVault(address(this), token, address(0), 1 days);
        DisputeProtectionPolicy oldPolicy = new DisputeProtectionPolicy(address(this), oldVault, disputeVerifier, disputeNullifiers);
        oldVault.initializeController(address(oldPolicy));
        oldPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        IntentLifecycleHookV1 oldHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, oldPolicy);
        oldPolicy.setLifecycleHookAuthorization(address(oldHook), true);
        disputeNullifiers.addWritePermission(address(oldPolicy));
        v3.setLifecycleHook(oldHook);
        token.transfer(taker, INTENT_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(oldVault), INTENT_AMOUNT);
        oldVault.depositStake(INTENT_AMOUNT);
        vm.stopPrank();
        bytes32 id = bytes32(uint256(keccak256(abi.encodePacked(address(v3), v3.intentCounter()))) % CIRCOM_PRIME_FIELD);
        vm.prank(taker);
        v3.signalIntent(_v3Params());
        assertEq(oldVault.lockedStake(taker), INTENT_AMOUNT);
        IOrchestratorV3.Intent memory intent = v3.getIntent(id);
        IOrchestratorV4.Intent memory proofIntent;
        proofIntent.amount = intent.amount;
        proofIntent.paymentMethod = intent.paymentMethod;
        proofIntent.timestamp = intent.timestamp;
        v3.fulfillIntent(IOrchestratorV3.FulfillIntentParams(_proof(id, proofIntent, INTENT_AMOUNT, 0), id, "", ""));
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
