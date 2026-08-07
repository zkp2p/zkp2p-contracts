// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputePolicy} from "contracts/hooks/DisputePolicy.sol";
import {IDisputePolicy} from "contracts/interfaces/IDisputePolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {ERC4626Mock} from "contracts/mocks/ERC4626Mock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract DisputeEscrowMock {
    IEscrowV2.Deposit internal deposit;

    constructor(address depositor, IERC20 token) {
        deposit.depositor = depositor;
        deposit.token = token;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory) {
        return deposit;
    }
}

contract DisputePolicyTest is OrchestratorV3Fixture {
    event DisputeIntentSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 releaseAmount,
        uint256 collateralAmount,
        uint64 releaseEligibleAt,
        bool isManualRelease
    );
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool authorized);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_ASSETS = 500e6;
    bytes32 internal constant INTENT = keccak256("intent");

    StakeVault internal vault;
    ERC4626Mock internal collateralVault;
    NullifierRegistryV2 internal nullifierRegistry;
    NullifierRegistry internal disputeNullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    DisputeVerifier internal disputeVerifier;
    DisputePolicy internal policy;
    uint256 internal stakeShares;

    function setUp() public override {
        super.setUp();
        collateralVault = new ERC4626Mock(token);
        vault = new StakeVault(address(this), collateralVault, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        disputeNullifierRegistry = new NullifierRegistry();
        attestationVerifier = new AttestationVerifierMock();
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistry, attestationVerifier);
        policy = _newPolicy(vault, collateralVault, token);
        vault.initializeController(address(policy));
        disputeNullifierRegistry.addWritePermission(address(policy));
        policy.setLifecycleHookAuthorization(address(this), true);
        policy.setRiskWindow(METHOD, RISK_WINDOW);
        vm.prank(depositor);
        policy.setDisputeEnabled(address(escrow), depositId, true);
        stakeShares = _stake(taker, STAKE_ASSETS);
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(IDisputePolicy.ZeroAddress.selector);
        new DisputePolicy(address(0), token, collateralVault, vault, disputeVerifier, disputeNullifierRegistry);
    }

    function test_ConstructorRejectsCollateralWithWrongAssetOrStakeToken() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        ERC4626Mock wrongAssetVault = new ERC4626Mock(otherToken);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.CollateralAssetMismatch.selector, address(token), address(otherToken))
        );
        new DisputePolicy(address(this), token, wrongAssetVault, vault, disputeVerifier, disputeNullifierRegistry);

        StakeVault wrongStakeVault = new StakeVault(address(this), token, address(0), 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.StakeTokenMismatch.selector, address(collateralVault), address(token))
        );
        new DisputePolicy(
            address(this), token, collateralVault, wrongStakeVault, disputeVerifier, disputeNullifierRegistry
        );
    }

    function test_onIntentSignaledLocksStakeAndSnapshotsConfiguration() public {
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.setRiskWindow(METHOD, 7 days);
        assertEq(policy.getRiskWindow(METHOD), 7 days);

        IDisputePolicy.DisputeIntent memory disputeIntent = policy.getDisputeIntent(INTENT);
        assertEq(disputeIntent.taker, taker);
        assertEq(disputeIntent.stakeOwner, taker);
        assertEq(disputeIntent.depositor, depositor);
        assertEq(disputeIntent.riskWindow, RISK_WINDOW);
        assertEq(disputeIntent.intentAmount, INTENT_AMOUNT);
        assertEq(disputeIntent.collateralAmount, policy.quoteCollateral(INTENT_AMOUNT));
        assertEq(disputeIntent.releaseAmount, 0);
        assertEq(uint256(disputeIntent.status), uint256(IDisputePolicy.DisputeIntentStatus.PENDING));
        (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(stakeOwner, taker);
        assertEq(amount, policy.quoteCollateral(INTENT_AMOUNT));
        assertEq(maturesAt, type(uint64).max);
    }

    function test_onIntentSignaledRejectsUnauthorizedPausedDisabledAndDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.UnauthorizedLifecycleHook.selector, other));
        vm.prank(other);
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        policy.setAdmissionsPaused(true);
        vm.expectRevert(IDisputePolicy.AdmissionsPaused.selector);
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.setAdmissionsPaused(false);

        vm.prank(depositor);
        policy.setDisputeEnabled(address(escrow), depositId, false);
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.DisputeNotEnabled.selector, address(escrow), depositId));
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.prank(depositor);
        policy.setDisputeEnabled(address(escrow), depositId, true);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.DisputeIntentAlreadyExists.selector, INTENT));
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
    }

    function test_onIntentSignaledPassesThroughWindowlessMethodEvenWhenAdmissionsPaused() public {
        bytes32 windowlessMethod = keccak256("windowless");
        uint256 lockedBefore = vault.lockedStake(taker);
        uint256 freeBefore = vault.freeStake(taker);
        policy.setAdmissionsPaused(true);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, windowlessMethod, INTENT_AMOUNT);

        assertEq(uint256(policy.getDisputeIntent(INTENT).status), uint256(IDisputePolicy.DisputeIntentStatus.NONE));
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);

        policy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
        policy.onIntentCancelled(INTENT);
        assertEq(uint256(policy.getDisputeIntent(INTENT).status), uint256(IDisputePolicy.DisputeIntentStatus.NONE));
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);
    }

    function test_onIntentSignaledRejectsWrongTokenAndLetsVaultEnforceCollateral() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        DisputeEscrowMock wrongTokenEscrow = new DisputeEscrowMock(depositor, otherToken);
        vm.prank(depositor);
        policy.setDisputeEnabled(address(wrongTokenEscrow), depositId, true);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
        policy.onIntentSignaled(INTENT, address(wrongTokenEscrow), depositId, taker, METHOD, INTENT_AMOUNT);

        bytes32 secondIntent = keccak256("second-intent");
        vm.expectRevert(
            abi.encodeWithSelector(
                IStakeVault.InsufficientFreeStake.selector, other, uint256(0), policy.quoteCollateral(INTENT_AMOUNT)
            )
        );
        policy.onIntentSignaled(secondIntent, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);
    }

    function test_DelegatedStakeLocksSelectedOwnersStake() public {
        address stakeOwner = makeAddr("stakeOwner");
        _stake(stakeOwner, STAKE_ASSETS);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(other, true);
        vm.prank(other);
        vault.selectStakeOwner(stakeOwner);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);

        assertEq(policy.getDisputeIntent(INTENT).stakeOwner, stakeOwner);
        assertEq(vault.lockedStake(stakeOwner), policy.quoteCollateral(INTENT_AMOUNT));
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancellationUnlocksPendingNoneIsNoOpAndSettledReverts() public {
        policy.onIntentCancelled(keccak256("missing"));
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentCancelled(INTENT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(uint256(policy.getDisputeIntent(INTENT).status), uint256(IDisputePolicy.DisputeIntentStatus.CANCELLED));

        bytes32 settledIntent = keccak256("settled");
        policy.onIntentSignaled(settledIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(settledIntent, INTENT_AMOUNT, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotPending.selector,
                settledIntent,
                IDisputePolicy.DisputeIntentStatus.SETTLED
            )
        );
        policy.onIntentCancelled(settledIntent);
    }

    function test_SettlementResizesFullAndPartialAndEmitsManualFlag() public {
        policy.onIntentSettled(keccak256("missing"), INTENT_AMOUNT, false);
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.expectEmit(true, true, true, true);
        uint256 expectedCollateral =
            Math.mulDiv(policy.quoteCollateral(INTENT_AMOUNT), 40e6, INTENT_AMOUNT, Math.Rounding.Up);
        emit DisputeIntentSettled(INTENT, taker, depositor, 40e6, expectedCollateral, uint64(releaseEligibleAt), true);
        policy.onIntentSettled(INTENT, 40e6, true);

        IDisputePolicy.DisputeIntent memory disputeIntent = policy.getDisputeIntent(INTENT);
        assertEq(uint256(disputeIntent.status), uint256(IDisputePolicy.DisputeIntentStatus.SETTLED));
        assertEq(disputeIntent.releaseEligibleAt, releaseEligibleAt);
        assertEq(disputeIntent.releaseAmount, 40e6);
        (, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(amount, expectedCollateral);
        assertEq(maturesAt, releaseEligibleAt);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotPending.selector, INTENT, IDisputePolicy.DisputeIntentStatus.SETTLED
            )
        );
        policy.onIntentSettled(INTENT, 40e6, true);

        bytes32 fullIntent = keccak256("full");
        policy.onIntentSignaled(fullIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(fullIntent, INTENT_AMOUNT, false);
        (, amount,) = vault.locks(fullIntent);
        assertEq(amount, policy.quoteCollateral(INTENT_AMOUNT));
    }

    function test_SettlementRejectsReleaseAboveOriginalIntentAmount() public {
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.ReleaseAmountExceedsIntent.selector, INTENT_AMOUNT, INTENT_AMOUNT + 1)
        );
        policy.onIntentSettled(INTENT, INTENT_AMOUNT + 1, false);
    }

    function test_ReleaseMaturedDisputeIntentAndBatchFreeStakeAtBoundary() public {
        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(INTENT, 20e6, false);
        _admitAndSettle(secondIntent, 30e6, false);
        uint64 releaseEligibleAt = policy.getDisputeIntent(INTENT).releaseEligibleAt;

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotReleaseEligible.selector,
                releaseEligibleAt,
                uint64(vm.getBlockTimestamp())
            )
        );
        policy.releaseMaturedDisputeIntent(INTENT);

        vm.warp(releaseEligibleAt);
        bytes32[] memory intents = new bytes32[](2);
        intents[0] = INTENT;
        intents[1] = secondIntent;
        policy.releaseMaturedDisputeIntents(intents);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), stakeShares);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotSettled.selector, INTENT, IDisputePolicy.DisputeIntentStatus.RELEASED
            )
        );
        policy.releaseMaturedDisputeIntent(INTENT);
    }

    function test_SubmitDisputeProofPathRequiresBothDirectionBindingAndCreatesClaim() public {
        _admitAndSettle(INTENT, 40e6, false);
        bytes32 paymentId = keccak256("payment");
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier)
        );
        policy.submitDispute(attestation);

        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        policy.submitDispute(attestation);

        uint256 compensatedShares = collateralVault.previewWithdraw(40e6);
        assertEq(vault.claimable(depositor), compensatedShares);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.stakeBalance(taker), stakeShares - compensatedShares);
        assertEq(uint256(policy.getDisputeIntent(INTENT).status), uint256(IDisputePolicy.DisputeIntentStatus.DISPUTED));
    }

    function test_SubmitDisputeRequiresSettledIntent() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotSettled.selector, INTENT, IDisputePolicy.DisputeIntentStatus.NONE
            )
        );
        policy.submitDispute(attestation);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.DisputeIntentNotSettled.selector, INTENT, IDisputePolicy.DisputeIntentStatus.PENDING
            )
        );
        policy.submitDispute(attestation);
    }

    function test_SubmitDisputeRejectsManualReleaseWithoutPaymentBinding() public {
        _admitAndSettle(INTENT, 40e6, true);
        bytes32 paymentId = keccak256("unbound-payment");
        bytes32 disputeId = keccak256("dispute");
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, paymentId, disputeId);

        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier)
        );
        policy.submitDispute(attestation);
        bytes32 disputeNullifier = keccak256(abi.encodePacked(METHOD, disputeId));
        assertFalse(disputeNullifierRegistry.isNullified(disputeNullifier));
        assertEq(vault.claimable(depositor), 0);
        assertEq(vault.lockedStake(taker), _settledCollateral(INTENT));
    }

    function test_SubmitDisputeRejectsInvalidEvidenceButRemainsValidUntilCollateralRelease() public {
        _admitAndSettle(INTENT, 40e6, false);
        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        attestation.dataHash = keccak256("tampered");
        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        policy.submitDispute(attestation);

        attestation = _attestation(INTENT, keccak256("wrong"), paymentId, keccak256("dispute"));
        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        policy.submitDispute(attestation);

        attestation = _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        attestationVerifier.setResult(false);
        vm.expectRevert(IDisputeVerifier.AttestationVerificationFailed.selector);
        policy.submitDispute(attestation);
        attestationVerifier.setResult(true);

        uint64 releaseEligibleAt = policy.getDisputeIntent(INTENT).releaseEligibleAt;
        vm.warp(releaseEligibleAt);
        policy.submitDispute(attestation);
        assertEq(vault.claimable(depositor), collateralVault.previewWithdraw(40e6));
        assertEq(uint256(policy.getDisputeIntent(INTENT).status), uint256(IDisputePolicy.DisputeIntentStatus.DISPUTED));
    }

    function test_GovernanceSettersEnforceOwnershipAndValidation() public {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setRiskWindow(METHOD, 1 days);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setAdmissionsPaused(true);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setDisputeVerifier(address(disputeVerifier));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setLifecycleHookAuthorization(address(this), true);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.InvalidRiskWindow.selector, uint64(365 days + 1)));
        policy.setRiskWindow(METHOD, uint64(365 days + 1));
        vm.expectRevert(IDisputePolicy.ZeroAddress.selector);
        policy.setDisputeVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.InvalidContract.selector, other));
        policy.setLifecycleHookAuthorization(other, true);
        vm.expectRevert(IDisputePolicy.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }

    function test_SetLifecycleHookAuthorizationAllowsMultipleHooksAndExplicitRevocation() public {
        address newHook = address(attestationVerifier);

        policy.setLifecycleHookAuthorization(newHook, true);

        assertTrue(policy.isLifecycleHookAuthorized(address(this)));
        assertTrue(policy.isLifecycleHookAuthorized(newHook));
        policy.onIntentCancelled(keccak256("old-hook-cancel"));
        vm.prank(newHook);
        policy.onIntentSettled(keccak256("new-hook-settle"), INTENT_AMOUNT, false);

        vm.expectEmit(true, false, false, true);
        emit LifecycleHookAuthorizationUpdated(address(this), false);
        policy.setLifecycleHookAuthorization(address(this), false);

        assertFalse(policy.isLifecycleHookAuthorized(address(this)));
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.UnauthorizedLifecycleHook.selector, address(this)));
        policy.onIntentCancelled(INTENT);
    }

    function test_SetDisputeVerifierRejectsEoaThenReplacesAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.InvalidContract.selector, other));
        policy.setDisputeVerifier(other);

        DisputeVerifier replacement = new DisputeVerifier(address(this), nullifierRegistry, attestationVerifier);
        vm.expectEmit(true, true, false, true);
        emit DisputeVerifierUpdated(address(disputeVerifier), address(replacement));
        policy.setDisputeVerifier(address(replacement));
        assertEq(address(policy.disputeVerifier()), address(replacement));
    }

    function test_SettlementRejectsReleaseEligibilityTimestampOverflow() public {
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 overflowingTimestamp = uint256(type(uint64).max) - RISK_WINDOW + 1;
        vm.warp(overflowingTimestamp);

        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.TimestampOverflow.selector, overflowingTimestamp + RISK_WINDOW)
        );
        policy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
    }

    function test_MaturedReleaseRejectsCurrentTimestampOverflow() public {
        _admitAndSettle(INTENT, INTENT_AMOUNT, false);
        uint256 overflowingTimestamp = uint256(type(uint64).max) + 1;
        vm.warp(overflowingTimestamp);

        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.TimestampOverflow.selector, overflowingTimestamp));
        policy.releaseMaturedDisputeIntent(INTENT);
    }

    function test_SetDisputeEnabledEnforcesDepositorAndHandlesMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.NotDepositor.selector, address(escrow), depositId, other));
        vm.prank(other);
        policy.setDisputeEnabled(address(escrow), depositId, true);

        uint256 missingDeposit = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.NotDepositor.selector, address(escrow), missingDeposit, address(this))
        );
        policy.setDisputeEnabled(address(escrow), missingDeposit, true);

        vm.prank(depositor);
        policy.setDisputeEnabled(address(escrow), depositId, false);
        assertFalse(policy.isDisputeEnabled(address(escrow), depositId));
    }

    function test_AcceptVaultControllerCompletesDelayedTwoStepHandover() public {
        StakeVault secondVault = new StakeVault(address(this), collateralVault, address(0), 1 days);
        DisputePolicy secondPolicy = _newPolicy(secondVault, collateralVault, token);
        secondVault.initializeController(address(this));
        secondVault.proposeController(address(secondPolicy));
        uint256 acceptanceTime = vm.getBlockTimestamp() + secondVault.controllerChangeDelay();
        vm.warp(acceptanceTime);
        secondPolicy.acceptVaultController();
        assertEq(secondVault.controller(), address(secondPolicy));
    }

    function _stake(address stakeOwner, uint256 assets) internal returns (uint256 shares) {
        token.transfer(stakeOwner, assets);
        vm.startPrank(stakeOwner);
        token.approve(address(collateralVault), assets);
        shares = collateralVault.deposit(assets, stakeOwner);
        collateralVault.approve(address(vault), shares);
        vault.depositStake(shares);
        vm.stopPrank();
    }

    function _newPolicy(StakeVault stakeVault_, ERC4626Mock collateralVault_, IERC20 settlementToken_)
        internal
        returns (DisputePolicy)
    {
        return new DisputePolicy(
            address(this), settlementToken_, collateralVault_, stakeVault_, disputeVerifier, disputeNullifierRegistry
        );
    }

    function test_YieldReducesSharesPaidAndReturnsExcessCollateralToStaker() public {
        _admitAndSettle(INTENT, 40e6, false);
        uint256 lockedShares = _settledCollateral(INTENT);
        token.transfer(address(collateralVault), STAKE_ASSETS);
        uint256 compensatedShares = collateralVault.previewWithdraw(40e6);
        assertLt(compensatedShares, lockedShares);

        _bindPaymentAndSubmit(INTENT);

        assertEq(vault.claimable(depositor), compensatedShares);
        assertEq(vault.stakeBalance(taker), stakeShares - compensatedShares);
        assertEq(vault.freeStake(taker), stakeShares - compensatedShares);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_CollateralLossCapsDisputeCompensationAtLockedShares() public {
        _admitAndSettle(INTENT, 40e6, false);
        uint256 lockedShares = _settledCollateral(INTENT);
        collateralVault.removeAssets(address(this), STAKE_ASSETS - 10e6);
        assertGt(collateralVault.previewWithdraw(40e6), lockedShares);

        _bindPaymentAndSubmit(INTENT);

        assertEq(vault.claimable(depositor), lockedShares);
        assertEq(vault.stakeBalance(taker), stakeShares - lockedShares);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_PreviewFailureBlocksAdmissionButDisputeFallsBackToFullLock() public {
        collateralVault.setPreviewWithdrawReverting(true);
        vm.expectRevert(IDisputePolicy.CollateralConversionUnavailable.selector);
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        collateralVault.setPreviewWithdrawReverting(false);
        _admitAndSettle(INTENT, 40e6, false);
        uint256 lockedShares = _settledCollateral(INTENT);
        collateralVault.setPreviewWithdrawReverting(true);

        _bindPaymentAndSubmit(INTENT);

        assertEq(vault.claimable(depositor), lockedShares);
        assertEq(vault.lockedStake(taker), 0);
    }

    function _settledCollateral(bytes32 intentHash) internal view returns (uint256 amount) {
        (, amount,) = vault.locks(intentHash);
    }

    function _bindPaymentAndSubmit(bytes32 intentHash) internal {
        bytes32 paymentId = keccak256("payment");
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(keccak256(abi.encodePacked(METHOD, paymentId)), intentHash);
        policy.submitDispute(_attestation(intentHash, METHOD, paymentId, keccak256("dispute")));
    }

    function _admitAndSettle(bytes32 intentHash, uint256 releaseAmount, bool manualRelease) internal {
        policy.onIntentSignaled(intentHash, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(intentHash, releaseAmount, manualRelease);
    }

    function _attestation(bytes32 intentHash, bytes32 paymentMethod, bytes32 paymentId, bytes32 disputeId)
        internal
        pure
        returns (IDisputeVerifier.DisputeAttestation memory attestation)
    {
        IDisputeVerifier.DisputeDetails memory details = IDisputeVerifier.DisputeDetails({
            paymentMethod: paymentMethod,
            originalPaymentId: paymentId,
            disputeId: disputeId,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }
}
