// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract DisputeProtectionEscrowMock {
    IEscrowV2.Deposit internal deposit;

    constructor(address depositor, IERC20 token) {
        deposit.depositor = depositor;
        deposit.token = token;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory) {
        return deposit;
    }
}

contract DisputeProtectionPolicyTest is OrchestratorV3Fixture {
    event DisputeProtectionIntentSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 releaseAmount,
        uint64 releaseEligibleAt,
        bool isManualRelease
    );
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool authorized);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    bytes32 internal constant INTENT = keccak256("intent");

    StakeVault internal vault;
    NullifierRegistryV2 internal nullifierRegistry;
    NullifierRegistry internal disputeNullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    DisputeVerifier internal disputeVerifier;
    DisputeProtectionPolicy internal disputeProtectionPolicy;

    function setUp() public override {
        super.setUp();
        vault = new StakeVault(address(this), token, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        disputeNullifierRegistry = new NullifierRegistry();
        attestationVerifier = new AttestationVerifierMock();
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistry, attestationVerifier);
        disputeProtectionPolicy =
            new DisputeProtectionPolicy(address(this), vault, disputeVerifier, disputeNullifierRegistry);
        vault.initializeController(address(disputeProtectionPolicy));
        disputeNullifierRegistry.addWritePermission(address(disputeProtectionPolicy));
        disputeProtectionPolicy.setLifecycleHookAuthorization(address(this), true);
        disputeProtectionPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, true);
        _stake(taker, STAKE_AMOUNT);
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(IDisputeProtectionPolicy.ZeroAddress.selector);
        new DisputeProtectionPolicy(address(0), vault, disputeVerifier, disputeNullifierRegistry);
    }

    function test_onIntentSignaledLocksStakeAndSnapshotsConfiguration() public {
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.setRiskWindow(METHOD, 7 days);
        assertEq(disputeProtectionPolicy.getRiskWindow(METHOD), 7 days);

        IDisputeProtectionPolicy.DisputeProtectionIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getDisputeProtectionIntent(INTENT);
        assertEq(disputeProtectionIntent.taker, taker);
        assertEq(disputeProtectionIntent.stakeOwner, taker);
        assertEq(disputeProtectionIntent.depositor, depositor);
        assertEq(disputeProtectionIntent.riskWindow, RISK_WINDOW);
        assertEq(disputeProtectionIntent.releaseAmount, 0);
        assertEq(
            uint256(disputeProtectionIntent.status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );
        (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(stakeOwner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, type(uint64).max);
    }

    function test_onIntentSignaledRejectsUnauthorizedPausedDisabledAndDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, other));
        vm.prank(other);
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        disputeProtectionPolicy.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.setAdmissionsPaused(false);

        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionNotEnabled.selector, address(escrow), depositId
            )
        );
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, true);

        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.DisputeProtectionIntentAlreadyExists.selector, INTENT)
        );
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
    }

    function test_onIntentSignaledPassesThroughWindowlessMethodEvenWhenAdmissionsPaused() public {
        bytes32 windowlessMethod = keccak256("windowless");
        uint256 lockedBefore = vault.lockedStake(taker);
        uint256 freeBefore = vault.freeStake(taker);
        disputeProtectionPolicy.setAdmissionsPaused(true);

        disputeProtectionPolicy.onIntentSignaled(
            INTENT, address(escrow), depositId, taker, windowlessMethod, INTENT_AMOUNT
        );

        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);

        disputeProtectionPolicy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
        disputeProtectionPolicy.onIntentCancelled(INTENT);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);
    }

    function test_onIntentSignaledRejectsWrongTokenAndLetsVaultEnforceCollateral() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        DisputeProtectionEscrowMock wrongTokenEscrow = new DisputeProtectionEscrowMock(depositor, otherToken);
        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(wrongTokenEscrow), depositId, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.IntentTokenMismatch.selector, address(token), address(otherToken)
            )
        );
        disputeProtectionPolicy.onIntentSignaled(
            INTENT, address(wrongTokenEscrow), depositId, taker, METHOD, INTENT_AMOUNT
        );

        bytes32 secondIntent = keccak256("second-intent");
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        disputeProtectionPolicy.onIntentSignaled(secondIntent, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);
    }

    function test_DelegatedStakeLocksSelectedOwnersStake() public {
        address stakeOwner = makeAddr("stakeOwner");
        _stake(stakeOwner, STAKE_AMOUNT);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(other, true);
        vm.prank(other);
        vault.selectStakeOwner(stakeOwner);

        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);

        assertEq(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).stakeOwner, stakeOwner);
        assertEq(vault.lockedStake(stakeOwner), INTENT_AMOUNT);
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancellationUnlocksPendingNoneIsNoOpAndSettledReverts() public {
        disputeProtectionPolicy.onIntentCancelled(keccak256("missing"));
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentCancelled(INTENT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
        );

        bytes32 settledIntent = keccak256("settled");
        disputeProtectionPolicy.onIntentSignaled(
            settledIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT
        );
        disputeProtectionPolicy.onIntentSettled(settledIntent, INTENT_AMOUNT, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotPending.selector,
                settledIntent,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED
            )
        );
        disputeProtectionPolicy.onIntentCancelled(settledIntent);
    }

    function test_SettlementResizesFullAndPartialAndEmitsManualFlag() public {
        disputeProtectionPolicy.onIntentSettled(keccak256("missing"), INTENT_AMOUNT, false);
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.expectEmit(true, true, true, true);
        emit DisputeProtectionIntentSettled(INTENT, taker, depositor, 40e6, uint64(releaseEligibleAt), true);
        disputeProtectionPolicy.onIntentSettled(INTENT, 40e6, true);

        IDisputeProtectionPolicy.DisputeProtectionIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getDisputeProtectionIntent(INTENT);
        assertEq(
            uint256(disputeProtectionIntent.status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(disputeProtectionIntent.releaseEligibleAt, releaseEligibleAt);
        assertEq(disputeProtectionIntent.releaseAmount, 40e6);
        (, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(amount, 40e6);
        assertEq(maturesAt, releaseEligibleAt);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotPending.selector,
                INTENT,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED
            )
        );
        disputeProtectionPolicy.onIntentSettled(INTENT, 40e6, true);

        bytes32 fullIntent = keccak256("full");
        disputeProtectionPolicy.onIntentSignaled(fullIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(fullIntent, INTENT_AMOUNT, false);
        (, amount,) = vault.locks(fullIntent);
        assertEq(amount, INTENT_AMOUNT);
    }

    function test_ReleaseMaturedDisputeProtectionIntentAndBatchFreeStakeAtBoundary() public {
        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(INTENT, 20e6, false);
        _admitAndSettle(secondIntent, 30e6, false);
        uint64 releaseEligibleAt = disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).releaseEligibleAt;

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotReleaseEligible.selector,
                releaseEligibleAt,
                uint64(vm.getBlockTimestamp())
            )
        );
        disputeProtectionPolicy.releaseMaturedDisputeProtectionIntent(INTENT);

        vm.warp(releaseEligibleAt);
        bytes32[] memory intents = new bytes32[](2);
        intents[0] = INTENT;
        intents[1] = secondIntent;
        disputeProtectionPolicy.releaseMaturedDisputeProtectionIntents(intents);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                INTENT,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.RELEASED
            )
        );
        disputeProtectionPolicy.releaseMaturedDisputeProtectionIntent(INTENT);
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
        disputeProtectionPolicy.submitDispute(attestation);

        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        disputeProtectionPolicy.submitDispute(attestation);

        assertEq(vault.claimable(depositor), 40e6);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.stakeBalance(taker), STAKE_AMOUNT - 40e6);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.DISPUTED)
        );
    }

    function test_SubmitDisputeRequiresSettledIntent() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                INTENT,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE
            )
        );
        disputeProtectionPolicy.submitDispute(attestation);

        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                INTENT,
                IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING
            )
        );
        disputeProtectionPolicy.submitDispute(attestation);
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
        disputeProtectionPolicy.submitDispute(attestation);
        bytes32 disputeNullifier = keccak256(abi.encodePacked(METHOD, disputeId));
        assertFalse(disputeNullifierRegistry.isNullified(disputeNullifier));
        assertEq(vault.claimable(depositor), 0);
        assertEq(vault.lockedStake(taker), 40e6);
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
        disputeProtectionPolicy.submitDispute(attestation);

        attestation = _attestation(INTENT, keccak256("wrong"), paymentId, keccak256("dispute"));
        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        disputeProtectionPolicy.submitDispute(attestation);

        attestation = _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        attestationVerifier.setResult(false);
        vm.expectRevert(IDisputeVerifier.AttestationVerificationFailed.selector);
        disputeProtectionPolicy.submitDispute(attestation);
        attestationVerifier.setResult(true);

        uint64 releaseEligibleAt = disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).releaseEligibleAt;
        vm.warp(releaseEligibleAt);
        disputeProtectionPolicy.submitDispute(attestation);
        assertEq(vault.claimable(depositor), 40e6);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.DISPUTED)
        );
    }

    function test_GovernanceSettersEnforceOwnershipAndValidation() public {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        disputeProtectionPolicy.setRiskWindow(METHOD, 1 days);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        disputeProtectionPolicy.setAdmissionsPaused(true);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        disputeProtectionPolicy.setDisputeVerifier(address(disputeVerifier));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        disputeProtectionPolicy.setLifecycleHookAuthorization(address(this), true);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.InvalidRiskWindow.selector, uint64(365 days + 1))
        );
        disputeProtectionPolicy.setRiskWindow(METHOD, uint64(365 days + 1));
        vm.expectRevert(IDisputeProtectionPolicy.ZeroAddress.selector);
        disputeProtectionPolicy.setDisputeVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(IDisputeProtectionPolicy.InvalidContract.selector, other));
        disputeProtectionPolicy.setLifecycleHookAuthorization(other, true);
        vm.expectRevert(IDisputeProtectionPolicy.OwnershipRenunciationDisabled.selector);
        disputeProtectionPolicy.renounceOwnership();
    }

    function test_SetLifecycleHookAuthorizationAllowsMultipleHooksAndExplicitRevocation() public {
        address newHook = address(attestationVerifier);

        disputeProtectionPolicy.setLifecycleHookAuthorization(newHook, true);

        assertTrue(disputeProtectionPolicy.isLifecycleHookAuthorized(address(this)));
        assertTrue(disputeProtectionPolicy.isLifecycleHookAuthorized(newHook));
        disputeProtectionPolicy.onIntentCancelled(keccak256("old-hook-cancel"));
        vm.prank(newHook);
        disputeProtectionPolicy.onIntentSettled(keccak256("new-hook-settle"), INTENT_AMOUNT, false);

        vm.expectEmit(true, false, false, true);
        emit LifecycleHookAuthorizationUpdated(address(this), false);
        disputeProtectionPolicy.setLifecycleHookAuthorization(address(this), false);

        assertFalse(disputeProtectionPolicy.isLifecycleHookAuthorized(address(this)));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(this))
        );
        disputeProtectionPolicy.onIntentCancelled(INTENT);
    }

    function test_SetDisputeVerifierRejectsEoaThenReplacesAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputeProtectionPolicy.InvalidContract.selector, other));
        disputeProtectionPolicy.setDisputeVerifier(other);

        DisputeVerifier replacement = new DisputeVerifier(address(this), nullifierRegistry, attestationVerifier);
        vm.expectEmit(true, true, false, true);
        emit DisputeVerifierUpdated(address(disputeVerifier), address(replacement));
        disputeProtectionPolicy.setDisputeVerifier(address(replacement));
        assertEq(address(disputeProtectionPolicy.disputeVerifier()), address(replacement));
    }

    function test_SettlementRejectsReleaseEligibilityTimestampOverflow() public {
        disputeProtectionPolicy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 overflowingTimestamp = uint256(type(uint64).max) - RISK_WINDOW + 1;
        vm.warp(overflowingTimestamp);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.TimestampOverflow.selector, overflowingTimestamp + RISK_WINDOW
            )
        );
        disputeProtectionPolicy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
    }

    function test_MaturedReleaseRejectsCurrentTimestampOverflow() public {
        _admitAndSettle(INTENT, INTENT_AMOUNT, false);
        uint256 overflowingTimestamp = uint256(type(uint64).max) + 1;
        vm.warp(overflowingTimestamp);

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.TimestampOverflow.selector, overflowingTimestamp)
        );
        disputeProtectionPolicy.releaseMaturedDisputeProtectionIntent(INTENT);
    }

    function test_SetDisputeProtectionEnabledEnforcesDepositorAndHandlesMissingDeposit() public {
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.NotDepositor.selector, address(escrow), depositId, other)
        );
        vm.prank(other);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, true);

        uint256 missingDeposit = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.NotDepositor.selector, address(escrow), missingDeposit, address(this)
            )
        );
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), missingDeposit, true);

        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, false);
        assertFalse(disputeProtectionPolicy.isDisputeProtectionEnabled(address(escrow), depositId));
    }

    function test_AcceptVaultControllerCompletesDelayedTwoStepHandover() public {
        StakeVault secondVault = new StakeVault(address(this), token, address(0), 1 days);
        DisputeProtectionPolicy secondDisputeProtectionPolicy =
            new DisputeProtectionPolicy(address(this), secondVault, disputeVerifier, disputeNullifierRegistry);
        secondVault.initializeController(address(this));
        secondVault.proposeController(address(secondDisputeProtectionPolicy));
        uint256 acceptanceTime = vm.getBlockTimestamp() + secondVault.controllerChangeDelay();
        vm.warp(acceptanceTime);
        secondDisputeProtectionPolicy.acceptVaultController();
        assertEq(secondVault.controller(), address(secondDisputeProtectionPolicy));
    }

    function _stake(address stakeOwner, uint256 amount) internal {
        token.transfer(stakeOwner, amount);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _admitAndSettle(bytes32 intentHash, uint256 releaseAmount, bool manualRelease) internal {
        disputeProtectionPolicy.onIntentSignaled(intentHash, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(intentHash, releaseAmount, manualRelease);
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
