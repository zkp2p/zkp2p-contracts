// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeDisputeProtectionPolicy, IPredecessorDisputeProtectionPolicy} from "contracts/hooks/CascadeDisputeProtectionPolicy.sol";
import {ICascadeDisputeProtectionPolicy as P} from "contracts/interfaces/ICascadeDisputeProtectionPolicy.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";
import {EscrowDepositStub} from "../../mocks/EscrowDepositStub.sol";

contract PredecessorPolicyStub is IPredecessorDisputeProtectionPolicy {
    uint64 public window = 14 days;
    bool public enabled;
    /// @notice Configures inherited protection.
    function configure(uint64 _window, bool _enabled) external {
        window = _window;
        enabled = _enabled;
    }
    /// @notice Returns configured protection.
    function isDisputeProtectionEnabled(address, uint256, bytes32) external view returns (bool) {
        return enabled;
    }
    /// @notice Returns configured window.
    function getRiskWindow(bytes32) external view returns (uint64) {
        return window;
    }
}

contract CascadeDisputeProtectionPolicyTest is Test {
    event DisputeProtectionIntentOpened(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow);
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, P.CollateralSource indexed collateralSource, address indexed stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt, bool isManualRelease);
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event AdmissionsPausedUpdated(bool isPaused);
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
    StakeVault internal vault;
    CascadeDisputeProtectionPolicy internal policy;
    EscrowDepositStub internal escrow;
    DisputeVerifier internal verifier;
    NullifierRegistry internal disputes;
    NullifierRegistryV2 internal payments;

    function setUp() public {
        vm.warp(1000);
        usdc = new USDCMock(100000e6, "USDC", "USDC");
        vault = new StakeVault(address(this), usdc, address(0), 0);
        payments = new NullifierRegistryV2(new NullifierRegistry());
        disputes = new NullifierRegistry();
        verifier = new DisputeVerifier(address(this), payments, new AttestationVerifierMock());
        escrow = new EscrowDepositStub(DEPOSITOR, usdc);
        _newPolicy(IPredecessorDisputeProtectionPolicy(address(0)));
        vault.initializeController(address(policy));
    }

    function _newPolicy(IPredecessorDisputeProtectionPolicy predecessor) internal {
        policy = new CascadeDisputeProtectionPolicy(address(this), vault, verifier, disputes, predecessor);
        policy.setLifecycleHookAuthorization(address(this), true);
        policy.setRiskWindow(METHOD, WINDOW);
        disputes.addWritePermission(address(policy));
    }
    function _signal(bytes32 id) internal {
        policy.onIntentSignaled(id, address(escrow), 1, TAKER, RECIPIENT, METHOD);
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
        _signal(ID);
        assertTrue(policy.onIntentSettled(ID, GROSS, NET, false, false));
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
    function _opt(bool enabled) internal {
        vm.prank(DEPOSITOR);
        policy.setDisputeProtectionEnabled(address(escrow), 1, METHOD, enabled);
    }
    function _settleStake() internal {
        _stake(TAKER, GROSS);
        _signal(ID);
        assertFalse(policy.onIntentSettled(ID, GROSS, NET, false, false));
    }
    function _attestation() internal returns (IDisputeVerifier.DisputeAttestation memory) {
        bytes32 paymentId = keccak256("payment");
        payments.addWritePermission(address(this));
        payments.addNullifier(keccak256(abi.encodePacked(METHOD, paymentId)), ID);
        bytes memory data = abi.encode(IDisputeVerifier.DisputeDetails(METHOD, paymentId, keccak256("dispute"), 100, keccak256("USD")));
        return IDisputeVerifier.DisputeAttestation(ID, keccak256(data), new bytes[](0), data);
    }

    function test_SignalRecordsPendingWithoutLocking() public {
        _stake(TAKER, GROSS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentOpened(ID, TAKER, DEPOSITOR, RECIPIENT, METHOD, WINDOW);
        _signal(ID);
        _status(P.DisputeProtectionIntentStatus.PENDING);
        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(_record().recipient, RECIPIENT);
        assertEq(_record().riskWindow, WINDOW);
    }
    function test_SignalZeroWindowCreatesNoRecord() public {
        policy.setRiskWindow(METHOD, 0);
        _signal(ID);
        _status(P.DisputeProtectionIntentStatus.NONE);
    }
    function test_SignalRevertsWhenPausedOptedOutDuplicateOrTokenMismatch() public {
        policy.setAdmissionsPaused(true);
        vm.expectRevert(P.AdmissionsPaused.selector);
        _signal(ID);
        policy.setAdmissionsPaused(false);
        _opt(false);
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionNotEnabled.selector, address(escrow), 1, METHOD));
        _signal(ID);
        _opt(true);
        _signal(ID);
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionIntentAlreadyExists.selector, ID));
        _signal(ID);
        escrow.setDeposit(DEPOSITOR, IERC20(STRANGER));
        vm.expectRevert(abi.encodeWithSelector(P.IntentTokenMismatch.selector, address(usdc), STRANGER));
        _signal(ID2);
    }
    function test_CancelPendingDoesNotTouchVault() public {
        _signal(ID);
        policy.onIntentCancelled(ID);
        _status(P.DisputeProtectionIntentStatus.CANCELLED);
        assertEq(vault.totalAccounted(), 0);
    }
    function test_CancelUnknownIsNoop() public {
        policy.onIntentCancelled(ID);
        _status(P.DisputeProtectionIntentStatus.NONE);
    }
    function test_CancelSettledReverts() public {
        _fund();
        _unexpected(P.DisputeProtectionIntentStatus.SETTLED);
        policy.onIntentCancelled(ID);
    }
    function test_BypassReleasesWithoutLock() public {
        _signal(ID);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeProtectionIntentSettled(ID, P.CollateralSource.BYPASS, address(0), GROSS, 0, uint64(block.timestamp), false);
        assertFalse(policy.onIntentSettled(ID, GROSS, NET, true, false));
        assertEq(_record().releaseEligibleAt, block.timestamp);
        _status(P.DisputeProtectionIntentStatus.RELEASED);
        assertEq(uint256(_record().collateralSource), uint256(P.CollateralSource.BYPASS));
        assertEq(vault.totalAccounted(), 0);
    }
    function test_ManualReleasePaysNowWithoutLock() public {
        for (uint256 i; i < 4; ++i) {
            if (i == 2) _stake(TAKER, GROSS);
            bytes32 id = bytes32(i + 1);
            _signal(id);
            vm.expectEmit(true, true, true, true, address(policy));
            emit DisputeProtectionIntentSettled(id, P.CollateralSource.MANUAL_RELEASE, address(0), GROSS, 0, uint64(block.timestamp), true);
            assertFalse(policy.onIntentSettled(id, GROSS, NET, i % 2 == 0, true));
            P.DisputeProtectionIntent memory r = policy.getDisputeProtectionIntent(id);
            assertEq(uint256(r.status), uint256(P.DisputeProtectionIntentStatus.RELEASED));
            assertEq(uint256(r.collateralSource), uint256(P.CollateralSource.MANUAL_RELEASE));
            assertEq(r.releaseEligibleAt, block.timestamp);
            assertEq(r.lockedAmount, 0);
            assertEq(r.stakeOwner, address(0));
            assertEq(vault.lockedStake(TAKER), 0);
        }
    }
    function test_StakeBoundaryEqualLocksStake() public {
        _settleStake();
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
        _status(P.DisputeProtectionIntentStatus.AWAITING_FUNDING);
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
        _signal(ID);
        policy.onIntentSettled(ID, GROSS, NET, false, false);
        assertEq(_record().stakeOwner, STRANGER);
        assertEq(vault.lockedStake(STRANGER), GROSS);
    }
    function test_StakeWithdrawnAfterSignalDefers() public {
        _stake(TAKER, GROSS);
        _signal(ID);
        vm.prank(TAKER);
        vault.withdrawStake(GROSS);
        assertTrue(policy.onIntentSettled(ID, GROSS, NET, false, false));
    }
    function test_DelegationRevokedAfterSignalFallsBackToTaker() public {
        _delegate();
        _signal(ID);
        vm.prank(STRANGER);
        vault.setTakerAuthorization(TAKER, false);
        assertEq(vault.stakeOwnerOf(TAKER), TAKER);
        assertTrue(policy.onIntentSettled(ID, GROSS, NET, false, false));
        assertEq(vault.lockedStake(STRANGER), 0);
    }
    function test_TwoPendingIntentsCompeteForOneStake() public {
        _stake(TAKER, 150e6);
        _signal(ID);
        _signal(ID2);
        assertFalse(policy.onIntentSettled(ID, GROSS, NET, false, false));
        assertTrue(policy.onIntentSettled(ID2, GROSS, NET, false, false));
        assertEq(vault.lockedStake(TAKER), GROSS);
        assertLe(vault.lockedStake(TAKER), vault.stakeBalance(TAKER));
    }
    function test_AdmittedIntentKeepsSnapshot() public {
        _signal(ID);
        policy.setRiskWindow(METHOD, 1 days);
        _opt(false);
        assertTrue(policy.onIntentSettled(ID, GROSS, NET, false, false));
        assertEq(_record().releaseEligibleAt, block.timestamp + WINDOW);
    }
    function test_ZeroAmountsFailClosed() public {
        _signal(ID);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidSettlementAmount.selector, 0, NET));
        policy.onIntentSettled(ID, 0, NET, false, false);
        vm.expectRevert(abi.encodeWithSelector(P.InvalidSettlementAmount.selector, GROSS, 0));
        policy.onIntentSettled(ID, GROSS, 0, false, false);
    }
    function test_SettleTwiceReverts() public {
        _settleStake();
        _unexpected(P.DisputeProtectionIntentStatus.SETTLED);
        policy.onIntentSettled(ID, GROSS, NET, false, false);
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
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientUnaccountedTokens.selector, 0, NET));
        policy.onDeferredPayoutFunded(ID);
    }
    function test_FundWrongStatusReverts() public {
        _unexpected(P.DisputeProtectionIntentStatus.NONE);
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
        policy.onIntentSignaled(ID2, address(escrow), 1, RECIPIENT, STRANGER, METHOD);
        assertFalse(policy.onIntentSettled(ID2, 60e6, 59e6, false, false));
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
    function test_LifecycleEntrypointsRequireAuthorizedHook() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedLifecycleHook.selector, STRANGER));
        policy.onIntentSignaled(ID, address(escrow), 1, TAKER, RECIPIENT, METHOD);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedLifecycleHook.selector, STRANGER));
        policy.onIntentCancelled(ID);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedLifecycleHook.selector, STRANGER));
        policy.onIntentSettled(ID, GROSS, NET, false, false);
        vm.expectRevert(abi.encodeWithSelector(P.UnauthorizedLifecycleHook.selector, STRANGER));
        policy.onDeferredPayoutFunded(ID);
        vm.stopPrank();
    }
    function test_RenounceDisabled() public {
        vm.expectRevert(P.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }
    function test_ConstructorRejectsZeroOrCodelessDependencies() public {
        vm.expectRevert(P.ZeroAddress.selector);
        new CascadeDisputeProtectionPolicy(address(0), vault, verifier, disputes, IPredecessorDisputeProtectionPolicy(address(0)));
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                address bad = j == 0 ? address(0) : STRANGER;
                if (j == 0) vm.expectRevert(P.ZeroAddress.selector);
                else vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, bad));
                new CascadeDisputeProtectionPolicy(address(this), i == 0 ? IStakeVault(bad) : vault, i == 1 ? IDisputeVerifier(bad) : verifier, i == 2 ? INullifierRegistry(bad) : disputes, IPredecessorDisputeProtectionPolicy(address(0)));
            }
        }
        vm.expectRevert(abi.encodeWithSelector(P.InvalidContract.selector, STRANGER));
        new CascadeDisputeProtectionPolicy(address(this), vault, verifier, disputes, IPredecessorDisputeProtectionPolicy(STRANGER));
    }
    function test_SetDisputeVerifier() public {
        DisputeVerifier next = new DisputeVerifier(address(this), payments, new AttestationVerifierMock());
        vm.expectEmit(true, true, false, true, address(policy));
        emit DisputeVerifierUpdated(address(verifier), address(next));
        policy.setDisputeVerifier(address(next));
        assertEq(address(policy.disputeVerifier()), address(next));
    }
    function test_AcceptVaultController() public {
        vault = new StakeVault(address(this), usdc, address(this), 0);
        _newPolicy(IPredecessorDisputeProtectionPolicy(address(0)));
        vault.proposeController(address(policy));
        policy.acceptVaultController();
        assertEq(vault.controller(), address(policy));
    }
    function test_BatchReleaseIsAtomic() public {
        _stake(TAKER, 2 * GROSS);
        _signal(ID);
        policy.onIntentSettled(ID, GROSS, NET, false, false);
        vm.warp(vm.getBlockTimestamp() + 1);
        _signal(ID2);
        policy.onIntentSettled(ID2, GROSS, NET, false, false);
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
    function test_SetRiskWindowBoundsAndEmits() public {
        uint64 max = policy.MAX_RISK_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(P.InvalidRiskWindow.selector, max + 1));
        policy.setRiskWindow(METHOD, max + 1);
        vm.expectEmit(true, false, false, true, address(policy));
        emit RiskWindowUpdated(METHOD, max);
        policy.setRiskWindow(METHOD, max);
        assertEq(policy.getRiskWindow(METHOD), max);
    }
    function test_SetDisputeProtectionEnabledOnlyDepositor() public {
        vm.expectRevert(abi.encodeWithSelector(P.NotDepositor.selector, address(escrow), 1, address(this)));
        policy.setDisputeProtectionEnabled(address(escrow), 1, METHOD, false);
        _opt(false);
        assertFalse(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
    }
    function test_InheritsPredecessorOptOut() public {
        PredecessorPolicyStub predecessor = new PredecessorPolicyStub();
        _newPolicy(predecessor);
        assertEq(address(policy.predecessorPolicy()), address(predecessor));
        assertFalse(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
        vm.expectRevert(abi.encodeWithSelector(P.DisputeProtectionNotEnabled.selector, address(escrow), 1, METHOD));
        _signal(ID);
    }
    function test_LocalSettingOverridesPredecessor() public {
        PredecessorPolicyStub predecessor = new PredecessorPolicyStub();
        _newPolicy(predecessor);
        _opt(true);
        assertTrue(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
        _signal(ID);
        predecessor.configure(WINDOW, true);
        _opt(false);
        assertFalse(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
    }
    function test_PredecessorZeroWindowNotInherited() public {
        PredecessorPolicyStub predecessor = new PredecessorPolicyStub();
        predecessor.configure(0, false);
        _newPolicy(predecessor);
        assertTrue(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
        _signal(ID);
    }
    function test_NoPredecessorMeansEnabled() public {
        assertEq(address(policy.predecessorPolicy()), address(0));
        assertTrue(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
        _signal(ID);
    }
    function test_SetAdmissionsPausedEmits() public {
        vm.expectEmit(false, false, false, true, address(policy));
        emit AdmissionsPausedUpdated(true);
        policy.setAdmissionsPaused(true);
        assertTrue(policy.admissionsPaused());
    }
    function test_Views() public {
        _signal(ID);
        P.DisputeProtectionIntent memory r = _record();
        assertEq(r.taker, TAKER);
        assertEq(r.depositor, DEPOSITOR);
        assertEq(r.paymentMethod, METHOD);
        assertEq(policy.getRiskWindow(METHOD), WINDOW);
        assertTrue(policy.isLifecycleHookAuthorized(address(this)));
        assertFalse(policy.isLifecycleHookAuthorized(STRANGER));
        assertTrue(policy.isDisputeProtectionEnabled(address(escrow), 1, METHOD));
        assertEq(address(policy.stakeVault()), address(vault));
        assertEq(address(policy.disputeNullifierRegistry()), address(disputes));
    }
}
