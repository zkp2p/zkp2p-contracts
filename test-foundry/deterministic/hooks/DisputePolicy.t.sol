// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputePolicy} from "contracts/hooks/DisputePolicy.sol";
import {IDisputePolicy} from "contracts/interfaces/IDisputePolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract ChargebackEscrowMock {
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
    event ChargebackIntentSettled(
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
    NullifierRegistry internal chargebackNullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    DisputeVerifier internal disputeVerifier;
    DisputePolicy internal policy;

    function setUp() public override {
        super.setUp();
        vault = new StakeVault(address(this), token, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        chargebackNullifierRegistry = new NullifierRegistry();
        attestationVerifier = new AttestationVerifierMock();
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistry, attestationVerifier);
        policy = new DisputePolicy(address(this), vault, disputeVerifier, chargebackNullifierRegistry);
        vault.initializeController(address(policy));
        chargebackNullifierRegistry.addWritePermission(address(policy));
        policy.setLifecycleHookAuthorization(address(this), true);
        policy.setRiskWindow(METHOD, RISK_WINDOW);
        vm.prank(depositor);
        policy.setChargebackEnabled(address(escrow), depositId, true);
        _stake(taker, STAKE_AMOUNT);
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(IDisputePolicy.ZeroAddress.selector);
        new DisputePolicy(address(0), vault, disputeVerifier, chargebackNullifierRegistry);
    }

    function test_onIntentSignaledLocksStakeAndSnapshotsConfiguration() public {
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.setRiskWindow(METHOD, 7 days);
        assertEq(policy.getRiskWindow(METHOD), 7 days);

        IDisputePolicy.ChargebackIntent memory chargebackIntent = policy.getChargebackIntent(INTENT);
        assertEq(chargebackIntent.taker, taker);
        assertEq(chargebackIntent.stakeOwner, taker);
        assertEq(chargebackIntent.depositor, depositor);
        assertEq(chargebackIntent.riskWindow, RISK_WINDOW);
        assertEq(chargebackIntent.releaseAmount, 0);
        assertEq(uint256(chargebackIntent.status), uint256(IDisputePolicy.ChargebackIntentStatus.PENDING));
        (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(stakeOwner, taker);
        assertEq(amount, INTENT_AMOUNT);
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
        policy.setChargebackEnabled(address(escrow), depositId, false);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.ChargebackNotEnabled.selector, address(escrow), depositId)
        );
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.prank(depositor);
        policy.setChargebackEnabled(address(escrow), depositId, true);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.ChargebackIntentAlreadyExists.selector, INTENT));
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
    }

    function test_onIntentSignaledPassesThroughWindowlessMethodEvenWhenAdmissionsPaused() public {
        bytes32 windowlessMethod = keccak256("windowless");
        uint256 lockedBefore = vault.lockedStake(taker);
        uint256 freeBefore = vault.freeStake(taker);
        policy.setAdmissionsPaused(true);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, windowlessMethod, INTENT_AMOUNT);

        assertEq(
            uint256(policy.getChargebackIntent(INTENT).status), uint256(IDisputePolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);

        policy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
        policy.onIntentCancelled(INTENT);
        assertEq(
            uint256(policy.getChargebackIntent(INTENT).status), uint256(IDisputePolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);
    }

    function test_onIntentSignaledRejectsWrongTokenAndLetsVaultEnforceCollateral() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        ChargebackEscrowMock wrongTokenEscrow = new ChargebackEscrowMock(depositor, otherToken);
        vm.prank(depositor);
        policy.setChargebackEnabled(address(wrongTokenEscrow), depositId, true);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
        policy.onIntentSignaled(INTENT, address(wrongTokenEscrow), depositId, taker, METHOD, INTENT_AMOUNT);

        bytes32 secondIntent = keccak256("second-intent");
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        policy.onIntentSignaled(secondIntent, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);
    }

    function test_DelegatedStakeLocksSelectedOwnersStake() public {
        address stakeOwner = makeAddr("stakeOwner");
        _stake(stakeOwner, STAKE_AMOUNT);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(other, true);
        vm.prank(other);
        vault.selectStakeOwner(stakeOwner);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);

        assertEq(policy.getChargebackIntent(INTENT).stakeOwner, stakeOwner);
        assertEq(vault.lockedStake(stakeOwner), INTENT_AMOUNT);
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancellationUnlocksPendingNoneIsNoOpAndSettledReverts() public {
        policy.onIntentCancelled(keccak256("missing"));
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentCancelled(INTENT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(policy.getChargebackIntent(INTENT).status), uint256(IDisputePolicy.ChargebackIntentStatus.CANCELLED)
        );

        bytes32 settledIntent = keccak256("settled");
        policy.onIntentSignaled(settledIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(settledIntent, INTENT_AMOUNT, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotPending.selector,
                settledIntent,
                IDisputePolicy.ChargebackIntentStatus.SETTLED
            )
        );
        policy.onIntentCancelled(settledIntent);
    }

    function test_SettlementResizesFullAndPartialAndEmitsManualFlag() public {
        policy.onIntentSettled(keccak256("missing"), INTENT_AMOUNT, false);
        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.expectEmit(true, true, true, true);
        emit ChargebackIntentSettled(INTENT, taker, depositor, 40e6, uint64(releaseEligibleAt), true);
        policy.onIntentSettled(INTENT, 40e6, true);

        IDisputePolicy.ChargebackIntent memory chargebackIntent = policy.getChargebackIntent(INTENT);
        assertEq(uint256(chargebackIntent.status), uint256(IDisputePolicy.ChargebackIntentStatus.SETTLED));
        assertEq(chargebackIntent.releaseEligibleAt, releaseEligibleAt);
        assertEq(chargebackIntent.releaseAmount, 40e6);
        (, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(amount, 40e6);
        assertEq(maturesAt, releaseEligibleAt);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotPending.selector,
                INTENT,
                IDisputePolicy.ChargebackIntentStatus.SETTLED
            )
        );
        policy.onIntentSettled(INTENT, 40e6, true);

        bytes32 fullIntent = keccak256("full");
        policy.onIntentSignaled(fullIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(fullIntent, INTENT_AMOUNT, false);
        (, amount,) = vault.locks(fullIntent);
        assertEq(amount, INTENT_AMOUNT);
    }

    function test_ReleaseMaturedChargebackIntentAndBatchFreeStakeAtBoundary() public {
        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(INTENT, 20e6, false);
        _admitAndSettle(secondIntent, 30e6, false);
        uint64 releaseEligibleAt = policy.getChargebackIntent(INTENT).releaseEligibleAt;

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotReleaseEligible.selector,
                releaseEligibleAt,
                uint64(vm.getBlockTimestamp())
            )
        );
        policy.releaseMaturedChargebackIntent(INTENT);

        vm.warp(releaseEligibleAt);
        bytes32[] memory intents = new bytes32[](2);
        intents[0] = INTENT;
        intents[1] = secondIntent;
        policy.releaseMaturedChargebackIntents(intents);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotSettled.selector,
                INTENT,
                IDisputePolicy.ChargebackIntentStatus.RELEASED
            )
        );
        policy.releaseMaturedChargebackIntent(INTENT);
    }

    function test_SubmitChargebackProofPathRequiresBothDirectionBindingAndCreatesClaim() public {
        _admitAndSettle(INTENT, 40e6, false);
        bytes32 paymentId = keccak256("payment");
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier)
        );
        policy.submitChargeback(attestation);

        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        policy.submitChargeback(attestation);

        assertEq(vault.claimable(depositor), 40e6);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.stakeBalance(taker), STAKE_AMOUNT - 40e6);
        assertEq(
            uint256(policy.getChargebackIntent(INTENT).status),
            uint256(IDisputePolicy.ChargebackIntentStatus.CHARGED_BACK)
        );
    }

    function test_SubmitChargebackRequiresSettledIntent() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotSettled.selector, INTENT, IDisputePolicy.ChargebackIntentStatus.NONE
            )
        );
        policy.submitChargeback(attestation);

        policy.onIntentSignaled(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputePolicy.ChargebackIntentNotSettled.selector,
                INTENT,
                IDisputePolicy.ChargebackIntentStatus.PENDING
            )
        );
        policy.submitChargeback(attestation);
    }

    function test_SubmitChargebackRejectsManualReleaseWithoutPaymentBinding() public {
        _admitAndSettle(INTENT, 40e6, true);
        bytes32 paymentId = keccak256("unbound-payment");
        bytes32 disputeId = keccak256("dispute");
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, paymentId, disputeId);

        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier)
        );
        policy.submitChargeback(attestation);
        bytes32 disputeNullifier = keccak256(abi.encodePacked(METHOD, disputeId));
        assertFalse(chargebackNullifierRegistry.isNullified(disputeNullifier));
        assertEq(vault.claimable(depositor), 0);
        assertEq(vault.lockedStake(taker), 40e6);
    }

    function test_SubmitChargebackRejectsInvalidEvidenceButRemainsValidUntilCollateralRelease() public {
        _admitAndSettle(INTENT, 40e6, false);
        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        attestation.dataHash = keccak256("tampered");
        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        policy.submitChargeback(attestation);

        attestation = _attestation(INTENT, keccak256("wrong"), paymentId, keccak256("dispute"));
        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        policy.submitChargeback(attestation);

        attestation = _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        attestationVerifier.setResult(false);
        vm.expectRevert(IDisputeVerifier.AttestationVerificationFailed.selector);
        policy.submitChargeback(attestation);
        attestationVerifier.setResult(true);

        uint64 releaseEligibleAt = policy.getChargebackIntent(INTENT).releaseEligibleAt;
        vm.warp(releaseEligibleAt);
        policy.submitChargeback(attestation);
        assertEq(vault.claimable(depositor), 40e6);
        assertEq(
            uint256(policy.getChargebackIntent(INTENT).status),
            uint256(IDisputePolicy.ChargebackIntentStatus.CHARGED_BACK)
        );
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
        policy.releaseMaturedChargebackIntent(INTENT);
    }

    function test_SetChargebackEnabledEnforcesDepositorAndHandlesMissingDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputePolicy.NotDepositor.selector, address(escrow), depositId, other));
        vm.prank(other);
        policy.setChargebackEnabled(address(escrow), depositId, true);

        uint256 missingDeposit = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(IDisputePolicy.NotDepositor.selector, address(escrow), missingDeposit, address(this))
        );
        policy.setChargebackEnabled(address(escrow), missingDeposit, true);

        vm.prank(depositor);
        policy.setChargebackEnabled(address(escrow), depositId, false);
        assertFalse(policy.isChargebackEnabled(address(escrow), depositId));
    }

    function test_AcceptVaultControllerCompletesDelayedTwoStepHandover() public {
        StakeVault secondVault = new StakeVault(address(this), token, address(0), 1 days);
        DisputePolicy secondPolicy =
            new DisputePolicy(address(this), secondVault, disputeVerifier, chargebackNullifierRegistry);
        secondVault.initializeController(address(this));
        secondVault.proposeController(address(secondPolicy));
        uint256 acceptanceTime = vm.getBlockTimestamp() + secondVault.controllerChangeDelay();
        vm.warp(acceptanceTime);
        secondPolicy.acceptVaultController();
        assertEq(secondVault.controller(), address(secondPolicy));
    }

    function _stake(address stakeOwner, uint256 amount) internal {
        token.transfer(stakeOwner, amount);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
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
