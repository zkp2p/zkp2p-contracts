// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IWhitelistPolicy} from "contracts/interfaces/IWhitelistPolicy.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
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
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, P.CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt);
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
    WhitelistPolicy internal whitelist;
    DisputeVerifier internal verifier;
    NullifierRegistry internal disputes;
    NullifierRegistryV2 internal payments;

    function setUp() public {
        vm.warp(1000);
        usdc = new USDCMock(100000e6, "USDC", "USDC");
        vault = new StakeVaultV2(address(this), usdc, address(0));
        payments = new NullifierRegistryV2(new NullifierRegistry());
        disputes = new NullifierRegistry();
        verifier = new DisputeVerifier(address(this), payments, new AttestationVerifierMock());
        _newPolicy();
        vault.setController(address(policy), true);
    }

    function _newPolicy() internal {
        if (address(whitelist) == address(0)) whitelist = new WhitelistPolicy(new AddressGroupRegistry(), new EscrowRegistry(), new OrchestratorRegistry());
        policy = new DisputeProtectionPolicyV2(address(this), vault, verifier, disputes, whitelist);
        policy.setOrchestratorAuthorization(address(this), true);
        disputes.addWritePermission(address(policy));
    }
    function _settle(bytes32 id, uint256 gross, uint256 net) internal returns (bool) {
        return (policy.settleIntent(S.SettlementContext(id, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, gross, net, abi.encode(uint256(WINDOW)), false)) != address(0));
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
    function _status(P.DisputeProtectionIntentStatus status) internal view {
        assertEq(uint256(_record().status), uint256(status));
    }
    function _unexpected(P.DisputeProtectionIntentStatus status) internal {
        vm.expectRevert(abi.encodeWithSelector(P.UnexpectedStatus.selector, ID, status));
    }
    function _defer() internal {
        assertTrue(_settle(ID, GROSS, NET));
    }
    function _fund() internal {
        _defer();
        usdc.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(ID);
    }
    function _mature() internal {
        vm.warp(_record().releaseEligibleAt);
    }
    function _claim(address caller) internal {
        vm.prank(caller);
        policy.claimFor(ID);
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

    function test_SettlementRecordsAllContextAndEmitsOneEvent() public {
        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(ID, TAKER, DEPOSITOR, RECIPIENT, METHOD, WINDOW, P.CollateralSource.DEFERRED_PAYOUT, RECIPIENT, GROSS, NET, uint64(block.timestamp + WINDOW));
        _defer();
        // expectEmit also records the test's expected log; the policy emits exactly one event.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 policyLogCount;
        for (uint256 index; index < logs.length; ++index) {
            if (logs[index].emitter == address(policy)) ++policyLogCount;
        }
        assertEq(policyLogCount, 1);
        P.DisputeProtectionIntent memory record = _record();
        assertEq(record.taker, TAKER);
        assertEq(record.recipient, RECIPIENT);
        assertEq(record.depositor, DEPOSITOR);
        assertEq(record.paymentMethod, METHOD);
        assertEq(record.releaseEligibleAt, block.timestamp + WINDOW);
        _status(P.DisputeProtectionIntentStatus.SETTLED);
        (address lockOwner, uint256 lockAmount,) = vault.locks(ID);
        assertEq(lockOwner, address(0));
        assertEq(lockAmount, 0);
    }
    function test_SettlementZeroWindowCreatesNoRecord() public {
        vm.recordLogs();
        assertFalse((policy.settleIntent(S.SettlementContext(ID, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(0)), false)) != address(0)));
        assertEq(vm.getRecordedLogs().length, 0);
        _status(P.DisputeProtectionIntentStatus.NONE);
    }

    function test_NonStakeTokenCreatesNoRecordOrEvent() public {
        vm.recordLogs();
        vm.record();
        assertFalse((policy.settleIntent(S.SettlementContext(ID, STRANGER, TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(WINDOW)), false)) != address(0)));
        (, bytes32[] memory writes) = vm.accesses(address(policy));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        _status(P.DisputeProtectionIntentStatus.NONE);
    }
    function test_SettlementUsesSuppliedDepositorWithoutEscrow() public {
        assertTrue((policy.settleIntent(S.SettlementContext(ID, address(usdc), TAKER, RECIPIENT, STRANGER, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(WINDOW)), false)) != address(0)));
        assertEq(_record().depositor, STRANGER);
    }
    function test_CollateralSourceOrdinals() public pure {
        assertEq(uint256(P.CollateralSource.NONE), 0);
        assertEq(uint256(P.CollateralSource.STAKE), 1);
        assertEq(uint256(P.CollateralSource.DEFERRED_PAYOUT), 2);
    }

    function test_StatusOrdinals() public pure {
        assertEq(uint256(P.DisputeProtectionIntentStatus.NONE), 0);
        assertEq(uint256(P.DisputeProtectionIntentStatus.SETTLED), 1);
        assertEq(uint256(P.DisputeProtectionIntentStatus.RELEASED), 2);
        assertEq(uint256(P.DisputeProtectionIntentStatus.DISPUTED), 3);
    }

    function test_StakeBoundaryEqualLocksStake() public {
        _stake(TAKER, GROSS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(ID, TAKER, DEPOSITOR, RECIPIENT, METHOD, WINDOW, P.CollateralSource.STAKE, TAKER, GROSS, GROSS, uint64(block.timestamp + WINDOW));
        assertFalse(_settle(ID, GROSS, NET));
        assertEq(_record().lockedAmount, GROSS);
        assertEq(uint256(_record().collateralSource), uint256(P.CollateralSource.STAKE));
        (address owner, uint256 amount, uint64 maturity) = vault.locks(ID);
        assertEq(owner, TAKER);
        assertEq(amount, GROSS);
        assertEq(maturity, block.timestamp + WINDOW);
    }
    function test_StakeBoundaryShortDefers() public {
        _stake(TAKER, GROSS - 1);
        _defer();
        _status(P.DisputeProtectionIntentStatus.SETTLED);
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
        assertEq(_record().stakeOwner, STRANGER);
        assertEq(vault.lockedStake(STRANGER), GROSS);
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
    function test_SettlementSnapshotsAttestedWindowPerIntent() public {
        assertTrue((policy.settleIntent(S.SettlementContext(ID, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(1 days)), false)) != address(0)));
        assertTrue((policy.settleIntent(S.SettlementContext(ID2, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(2 days)), false)) != address(0)));
        assertEq(_record().releaseEligibleAt, block.timestamp + 1 days);
        assertEq(policy.getDisputeProtectionIntent(ID2).releaseEligibleAt, block.timestamp + 2 days);
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
        _status(P.DisputeProtectionIntentStatus.SETTLED);
        (address owner, uint256 amount, uint64 maturity) = vault.locks(ID);
        assertEq(owner, RECIPIENT);
        assertEq(amount, NET);
        assertEq(maturity, _record().releaseEligibleAt);
        assertEq(vault.freeStake(RECIPIENT), 10e6);
    }
    function test_FundWithoutTokensReverts() public {
        _defer();
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientUnaccountedTokens.selector, 0, NET));
        policy.onDeferredPayoutFunded(ID);
    }
    function test_FundTwiceRevertsInVault() public {
        _fund();
        usdc.transfer(address(vault), NET);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockAlreadyExists.selector, ID));
        policy.onDeferredPayoutFunded(ID);
        _status(P.DisputeProtectionIntentStatus.SETTLED);
        assertEq(vault.lockedStake(RECIPIENT), NET);
        assertEq(vault.totalAccounted(), NET);
        assertEq(vault.unaccountedBalance(), NET);
    }
    function test_FundStakeSourceReverts() public {
        _settleStake();
        vm.expectRevert(abi.encodeWithSelector(P.NotDeferredPayout.selector, ID));
        policy.onDeferredPayoutFunded(ID);
    }
    function test_FundingPreservesRecordAndEmitsOnlyVaultEvents() public {
        _defer();
        bytes memory recordBeforeFunding = abi.encode(_record());
        usdc.transfer(address(vault), NET);
        vm.recordLogs();
        policy.onDeferredPayoutFunded(ID);
        assertEq(abi.encode(_record()), recordBeforeFunding);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 index; index < logs.length; ++index) assertTrue(logs[index].emitter != address(policy));
    }
    function test_FundWrongStatusReverts() public {
        _unexpected(P.DisputeProtectionIntentStatus.NONE);
        policy.onDeferredPayoutFunded(ID);
    }
    function test_FundReleasedDeferredReverts() public {
        _fund();
        _mature();
        policy.releaseMaturedDisputeProtectionIntent(ID);
        _unexpected(P.DisputeProtectionIntentStatus.RELEASED);
        policy.onDeferredPayoutFunded(ID);
    }
    function test_FundDisputedDeferredReverts() public {
        _fund();
        policy.submitDispute(_attestation());
        _unexpected(P.DisputeProtectionIntentStatus.DISPUTED);
        policy.onDeferredPayoutFunded(ID);
    }
    function test_DisputeOnStakePaysGross() public {
        _settleStake();
        policy.submitDispute(_attestation());
        assertEq(vault.claimable(DEPOSITOR), GROSS);
        _status(P.DisputeProtectionIntentStatus.DISPUTED);
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
        _mature();
        policy.releaseMaturedDisputeProtectionIntent(ID);
        IDisputeVerifier.DisputeAttestation memory a = _attestation();
        _unexpected(P.DisputeProtectionIntentStatus.RELEASED);
        policy.submitDispute(a);
    }
    function test_ReleaseBeforeMaturityReverts() public {
        _fund();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotReleaseEligible.selector, _record().releaseEligibleAt, uint64(block.timestamp)));
        policy.releaseMaturedDisputeProtectionIntent(ID);
    }
    function test_ReleaseDeferredBecomesRecipientFreeStake() public {
        _fund();
        _mature();
        policy.releaseMaturedDisputeProtectionIntent(ID);
        assertEq(vault.freeStake(RECIPIENT), NET);
        _status(P.DisputeProtectionIntentStatus.RELEASED);
    }
    function test_ClaimForByTakerPaysRecipient() public {
        _fund();
        _mature();
        _claim(TAKER);
        assertEq(usdc.balanceOf(RECIPIENT), NET);
        assertEq(usdc.balanceOf(TAKER), 0);
        assertEq(_record().claimedAmount, NET);
    }
    function test_ClaimForByRecipient() public {
        _fund();
        _mature();
        _claim(RECIPIENT);
        assertEq(usdc.balanceOf(RECIPIENT), NET);
    }
    function test_ClaimForStrangerReverts() public {
        _fund();
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedClaimer.selector, STRANGER));
        _claim(STRANGER);
    }
    function test_ClaimForReleasesMaturedLockFirst() public {
        _fund();
        _mature();
        _claim(TAKER);
        _status(P.DisputeProtectionIntentStatus.RELEASED);
        assertEq(vault.lockedStake(RECIPIENT), 0);
    }
    function test_ClaimForBeforeMaturityReverts() public {
        _fund();
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotReleaseEligible.selector, _record().releaseEligibleAt, uint64(block.timestamp)));
        _claim(TAKER);
    }
    function test_ClaimForStakeSourceReverts() public {
        _settleStake();
        vm.expectRevert(abi.encodeWithSelector(P.NotDeferredPayout.selector, ID));
        _claim(TAKER);
    }
    function test_ClaimForCapsAtLockedAmount() public {
        _stake(RECIPIENT, 500e6);
        _fund();
        _mature();
        _claim(TAKER);
        assertEq(usdc.balanceOf(RECIPIENT), NET);
        assertEq(vault.freeStake(RECIPIENT), 500e6);
        vm.expectRevert(abi.encodeWithSelector(P.NothingToClaim.selector, ID));
        _claim(TAKER);
    }
    function test_ClaimForPartialWhenRecipientStakeRelocked() public {
        _fund();
        _mature();
        policy.releaseMaturedDisputeProtectionIntent(ID);
        assertFalse((policy.settleIntent(S.SettlementContext(ID2, address(usdc), RECIPIENT, STRANGER, DEPOSITOR, address(0), 0, METHOD, 60e6, 59e6, abi.encode(uint256(WINDOW)), false)) != address(0)));
        _claim(TAKER);
        assertEq(usdc.balanceOf(RECIPIENT), 39.05e6);
        assertEq(_record().claimedAmount, 39.05e6);
        vm.warp(block.timestamp + WINDOW);
        policy.releaseMaturedDisputeProtectionIntent(ID2);
        _claim(TAKER);
        assertEq(usdc.balanceOf(RECIPIENT), NET);
        assertEq(_record().claimedAmount, NET);
    }
    function test_ClaimForAfterRecipientWithdrewReverts() public {
        _fund();
        _mature();
        policy.releaseMaturedDisputeProtectionIntent(ID);
        vm.prank(RECIPIENT);
        vault.withdrawStake(NET);
        vm.expectRevert(abi.encodeWithSelector(P.NothingToClaim.selector, ID));
        _claim(TAKER);
    }
    function test_ClaimForDisputedReverts() public {
        _fund();
        policy.submitDispute(_attestation());
        _unexpected(P.DisputeProtectionIntentStatus.DISPUTED);
        _claim(TAKER);
    }
    function test_LifecycleEntrypointsRequireAuthorizedOrchestrator() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        _settle(ID, GROSS, NET);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedOrchestrator.selector, STRANGER));
        policy.onDeferredPayoutFunded(ID);
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
        new DisputeProtectionPolicyV2(address(0), vault, verifier, disputes, whitelist);
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 2; ++j) {
                address bad = j == 0 ? address(0) : STRANGER;
                if (j == 0) vm.expectRevert(P.ZeroAddress.selector);
                else vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, bad));
                new DisputeProtectionPolicyV2(address(this), i == 0 ? IStakeVaultV2(bad) : vault, i == 1 ? IDisputeVerifier(bad) : verifier, i == 2 ? INullifierRegistry(bad) : disputes, i == 3 ? IWhitelistPolicy(bad) : whitelist);
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
        _mature();
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;
        uint64 timestamp = uint64(vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentNotReleaseEligible.selector, timestamp + 1, timestamp));
        policy.releaseMaturedDisputeProtectionIntents(ids);
        _status(P.DisputeProtectionIntentStatus.SETTLED);
        assertEq(vault.lockedStake(TAKER), 2 * GROSS);
        vm.warp(vm.getBlockTimestamp() + 1);
        policy.releaseMaturedDisputeProtectionIntents(ids);
        assertEq(vault.lockedStake(TAKER), 0);
    }
    function test_SettlementWindowBoundedAsDefenceInDepth() public {
        uint64 max = 180 days;
        vm.expectRevert(abi.encodeWithSelector(P.InvalidDisputeWindow.selector, max + 1));
        policy.settleIntent(S.SettlementContext(ID, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(max + 1)), false));
        assertEq(policy.MAX_RISK_WINDOW(), max);
        assertTrue((policy.settleIntent(S.SettlementContext(ID, address(usdc), TAKER, RECIPIENT, DEPOSITOR, address(0), 0, METHOD, GROSS, NET, abi.encode(uint256(max)), false)) != address(0)));
        assertEq(_record().releaseEligibleAt, block.timestamp + max);
    }

    function test_Views() public {
        _defer();

        P.DisputeProtectionIntent memory r = _record();
        assertEq(r.taker, TAKER);
        assertEq(r.depositor, DEPOSITOR);
        assertEq(r.paymentMethod, METHOD);
        assertTrue(policy.isOrchestratorAuthorized(address(this)));
        assertFalse(policy.isOrchestratorAuthorized(STRANGER));
        assertEq(address(policy.stakeVault()), address(vault));
        assertEq(address(policy.disputeNullifierRegistry()), address(disputes));
    }
}
