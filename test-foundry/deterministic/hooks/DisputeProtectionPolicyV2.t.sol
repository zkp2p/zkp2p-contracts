// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {IStakeVaultV2} from "contracts/interfaces/IStakeVaultV2.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";

contract DisputeProtectionPolicyV2Test is Test {
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed depositor);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash);
    event OrchestratorAuthorizationUpdated(address indexed orchestrator, bool isAuthorized);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    uint64 internal constant WINDOW = 14 days;
    uint256 internal constant GROSS = 100e6;
    uint256 internal constant NET = 99.05e6;
    bytes32 internal constant METHOD = keccak256("paypal");
    bytes32 internal constant ID = keccak256("intent");
    bytes32 internal constant ID2 = keccak256("second");
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);
    address internal constant STRANGER = address(0x44);
    USDCMock internal usdc;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV2 internal policy;
    DisputeVerifier internal verifier;
    NullifierRegistry internal disputes;
    NullifierRegistryV2 internal payments;

    function setUp() public {
        vm.warp(1000);
        usdc = new USDCMock(100000e6, "USDC", "USDC");
        vault = new StakeVaultV2(address(this), usdc);
        payments = new NullifierRegistryV2(new NullifierRegistry());
        disputes = new NullifierRegistry();
        verifier = new DisputeVerifier(address(this), payments, new AttestationVerifierMock());
        _newPolicy();
        vault.setController(address(policy), true);
    }

    function _newPolicy() internal {
        policy = new DisputeProtectionPolicyV2(address(this), vault, verifier, disputes);
        policy.setOrchestratorAuthorization(address(this), true);
        disputes.addWritePermission(address(policy));
    }
    function _context(bytes32 id, uint256 gross, uint256 net, uint256 window) internal pure returns (S.SettlementContext memory) {
        return S.SettlementContext(id, address(0), TAKER, RECIPIENT, DEPOSITOR, METHOD, gross, net, abi.encode(window));
    }
    function _context(bytes32 id) internal view returns (S.SettlementContext memory context) {
        context = _context(id, GROSS, NET, WINDOW);
        context.token = address(usdc);
    }
    function _settle(bytes32 id, uint256 gross, uint256 net) internal returns (bool) {
        S.SettlementContext memory context = _context(id);
        context.releaseAmount = gross;
        context.netAmount = net;
        return policy.settleIntent(context) != address(0);
    }
    function _stake(address owner, uint256 amount) internal {
        usdc.transfer(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }
    function _record() internal view returns (P.DisputeProtectionIntent memory) {
        return policy.getDisputeProtectionIntent(ID);
    }
    function _assertOpen(bytes32 id, bool open) internal view {
        assertEq(policy.getDisputeProtectionIntent(id).depositor != address(0), open);
    }
    function _assertLock(bytes32 id, address owner, uint256 amount, uint256 maturesAt) internal view {
        (address lockOwner, uint256 lockAmount, uint64 lockMaturity) = vault.locks(id);
        assertEq(lockOwner, owner);
        assertEq(lockAmount, amount);
        assertEq(lockMaturity, maturesAt);
    }
    function _defer() internal {
        assertTrue(_settle(ID, GROSS, NET));
    }
    function _fund() internal {
        _defer();
        usdc.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(_context(ID));
    }
    function _mature(bytes32 id) internal {
        (,, uint64 maturesAt) = vault.locks(id);
        vm.warp(maturesAt);
    }
    function _settleStake() internal {
        _stake(TAKER, GROSS);
        assertFalse(_settle(ID, GROSS, NET));
    }
    function _attestation() internal returns (IDisputeVerifier.DisputeAttestation memory) {
        bytes32 paymentId = keccak256("payment");
        payments.addWritePermission(address(this));
        payments.addNullifier(keccak256(abi.encodePacked(METHOD, paymentId)), ID);
        bytes memory data = abi.encode(IDisputeVerifier.DisputeDetails(METHOD, paymentId, keccak256("dispute"), 100, keccak256("USD")));
        return IDisputeVerifier.DisputeAttestation(ID, keccak256(data), new bytes[](0), data);
    }

    function test_SettlementStoresDepositorAndMethodAndEmitsOneEvent() public {
        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeProtectionIntentSettled(ID, DEPOSITOR);
        _defer();
        // expectEmit also records the test's expected log; the policy emits exactly one event.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 policyLogCount;
        for (uint256 index; index < logs.length; ++index) {
            if (logs[index].emitter == address(policy)) ++policyLogCount;
        }
        assertEq(policyLogCount, 1);
        assertEq(_record().depositor, DEPOSITOR);
        assertEq(_record().paymentMethod, METHOD);
        _assertLock(ID, address(0), 0, 0);
    }
    function test_SettlementZeroWindowCreatesNoRecord() public {
        S.SettlementContext memory context = _context(ID);
        context.settlementData = abi.encode(uint256(0));
        vm.recordLogs();
        assertEq(policy.settleIntent(context), address(0));
        assertEq(vm.getRecordedLogs().length, 0);
        _assertOpen(ID, false);
    }
    function test_NonStakeTokenCreatesNoRecordOrEvent() public {
        S.SettlementContext memory context = _context(ID);
        context.token = STRANGER;
        vm.recordLogs();
        vm.record();
        assertEq(policy.settleIntent(context), address(0));
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        _assertOpen(ID, false);
    }
    function test_SettlementUsesSuppliedDepositorWithoutEscrow() public {
        S.SettlementContext memory context = _context(ID);
        context.depositor = STRANGER;
        assertEq(policy.settleIntent(context), address(vault));
        assertEq(_record().depositor, STRANGER);
    }
    function test_StakeBoundaryEqualLocksStake() public {
        _stake(TAKER, GROSS);
        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeProtectionIntentSettled(ID, DEPOSITOR);
        assertFalse(_settle(ID, GROSS, NET));
        _assertLock(ID, TAKER, GROSS, block.timestamp + WINDOW);
    }
    function test_StakeBoundaryShortDefers() public {
        _stake(TAKER, GROSS - 1);
        _defer();
        _assertOpen(ID, true);
        assertEq(vault.lockedStake(TAKER), 0);
    }
    function _delegate() internal {
        _stake(STRANGER, GROSS);
        vm.prank(STRANGER);
        vault.setTakerAuthorization(TAKER, true);
        vm.prank(TAKER);
        vault.selectStakeOwner(STRANGER);
    }
    function test_DelegatedStakeOwnerIsUsed() public {
        _delegate();
        _settle(ID, GROSS, NET);
        _assertLock(ID, STRANGER, GROSS, block.timestamp + WINDOW);
    }
    function test_StakeWithdrawnBeforeSettlementDefers() public {
        _stake(TAKER, GROSS);
        vm.prank(TAKER);
        vault.withdrawStake(GROSS);
        assertTrue(_settle(ID, GROSS, NET));
    }
    function test_DelegationRevokedBeforeSettlementFallsBackToTaker() public {
        _delegate();
        vm.prank(STRANGER);
        vault.setTakerAuthorization(TAKER, false);
        assertEq(vault.stakeOwnerOf(TAKER), TAKER);
        assertTrue(_settle(ID, GROSS, NET));
        assertEq(vault.lockedStake(STRANGER), 0);
    }
    function test_TwoSettlementsCompeteForOneStake() public {
        _stake(TAKER, 150e6);
        assertFalse(_settle(ID, GROSS, NET));
        assertTrue(_settle(ID2, GROSS, NET));
        assertEq(vault.lockedStake(TAKER), GROSS);
        assertLe(vault.lockedStake(TAKER), vault.stakeBalance(TAKER));
    }
    function test_SettlementSetsMaturityFromEachWindow() public {
        _stake(TAKER, 2 * GROSS);
        S.SettlementContext memory context = _context(ID);
        context.settlementData = abi.encode(uint256(1 days));
        policy.settleIntent(context);
        context.intentHash = ID2;
        context.settlementData = abi.encode(uint256(2 days));
        policy.settleIntent(context);
        _assertLock(ID, TAKER, GROSS, block.timestamp + 1 days);
        _assertLock(ID2, TAKER, GROSS, block.timestamp + 2 days);
    }
    function test_ZeroAmountsFailClosed() public {
        vm.expectRevert(abi.encodeWithSelector(P.InvalidSettlementAmount.selector, 0, NET));
        _settle(ID, 0, NET);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidSettlementAmount.selector, GROSS, 0));
        _settle(ID, GROSS, 0);
    }
    function test_SettleTwiceReverts() public {
        _settleStake();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentAlreadyExists.selector, ID));
        _settle(ID, GROSS, NET);
    }
    function test_SettleUnfundedDeferredTwiceReverts() public {
        _defer();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentAlreadyExists.selector, ID));
        _settle(ID, GROSS, NET);
    }
    function test_FundDeferredLocksNetForRecipient() public {
        _stake(RECIPIENT, 10e6);
        _fund();
        _assertOpen(ID, true);
        _assertLock(ID, RECIPIENT, NET, block.timestamp + WINDOW);
        assertEq(vault.freeStake(RECIPIENT), 10e6);
    }
    function test_FundWithoutTokensReverts() public {
        _defer();
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientUnaccountedTokens.selector, 0, NET));
        policy.onDeferredPayoutFunded(_context(ID));
    }
    function test_FundTwiceRevertsInVault() public {
        _fund();
        usdc.transfer(address(vault), NET);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockAlreadyExists.selector, ID));
        policy.onDeferredPayoutFunded(_context(ID));
        assertEq(vault.lockedStake(RECIPIENT), NET);
        assertEq(vault.totalAccounted(), NET);
        assertEq(vault.unaccountedBalance(), NET);
    }
    function test_FundingPreservesRecordAndEmitsOnlyVaultEvents() public {
        _defer();
        bytes memory recordBeforeFunding = abi.encode(_record());
        usdc.transfer(address(vault), NET);
        vm.recordLogs();
        policy.onDeferredPayoutFunded(_context(ID));
        assertEq(abi.encode(_record()), recordBeforeFunding);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 index; index < logs.length; ++index) assertTrue(logs[index].emitter != address(policy));
    }
    function test_DisputeOnStakePaysGrossAndClearsRecord() public {
        _settleStake();
        policy.submitDispute(_attestation());
        assertEq(vault.claimable(DEPOSITOR), GROSS);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        assertTrue(disputes.isNullified(keccak256(abi.encodePacked(METHOD, keccak256("dispute")))));
    }
    function test_DisputeOnDeferredPaysNet() public {
        _fund();
        policy.submitDispute(_attestation());
        assertEq(vault.claimable(DEPOSITOR), NET);
        assertEq(vault.stakeBalance(RECIPIENT), 0);
    }
    function test_DisputeAfterReleaseReverts() public {
        _fund();
        _mature(ID);
        policy.releaseMaturedDisputeProtectionIntent(ID);
        IDisputeVerifier.DisputeAttestation memory a = _attestation();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotFound.selector, ID));
        policy.submitDispute(a);
    }
    function test_DisputeUnknownIntentReverts() public {
        IDisputeVerifier.DisputeAttestation memory a = _attestation();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotFound.selector, ID));
        policy.submitDispute(a);
    }
    function test_ReleaseBeforeMaturityReverts() public {
        _fund();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotReleaseEligible.selector, uint64(block.timestamp + WINDOW), uint64(block.timestamp)));
        policy.releaseMaturedDisputeProtectionIntent(ID);
    }
    function test_ReleaseUnknownIntentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotFound.selector, ID));
        policy.releaseMaturedDisputeProtectionIntent(ID);
    }
    function test_ReleaseDeferredBecomesRecipientFreeStake() public {
        _fund();
        _mature(ID);
        vm.expectEmit(true, false, false, true, address(policy));
        emit DisputeProtectionIntentReleased(ID);
        policy.releaseMaturedDisputeProtectionIntent(ID);
        assertEq(vault.freeStake(RECIPIENT), NET);
        _assertOpen(ID, false);
        _assertLock(ID, address(0), 0, 0);
        vm.prank(RECIPIENT);
        vault.withdrawStake(NET);
        assertEq(usdc.balanceOf(RECIPIENT), NET);
    }
    function test_LifecycleEntrypointsRequireAuthorizedOrchestrator() public {
        S.SettlementContext memory context = _context(ID);
        vm.startPrank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        policy.settleIntent(context);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        policy.onDeferredPayoutFunded(context);
        vm.stopPrank();
    }

    function test_OrchestratorAuthorizationRetainsOwnerAndContractGuards() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(STRANGER);
        policy.setOrchestratorAuthorization(address(this), false);
        vm.expectRevert(P.ZeroAddress.selector);
        policy.setOrchestratorAuthorization(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, STRANGER));
        policy.setOrchestratorAuthorization(STRANGER, true);
        vm.expectEmit(true, false, false, true, address(policy));
        emit OrchestratorAuthorizationUpdated(address(this), false);
        policy.setOrchestratorAuthorization(address(this), false);
        assertFalse(policy.isOrchestratorAuthorized(address(this)));
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, address(this)));
        _settle(ID, GROSS, NET);
        policy.setOrchestratorAuthorization(address(this), true);
        assertTrue(policy.isOrchestratorAuthorized(address(this)));
        // Revocation does not require code; it must remain possible after a caller is retired.
        policy.setOrchestratorAuthorization(STRANGER, false);
    }
    function test_RenounceDisabled() public {
        vm.expectRevert(P.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }
    function test_ConstructorRejectsZeroOrCodelessDependencies() public {
        vm.expectRevert(P.ZeroAddress.selector);
        new DisputeProtectionPolicyV2(address(0), vault, verifier, disputes);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                address bad = j == 0 ? address(0) : STRANGER;
                if (j == 0) vm.expectRevert(P.ZeroAddress.selector);
                else vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, bad));
                new DisputeProtectionPolicyV2(address(this), i == 0 ? IStakeVaultV2(bad) : vault, i == 1 ? IDisputeVerifier(bad) : verifier, i == 2 ? INullifierRegistry(bad) : disputes);
            }
        }
    }
    function test_SetDisputeVerifier() public {
        DisputeVerifier next = new DisputeVerifier(address(this), payments, new AttestationVerifierMock());
        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeVerifierUpdated(address(verifier), address(next));
        policy.setDisputeVerifier(address(next));
        assertEq(address(policy.disputeVerifier()), address(next));
    }

    function test_BatchReleaseIsAtomic() public {
        _stake(TAKER, 2 * GROSS);

        _settle(ID, GROSS, NET);
        vm.warp(vm.getBlockTimestamp() + 1);

        _settle(ID2, GROSS, NET);
        _mature(ID);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;
        uint64 timestamp = uint64(vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotReleaseEligible.selector, timestamp + 1, timestamp));
        policy.releaseMaturedDisputeProtectionIntents(ids);
        _assertOpen(ID, true);
        assertEq(vault.lockedStake(TAKER), 2 * GROSS);
        vm.warp(vm.getBlockTimestamp() + 1);
        policy.releaseMaturedDisputeProtectionIntents(ids);
        assertEq(vault.lockedStake(TAKER), 0);
    }
    function test_SettlementWindowBoundedAsDefenceInDepth() public {
        uint64 max = 180 days;
        S.SettlementContext memory context = _context(ID);
        context.settlementData = abi.encode(uint256(max + 1));
        vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, max + 1));
        policy.settleIntent(context);
        assertEq(policy.MAX_RISK_WINDOW(), max);
        _stake(TAKER, GROSS);
        context.settlementData = abi.encode(uint256(max));
        policy.settleIntent(context);
        _assertLock(ID, TAKER, GROSS, block.timestamp + max);
    }

    function test_Views() public {
        _defer();

        P.DisputeProtectionIntent memory r = _record();
        assertEq(r.depositor, DEPOSITOR);
        assertEq(r.paymentMethod, METHOD);
        assertTrue(policy.isOrchestratorAuthorized(address(this)));
        assertFalse(policy.isOrchestratorAuthorized(STRANGER));
        assertEq(address(policy.stakeVault()), address(vault));
        assertEq(address(policy.disputeNullifierRegistry()), address(disputes));
    }
}
