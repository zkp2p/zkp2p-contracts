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
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A recipient that can only forward the token it holds, like a splitter or exchange deposit contract.
contract ForwardingRecipient {
    IERC20 internal immutable token;
    address internal immutable beneficiary;

    constructor(IERC20 _token, address _beneficiary) {
        token = _token;
        beneficiary = _beneficiary;
    }

    function forward() external {
        token.transfer(beneficiary, token.balanceOf(address(this)));
    }
}

contract DeferredPayoutCascadeTest is DisputeProtectionStackV2Fixture {
    function test_RelayerTakerUsesStakeOwnerCollateral() public {
        relayerRegistry.addRelayer(taker);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));
        _stake(vault, delegate, INTENT_AMOUNT);
        vm.prank(delegate);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(delegate);
        bytes32 id = _signalDefault();
        assertFalse(_isOpen(id));
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), NET);
        assertTrue(_isOpen(id));
        _assertLock(id, delegate, INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT);
        _assertFees();
    }

    function test_RelayerTakerDefersUncoveredPayout() public {
        relayerRegistry.addRelayer(taker);
        assertFalse(whitelist.enabled(address(escrow), depositId, METHOD));
        bytes32 id = _signalDefault();
        assertFalse(_isOpen(id));
        _assertDeferredSettlement(id);
        assertTrue(_isOpen(id));
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(vault.totalAccounted(), NET);
    }

    function test_WhitelistedRelayerTakerPaysNow() public {
        relayerRegistry.addRelayer(taker);
        _whitelistTaker();
        bytes32 id = _signalDefault();
        assertFalse(_isOpen(id));
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        assertFalse(_isOpen(id));
        _assertLock(id, address(0), 0);
        _assertFees();
    }

    function test_RelayerManualReleaseCreatesNoRecord() public {
        relayerRegistry.addRelayer(taker);
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), NET);
        assertFalse(_isOpen(id));
    }

    function test_ZeroWindowPaysNormallyWithoutRecord() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, 0);
        assertEq(token.balanceOf(other), NET);
        assertFalse(_isOpen(id));
        assertEq(token.balanceOf(address(vault)), 0);
        _assertFees();
    }

    event ProtectionOpened(bytes32 indexed intentHash, address indexed depositor);

    function _expectDeferredSettlement(bytes32 id) internal {
        vm.expectEmit(true, true, false, true, address(protection));
        emit ProtectionOpened(id, depositor);
    }

    function _isOpen(bytes32 id) internal view returns (bool) {
        return protection.getProtection(id).depositor != address(0);
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
        assertFalse(_isOpen(id));
    }

    function _assertDeferredSettlement(bytes32 id) internal {
        _expectDeferredSettlement(id);
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertTrue(_isOpen(id));
        _assertFees();
    }

    function test_WhitelistedTakerBypassesWithInsufficientStake() public {
        _whitelistTaker();
        _stake(vault, taker, INTENT_AMOUNT - 1);
        bytes32 id = _signalDefault();
        assertFalse(_isOpen(id));
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.lockedStake(other), 0);
        assertEq(vault.freeStake(taker), INTENT_AMOUNT - 1);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT - 1);
        assertFalse(_isOpen(id));
        _assertFees();
    }

    function test_WhitelistDisabledAfterSignalStillPaysNow() public {
        _whitelistTaker();
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        whitelist.setEnabled(address(escrow), depositId, METHOD, false);
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_WhitelistEnabledAfterSignalIsProtected() public {
        bytes32 id = _signalDefault();
        _whitelistTaker();
        _assertDeferredSettlement(id);
    }

    function test_TakerRemovedAfterSignalStillPaysNow() public {
        (AddressGroupRegistry groups, bytes32 group) = _whitelistTaker();
        bytes32 id = _signalDefault();
        address[] memory members = new address[](1);
        members[0] = taker;
        groups.removeMembers(group, members);
        _settleWhitelistedWithoutRecord(id);
        assertEq(token.balanceOf(other), NET);
        _assertFees();
    }

    function test_WhitelistedTakerManualReleaseCreatesNoRecord() public {
        _whitelistTaker();
        bytes32 id = _signalDefault();
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(id, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertFalse(_isOpen(id));
        _assertFees();
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
        assertFalse(_isOpen(id));
        _assertFees();
    }

    function test_DeferredSettlementIgnoresTrailingSettlementWords() public {
        bytes32 id = _signalDefault();
        bytes memory proof = _proofWithSettlementData(
            id, orchestrator.getIntent(id), INTENT_AMOUNT, abi.encode(RISK_WINDOW, bytes32(0), keccak256("reserved"))
        );
        orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertTrue(_isOpen(id));
        _assertFees();
    }

    function test_StakeCoveredPaysNowAndLocksStake() public {
        _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, taker, INTENT_AMOUNT);
        assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT);
        assertTrue(_isOpen(id));
        _assertFees();
    }

    function test_UncoveredDefersNetToRecipient() public {
        bytes32 id = _signalDefault();
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        assertEq(token.balanceOf(other), 0);
        _assertLock(id, other, NET);
        assertEq(token.balanceOf(address(vault)), NET);
        assertEq(vault.totalAccounted(), NET);
        assertTrue(_isOpen(id));
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
        assertFalse(_isOpen(id));
        uint256 beforeBalance = token.balanceOf(depositor);
        vm.prank(depositor);
        vault.claim();
        assertEq(token.balanceOf(depositor) - beforeBalance, NET);
        assertEq(token.balanceOf(other), 0);
        assertEq(vault.totalAccounted(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_DeferredPayoutReachesRecipientThatCannotCallTheVault() public {
        address beneficiary = makeAddr("beneficiary");
        ForwardingRecipient recipient = new ForwardingRecipient(token, beneficiary);
        IOrchestratorV4.SignalIntentParams memory params = _defaultParams();
        params.to = address(recipient);
        bytes32 id = _signal(taker, params);
        _settle(id, INTENT_AMOUNT, RISK_WINDOW);
        (address owner, uint256 amount, uint64 maturesAt) = vault.locks(id);
        assertEq(owner, address(recipient));
        assertEq(amount, NET);

        vm.warp(maturesAt);
        vm.prank(makeAddr("keeper"));
        protection.release(_ids(id));
        assertEq(token.balanceOf(address(recipient)), NET);
        assertEq(vault.stakeBalance(address(recipient)), 0);
        assertEq(vault.totalAccounted(), 0);

        recipient.forward();
        assertEq(token.balanceOf(beneficiary), NET);
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
        orchestrator.releaseFundsToPayer(id, INTENT_AMOUNT);
        assertEq(token.balanceOf(other), NET);
        _assertLock(id, address(0), 0);
        assertEq(token.balanceOf(address(vault)), vaultBefore);
        assertEq(vault.totalAccounted(), 0);
        assertFalse(_isOpen(id));
        _assertFees();
    }

    function test_OverpaymentIsCappedBeforeCascade() public {
        _stake(vault, taker, INTENT_AMOUNT);
        bytes32 id = _signalDefault();
        vm.expectEmit(true, true, false, true, address(protection));
        emit ProtectionOpened(id, depositor);
        _settle(id, 2 * INTENT_AMOUNT, RISK_WINDOW);
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
        (,, uint64 maturesAt) = vault.locks(id);
        vm.warp(maturesAt);
        protection.release(_ids(id));
        assertEq(vault.lockedStake(other), 0);
        assertEq(vault.stakeBalance(other), 0);
        assertEq(token.balanceOf(other), NET);
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}
