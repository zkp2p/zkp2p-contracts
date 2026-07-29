// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IChargebackPolicy} from "contracts/interfaces/IChargebackPolicy.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";

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

contract ChargebackPolicyTest is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    bytes32 internal constant INTENT = keccak256("intent");

    StakeVault internal vault;
    NullifierRegistryV2 internal nullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    ChargebackPolicy internal policy;

    function setUp() public override {
        super.setUp();
        vault = new StakeVault(address(this), token, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        attestationVerifier = new AttestationVerifierMock();
        policy = new ChargebackPolicy(
            address(this), vault, nullifierRegistry, attestationVerifier, escrowRegistry
        );
        vault.initializeController(address(policy));
        policy.setLifecycleHook(address(this));
        policy.setRiskWindow(METHOD, RISK_WINDOW);
        vm.prank(depositor);
        policy.setEnabled(address(escrow), depositId, true);
        _stake(taker, STAKE_AMOUNT);
    }

    function test_AdmitIntentLocksStakeAndSnapshotsConfiguration() public {
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.setRiskWindow(METHOD, 7 days);

        IChargebackPolicy.Position memory position = policy.getPosition(INTENT);
        assertEq(position.taker, taker);
        assertEq(position.stakeOwner, taker);
        assertEq(position.depositor, depositor);
        assertEq(position.riskWindow, RISK_WINDOW);
        assertEq(position.intentAmount, INTENT_AMOUNT);
        assertEq(position.coverageAmount, INTENT_AMOUNT);
        assertEq(uint256(position.status), uint256(IChargebackPolicy.PositionStatus.PENDING));
        (address stakeOwner, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(stakeOwner, taker);
        assertEq(amount, INTENT_AMOUNT);
        assertEq(maturesAt, type(uint64).max);
    }

    function test_AdmitIntentRejectsUnauthorizedPausedDisabledAndDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(IChargebackPolicy.UnauthorizedLifecycleHook.selector, other));
        vm.prank(other);
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);

        policy.setAdmissionsPaused(true);
        vm.expectRevert(IChargebackPolicy.AdmissionsPaused.selector);
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.setAdmissionsPaused(false);

        vm.prank(depositor);
        policy.setEnabled(address(escrow), depositId, false);
        vm.expectRevert(
            abi.encodeWithSelector(IChargebackPolicy.ChargebackNotEnabled.selector, address(escrow), depositId)
        );
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.prank(depositor);
        policy.setEnabled(address(escrow), depositId, true);

        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IChargebackPolicy.PositionAlreadyExists.selector, INTENT));
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
    }

    function test_AdmitIntentPassesThroughWindowlessMethodEvenWhenAdmissionsPaused() public {
        bytes32 windowlessMethod = keccak256("windowless");
        uint256 lockedBefore = vault.lockedStake(taker);
        uint256 freeBefore = vault.freeStake(taker);
        policy.setAdmissionsPaused(true);

        policy.admitIntent(
            INTENT, address(escrow), depositId, taker, windowlessMethod, INTENT_AMOUNT
        );

        assertEq(
            uint256(policy.getPosition(INTENT).status),
            uint256(IChargebackPolicy.PositionStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);

        policy.onIntentSettled(INTENT, INTENT_AMOUNT, false);
        policy.onIntentCancelled(INTENT);
        assertEq(
            uint256(policy.getPosition(INTENT).status),
            uint256(IChargebackPolicy.PositionStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), lockedBefore);
        assertEq(vault.freeStake(taker), freeBefore);
    }

    function test_AdmitIntentRejectsWrongTokenAndInsufficientCollateral() public {
        USDCMock otherToken = new USDCMock(1_000e6, "Other", "OTHER");
        ChargebackEscrowMock wrongTokenEscrow = new ChargebackEscrowMock(depositor, otherToken);
        escrowRegistry.addEscrow(address(wrongTokenEscrow));
        vm.prank(depositor);
        policy.setEnabled(address(wrongTokenEscrow), depositId, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.IntentTokenMismatch.selector, address(token), address(otherToken)
            )
        );
        policy.admitIntent(
            INTENT, address(wrongTokenEscrow), depositId, taker, METHOD, INTENT_AMOUNT
        );

        bytes32 secondIntent = keccak256("second-intent");
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.InsufficientCollateral.selector,
                other,
                uint256(0),
                INTENT_AMOUNT
            )
        );
        policy.admitIntent(secondIntent, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);
    }

    function test_DelegatedStakeLocksSelectedOwnersStake() public {
        address stakeOwner = makeAddr("stakeOwner");
        _stake(stakeOwner, STAKE_AMOUNT);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(other, true);
        vm.prank(other);
        vault.selectStakeOwner(stakeOwner);

        policy.admitIntent(INTENT, address(escrow), depositId, other, METHOD, INTENT_AMOUNT);

        assertEq(policy.getPosition(INTENT).stakeOwner, stakeOwner);
        assertEq(vault.lockedStake(stakeOwner), INTENT_AMOUNT);
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancellationUnlocksPendingNoneIsNoOpAndSettledReverts() public {
        policy.onIntentCancelled(keccak256("missing"));
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentCancelled(INTENT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(policy.getPosition(INTENT).status),
            uint256(IChargebackPolicy.PositionStatus.CANCELLED)
        );

        bytes32 settledIntent = keccak256("settled");
        policy.admitIntent(settledIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(settledIntent, INTENT_AMOUNT, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.PositionNotPending.selector,
                settledIntent,
                IChargebackPolicy.PositionStatus.SETTLED
            )
        );
        policy.onIntentCancelled(settledIntent);
    }

    function test_SettlementResizesFullAndPartialAndSnapshotsDeadlineAndManualFlag() public {
        policy.onIntentSettled(keccak256("missing"), INTENT_AMOUNT, false);
        policy.admitIntent(INTENT, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        uint256 expectedDeadline = vm.getBlockTimestamp() + RISK_WINDOW;
        policy.onIntentSettled(INTENT, 40e6, true);

        IChargebackPolicy.Position memory position = policy.getPosition(INTENT);
        assertEq(position.coverageDeadline, expectedDeadline);
        assertEq(position.coverageAmount, 40e6);
        assertEq(position.grossReleasedAmount, 40e6);
        assertTrue(position.isManualRelease);
        (, uint256 amount, uint64 maturesAt) = vault.locks(INTENT);
        assertEq(amount, 40e6);
        assertEq(maturesAt, expectedDeadline);

        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.PositionNotPending.selector,
                INTENT,
                IChargebackPolicy.PositionStatus.SETTLED
            )
        );
        policy.onIntentSettled(INTENT, 40e6, true);

        bytes32 fullIntent = keccak256("full");
        policy.admitIntent(fullIntent, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(fullIntent, INTENT_AMOUNT, false);
        (, amount,) = vault.locks(fullIntent);
        assertEq(amount, INTENT_AMOUNT);
    }

    function test_ReleaseMaturedPositionAndBatchFreeStakeAtBoundary() public {
        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(INTENT, 20e6, false);
        _admitAndSettle(secondIntent, 30e6, false);
        uint64 deadline = policy.getPosition(INTENT).coverageDeadline;

        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.PositionNotMature.selector,
                deadline,
                uint64(vm.getBlockTimestamp())
            )
        );
        policy.releaseMaturedPosition(INTENT);

        vm.warp(deadline);
        bytes32[] memory intents = new bytes32[](2);
        intents[0] = INTENT;
        intents[1] = secondIntent;
        policy.releaseMaturedPositions(intents);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.PositionNotSettled.selector,
                INTENT,
                IChargebackPolicy.PositionStatus.RELEASED
            )
        );
        policy.releaseMaturedPosition(INTENT);
    }

    function test_SubmitChargebackProofPathRequiresBothDirectionBindingAndCreatesClaim() public {
        _admitAndSettle(INTENT, 40e6, false);
        bytes32 paymentId = keccak256("payment");
        IChargebackPolicy.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));

        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.InvalidPaymentBinding.selector, INTENT, paymentNullifier
            )
        );
        policy.submitChargeback(attestation);

        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        policy.submitChargeback(attestation);

        assertEq(vault.claimable(depositor), 40e6);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.stakeBalance(taker), STAKE_AMOUNT - 40e6);
        assertEq(
            uint256(policy.getPosition(INTENT).status),
            uint256(IChargebackPolicy.PositionStatus.SLASHED)
        );
    }

    function test_SubmitChargebackManualPathSkipsPaymentBindingAndRejectsReplay() public {
        _admitAndSettle(INTENT, 40e6, true);
        bytes32 disputeId = keccak256("dispute");
        IChargebackPolicy.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("unbound-payment"), disputeId);
        policy.submitChargeback(attestation);

        bytes32 disputeNullifier = keccak256(abi.encodePacked(METHOD, disputeId));
        assertTrue(policy.usedChargebackNullifiers(disputeNullifier));

        bytes32 secondIntent = keccak256("second");
        _admitAndSettle(secondIntent, 40e6, true);
        attestation = _attestation(secondIntent, METHOD, keccak256("other-payment"), disputeId);
        vm.expectRevert(
            abi.encodeWithSelector(IChargebackPolicy.ChargebackEvidenceUsed.selector, disputeNullifier)
        );
        policy.submitChargeback(attestation);
    }

    function test_SubmitChargebackRejectsClosedWindowTamperingVerifierFailureAndWrongMethod() public {
        _admitAndSettle(INTENT, 40e6, true);
        IChargebackPolicy.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));
        attestation.dataHash = keccak256("tampered");
        vm.expectRevert(IChargebackPolicy.InvalidAttestation.selector);
        policy.submitChargeback(attestation);

        attestation = _attestation(INTENT, keccak256("wrong"), keccak256("payment"), keccak256("dispute"));
        vm.expectRevert(IChargebackPolicy.InvalidAttestation.selector);
        policy.submitChargeback(attestation);

        attestation = _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));
        attestationVerifier.setResult(false);
        vm.expectRevert(IChargebackPolicy.AttestationVerificationFailed.selector);
        policy.submitChargeback(attestation);
        attestationVerifier.setResult(true);

        uint64 deadline = policy.getPosition(INTENT).coverageDeadline;
        vm.warp(deadline);
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.ChargebackWindowClosed.selector, deadline, deadline
            )
        );
        policy.submitChargeback(attestation);
    }

    function test_GovernanceSettersEnforceOwnershipAndValidation() public {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setRiskWindow(METHOD, 1 days);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setAdmissionsPaused(true);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setAttestationVerifier(address(attestationVerifier));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setLifecycleHook(address(this));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setEscrowRegistry(escrowRegistry);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(IChargebackPolicy.InvalidRiskWindow.selector, uint64(365 days + 1))
        );
        policy.setRiskWindow(METHOD, uint64(365 days + 1));
        vm.expectRevert(IChargebackPolicy.ZeroAddress.selector);
        policy.setAttestationVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(IChargebackPolicy.InvalidContract.selector, other));
        policy.setLifecycleHook(other);
        vm.expectRevert(IChargebackPolicy.OwnershipRenunciationDisabled.selector);
        policy.renounceOwnership();
    }

    function test_SetEnabledEnforcesRegistryDepositAndDepositor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.NotDepositor.selector, address(escrow), depositId, other
            )
        );
        vm.prank(other);
        policy.setEnabled(address(escrow), depositId, true);

        uint256 missingDeposit = type(uint256).max;
        vm.expectRevert(
            abi.encodeWithSelector(
                IChargebackPolicy.DepositNotFound.selector, address(escrow), missingDeposit
            )
        );
        policy.setEnabled(address(escrow), missingDeposit, true);

        EscrowRegistry emptyRegistry = new EscrowRegistry();
        policy.setEscrowRegistry(emptyRegistry);
        vm.expectRevert(
            abi.encodeWithSelector(IChargebackPolicy.EscrowNotWhitelisted.selector, address(escrow))
        );
        vm.prank(depositor);
        policy.setEnabled(address(escrow), depositId, true);
    }

    function test_AcceptVaultControllerCompletesDelayedTwoStepHandover() public {
        StakeVault secondVault = new StakeVault(address(this), token, address(0), 1 days);
        ChargebackPolicy secondPolicy = new ChargebackPolicy(
            address(this), secondVault, nullifierRegistry, attestationVerifier, escrowRegistry
        );
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

    function _admitAndSettle(bytes32 intentHash, uint256 grossAmount, bool manualRelease) internal {
        policy.admitIntent(intentHash, address(escrow), depositId, taker, METHOD, INTENT_AMOUNT);
        policy.onIntentSettled(intentHash, grossAmount, manualRelease);
    }

    function _attestation(
        bytes32 intentHash,
        bytes32 paymentMethod,
        bytes32 paymentId,
        bytes32 disputeId
    ) internal pure returns (IChargebackPolicy.ChargebackAttestation memory attestation) {
        IChargebackPolicy.ChargebackDetails memory details = IChargebackPolicy.ChargebackDetails({
            paymentMethod: paymentMethod,
            originalPaymentId: paymentId,
            disputeId: disputeId,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        attestation = IChargebackPolicy.ChargebackAttestation({
            intentHash: intentHash,
            dataHash: keccak256(data),
            signatures: new bytes[](0),
            data: data
        });
    }
}
