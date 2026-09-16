// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
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

import {PolicyVerifierFixture} from "../helpers/PolicyVerifierFixture.sol";

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

contract DisputeProtectionPolicyTest is PolicyVerifierFixture {
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
    event PolicyAdmissionEnabledUpdated(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bool isDisputeProtectionEnabled
    );

    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant OTHER_METHOD = keccak256("zelle");

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
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), RISK_WINDOW, true);
        NullifierRegistryV2 routePayments = new NullifierRegistryV2(new NullifierRegistry());
        _configurePolicyVerifier(disputeProtectionPolicy, routePayments, attestationVerifier);
        // Isolate collateral accounting from the payment-proof boundary, covered with real signatures in DisputePolicyTest.
        vm.mockCall(
            address(routePayments),
            abi.encodeWithSignature("nullifierByIntentHash(bytes32)"),
            abi.encode(bytes32(uint256(1)))
        );
        _stake(taker, STAKE_AMOUNT);
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(IDisputeProtectionPolicy.ZeroAddress.selector);
        new DisputeProtectionPolicy(address(0), vault, disputeVerifier, disputeNullifierRegistry);
    }

    function test_onIntentSignaledAdmitsByDefaultRejectsOptedOutAndSnapshotsConfiguration() public {
        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.PolicyAdmissionDisabled.selector, address(escrow), depositId, METHOD
            )
        );
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, true);
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        IDisputeProtectionPolicy.PolicyIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getPolicyIntent(INTENT);
        assertEq(disputeProtectionIntent.taker, taker);
        assertEq(disputeProtectionIntent.stakeOwner, taker);
        assertEq(disputeProtectionIntent.depositor, depositor);
        assertEq(disputeProtectionIntent.riskWindow, RISK_WINDOW);
        assertEq(disputeProtectionIntent.releaseAmount, 0);
        assertEq(
            uint256(disputeProtectionIntent.status),
            uint256(IDisputeProtectionPolicy.PolicyIntentStatus.PENDING)
        );
        // Window changes after admission never touch the snapshot or the lock.
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 0, true);
        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).riskWindow, RISK_WINDOW);
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 7 days, true);
        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).riskWindow, RISK_WINDOW);
        (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(stakeOwner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, type(uint64).max);
    }

    function test_onIntentSignaledRejectsUnauthorizedPausedDisabledAndDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, other));
        vm.prank(other);
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        disputeProtectionPolicy.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.setAdmissionsPaused(false);

        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.PolicyAdmissionDisabled.selector, address(escrow), depositId, METHOD
            )
        );
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, true);

        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.DisputeProtectionIntentAlreadyExists.selector, INTENT)
        );
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
    }

    function test_UnconfiguredMethodIsNotRoutedAndDirectAdmissionFails() public {
        bytes32 method = keccak256("unconfigured");
        assertFalse(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, method));
        // The route is checked before reading the policy from the canonical intent's signal data.
        vm.expectRevert("DPP: Payment route changed");
        _admit(INTENT, address(escrow), depositId, taker, method, INTENT_AMOUNT);
        disputeProtectionPolicy.setAdmissionsPaused(true);
        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _admit(INTENT, address(escrow), depositId, taker, method, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), INTENT, INTENT_AMOUNT, false);
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), INTENT);
        assertEq(vault.lockedStake(taker), 0);
    }

    function test_onIntentSignaledRejectsNonStakeTokenDepositByDefault() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        DisputeProtectionEscrowMock wrongTokenEscrow = new DisputeProtectionEscrowMock(depositor, otherToken);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.IntentTokenMismatch.selector, address(token), address(otherToken)
            )
        );
        _admit(INTENT, address(wrongTokenEscrow), depositId, taker, METHOD, INTENT_AMOUNT);

        bytes32 secondIntent = keccak256("second-intent");
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _admit(secondIntent, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);
    }

    function test_DelegatedStakeLocksSelectedOwnersStake() public {
        address stakeOwner = makeAddr("stakeOwner");
        _stake(stakeOwner, STAKE_AMOUNT);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(other, true);
        vm.prank(other);
        vault.selectStakeOwner(stakeOwner);

        _admit(INTENT, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);

        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).stakeOwner, stakeOwner);
        assertEq(vault.lockedStake(stakeOwner), INTENT_AMOUNT);
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancellationUnlocksPendingNoneIsNoOpAndSettledReverts() public {
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), keccak256("missing"));
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), INTENT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getPolicyIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.PolicyIntentStatus.CANCELLED)
        );

        bytes32 settledIntent = keccak256("settled");
        _admit(settledIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), settledIntent, INTENT_AMOUNT, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotPending.selector,
                settledIntent,
                IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED
            )
        );
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), settledIntent);
    }

    function test_SettlementResizesFullAndPartialAndEmitsManualFlag() public {
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), keccak256("missing"), INTENT_AMOUNT, false);
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.expectEmit(true, true, true, true);
        emit DisputeProtectionIntentSettled(INTENT, taker, depositor, 40e6, uint64(releaseEligibleAt), true);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), INTENT, 40e6, true);

        IDisputeProtectionPolicy.PolicyIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getPolicyIntent(INTENT);
        assertEq(
            uint256(disputeProtectionIntent.status),
            uint256(IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED)
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
                IDisputeProtectionPolicy.PolicyIntentStatus.SETTLED
            )
        );
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), INTENT, 40e6, true);

        bytes32 fullIntent = keccak256("full");
        _admit(fullIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), fullIntent, INTENT_AMOUNT, false);
        (, amount,) = vault.locks(fullIntent);
        assertEq(amount, INTENT_AMOUNT);
    }

    function test_SettledIntentKeepsSnapshottedWindowAcrossRiskWindowChanges() public {
        _admitAndSettle(INTENT, INTENT_AMOUNT, false);
        uint64 releaseEligibleAt = disputeProtectionPolicy.getPolicyIntent(INTENT).releaseEligibleAt;
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 0, true);
        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).releaseEligibleAt, releaseEligibleAt);
        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).riskWindow, RISK_WINDOW);
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 90 days, true);
        assertEq(disputeProtectionPolicy.getPolicyIntent(INTENT).releaseEligibleAt, releaseEligibleAt);
    }

    function test_ReleaseMaturedDisputeProtectionIntentAndBatchFreeStakeAtBoundary() public {
        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(INTENT, 20e6, false);
        _admitAndSettle(secondIntent, 30e6, false);
        uint64 releaseEligibleAt = disputeProtectionPolicy.getPolicyIntent(INTENT).releaseEligibleAt;

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
                IDisputeProtectionPolicy.PolicyIntentStatus.RELEASED
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
            uint256(disputeProtectionPolicy.getPolicyIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.PolicyIntentStatus.DISPUTED)
        );
    }

    function test_SubmitDisputeRequiresSettledIntent() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                INTENT,
                IDisputeProtectionPolicy.PolicyIntentStatus.NONE
            )
        );
        disputeProtectionPolicy.submitDispute(attestation);

        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.DisputeProtectionIntentNotSettled.selector,
                INTENT,
                IDisputeProtectionPolicy.PolicyIntentStatus.PENDING
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

        uint64 releaseEligibleAt = disputeProtectionPolicy.getPolicyIntent(INTENT).releaseEligibleAt;
        vm.warp(releaseEligibleAt);
        disputeProtectionPolicy.submitDispute(attestation);
        assertEq(vault.claimable(depositor), 40e6);
        assertEq(
            uint256(disputeProtectionPolicy.getPolicyIntent(INTENT).status),
            uint256(IDisputeProtectionPolicy.PolicyIntentStatus.DISPUTED)
        );
    }

    function test_GovernanceSettersEnforceOwnershipAndValidation() public {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 1 days, true);
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
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), uint64(365 days + 1), true);
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
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), keccak256("old-hook-cancel"));
        vm.prank(newHook);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), keccak256("new-hook-settle"), INTENT_AMOUNT, false);

        vm.expectEmit(true, false, false, true);
        emit LifecycleHookAuthorizationUpdated(address(this), false);
        disputeProtectionPolicy.setLifecycleHookAuthorization(address(this), false);

        assertFalse(disputeProtectionPolicy.isLifecycleHookAuthorized(address(this)));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(this))
        );
        disputeProtectionPolicy.onIntentCancelled(address(orchestrator), INTENT);
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
        _admit(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 overflowingTimestamp = uint256(type(uint64).max) - RISK_WINDOW + 1;
        vm.warp(overflowingTimestamp);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.TimestampOverflow.selector, overflowingTimestamp + RISK_WINDOW
            )
        );
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), INTENT, INTENT_AMOUNT, false);
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

    function test_isDisputeProtectionEnabledDefaultsToRailRiskWindow() public view {
        // METHOD has RISK_WINDOW from setUp; OTHER_METHOD has none.
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));
        assertFalse(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, OTHER_METHOD));
        // The getter validates nothing: a nonexistent deposit reads the rail default too.
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), type(uint256).max, METHOD));
        assertFalse(
            disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), type(uint256).max, OTHER_METHOD)
        );
    }

    function test_SetDisputeProtectionEnabledEnforcesDepositorHandlesMissingDepositAndRoundTrips() public {
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.NotDepositor.selector, address(escrow), depositId, other)
        );
        vm.prank(other);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, true);

        uint256 missingDeposit = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeProtectionPolicy.NotDepositor.selector, address(escrow), missingDeposit, address(this)
            )
        );
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), missingDeposit, METHOD, true);

        vm.expectEmit(true, true, true, true);
        emit PolicyAdmissionEnabledUpdated(address(escrow), depositId, METHOD, false);
        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        assertFalse(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));

        vm.expectEmit(true, true, true, true);
        emit PolicyAdmissionEnabledUpdated(address(escrow), depositId, METHOD, true);
        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, true);
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));

        // The event carries the requested setting; the effective state still follows the risk window.
        vm.expectEmit(true, true, true, true);
        emit PolicyAdmissionEnabledUpdated(address(escrow), depositId, OTHER_METHOD, true);
        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, OTHER_METHOD, true);
        assertFalse(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, OTHER_METHOD));
    }

    function test_PolicyWindowChangesDoNotDisableEnrolledRoutes() public {
        disputeProtectionPolicy.setPolicy(OTHER_METHOD, bytes32(0), RISK_WINDOW, true);
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, OTHER_METHOD));

        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 0, true);
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), RISK_WINDOW, true);
        assertTrue(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));

        vm.prank(depositor);
        disputeProtectionPolicy.setPolicyAdmissionEnabled(address(escrow), depositId, METHOD, false);
        disputeProtectionPolicy.setPolicy(METHOD, bytes32(0), 7 days, true);
        assertFalse(disputeProtectionPolicy.isPolicyAdmissionEnabled(address(escrow), depositId, METHOD));
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

    function _admit(bytes32 hash, address intentEscrow, uint256 id, address buyer, bytes32 method, uint256 amount)
        internal
    {
        disputeProtectionPolicy.onIntentSignaled(IDisputeProtectionPolicy.AdmissionContext({
            intentHash: hash, orchestrator: address(orchestrator), escrow: intentEscrow,
            depositId: id, taker: buyer, paymentMethod: method, amount: amount,
            policyId: bytes32(0), whitelistEnabled: false
        }));
    }

    function _stake(address stakeOwner, uint256 amount) internal {
        token.transfer(stakeOwner, amount);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _admitAndSettle(bytes32 intentHash, uint256 releaseAmount, bool manualRelease) internal {
        _admit(intentHash, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        disputeProtectionPolicy.onIntentSettled(address(orchestrator), intentHash, releaseAmount, manualRelease);
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
