// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerHarnessFixture} from "../helpers/RiskManagerHarnessFixture.sol";
import {RiskManager} from "contracts/RiskManager.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";

contract RiskManagerHarnessAdmissionTest is RiskManagerHarnessFixture {
    function test_RiskManagerLifecycleRejectsDirectPausedAndMissingIntentCalls() public {
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.onIntentCreated(keccak256("direct"));
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.UnauthorizedOrchestrator.selector, address(this)));
        manager.onIntentCancelled(keccak256("direct-cancel"));

        manager.setAdmissionPaused(true);
        bytes32 pausedIntent = keccak256("paused");
        _setDefaultRiskIntent(pausedIntent);
        vm.expectRevert(IRiskManager.AdmissionPaused.selector);
        orchestrator.createPosition(manager, pausedIntent);
        manager.setAdmissionPaused(false);
        bytes32 missingIntent = keccak256("missing");
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, missingIntent));
        orchestrator.createPosition(manager, missingIntent);
    }

    function test_RiskManagerCreatesUnbondedStakeBackedAndDeferredModes() public {
        bytes32 unbonded = keccak256("unbonded");
        _setRiskIntent(unbonded, 20e6, ZELLE, uint64(block.timestamp), taker, beneficiary);
        orchestrator.createPosition(manager, unbonded);
        assertEq(uint256(manager.getRiskPosition(unbonded).mode), uint256(IRiskManager.RiskMode.UNBONDED));

        bytes32 stakeBacked = keccak256("stake-backed");
        _createPosition(stakeBacked);
        assertEq(uint256(manager.getRiskPosition(stakeBacked).mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));

        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true));
        vault.setTakerState(taker, taker, 1e6, 1e6, false);
        bytes32 deferredIntent = keccak256("deferred");
        _setRiskIntent(deferredIntent, 100e6, PAYPAL, uint64(block.timestamp), taker, taker);
        orchestrator.createPosition(manager, deferredIntent);
        assertEq(uint256(manager.getRiskPosition(deferredIntent).mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        (,,,, bool authorized,) = vault.deferredStakes(deferredIntent);
        assertTrue(authorized);
    }

    function test_RiskManagerAdmissionRejectsDuplicateTokenMismatchInsufficientAndExiting() public {
        bytes32 duplicate = keccak256("duplicate");
        _createPosition(duplicate);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.PositionAlreadyExists.selector, duplicate));
        orchestrator.createPosition(manager, duplicate);

        USDCMock otherToken = new USDCMock(1, "Other", "OTHER");
        escrow.setToken(otherToken);
        bytes32 mismatch = keccak256("mismatch");
        _setDefaultRiskIntent(mismatch);
        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.IntentTokenMismatch.selector, address(token), address(otherToken))
        );
        orchestrator.createPosition(manager, mismatch);
        escrow.setToken(token);

        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 insufficient = keccak256("insufficient");
        _setDefaultRiskIntent(insufficient);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InsufficientCollateral.selector, taker, 0, 100e6));
        orchestrator.createPosition(manager, insufficient);

        vault.setTakerState(taker, taker, 100e6, 100e6, true);
        bytes32 exiting = keccak256("exiting");
        _setDefaultRiskIntent(exiting);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.StakeOwnerExiting.selector, taker, taker));
        orchestrator.createPosition(manager, exiting);
    }

    function test_RiskManagerAdmissionRequiresManagerAsIntentGuardian() public {
        escrow.setIntentGuardian(other);
        bytes32 intentHash = keccak256("wrong-intent-guardian");
        _setDefaultRiskIntent(intentHash);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidIntentGuardian.selector, address(manager), other));
        orchestrator.createPosition(manager, intentHash);
    }

    function test_RiskManagerAdmissionRejectsDisabledPlatform() public {
        IRiskManager.PlatformRiskConfig memory disabledConfig = _nonChargebackConfig();
        disabledConfig.enabled = false;
        manager.setPlatformRiskConfig(ZELLE, disabledConfig);
        bytes32 intentHash = keccak256("disabled-platform");
        _setRiskIntent(intentHash, 100e6, ZELLE, uint64(block.timestamp), taker, beneficiary);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.PlatformDisabled.selector, ZELLE));
        orchestrator.createPosition(manager, intentHash);
    }

    function test_RiskManagerExtensionRejectsMissingOrTerminalPositionAndZeroTime() public {
        bytes32 missingIntent = keccak256("missing-extension-position");
        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.PositionNotPending.selector, missingIntent, IRiskManager.PositionStatus.NONE
            )
        );
        vm.prank(taker);
        manager.extendIntent(missingIntent, HOUR);

        bytes32 pendingIntent = keccak256("zero-extension-time");
        _createPosition(pendingIntent);
        vm.expectRevert(IRiskManager.ZeroAmount.selector);
        vm.prank(taker);
        manager.extendIntent(pendingIntent, 0);
    }

    function test_RiskManagerTakerStateReflectsDelegatedPortfolio() public view {
        (address stakeOwner, uint256 totalStake, uint256 reserved, uint256 free, bool exiting) =
            manager.getTakerState(taker);
        assertEq(stakeOwner, taker);
        assertEq(totalStake, 100_000e6);
        assertEq(reserved, 0);
        assertEq(free, 100_000e6);
        assertFalse(exiting);
    }

    function test_RiskManagerExtensionRejectsEscrowTimestampMismatch() public {
        bytes32 intentHash = keccak256("mutated-escrow-timestamp");
        uint64 createdAt = uint64(block.timestamp);
        _setRiskIntent(intentHash, 100e6, ZELLE, createdAt, taker, beneficiary);
        orchestrator.createPosition(manager, intentHash);
        escrow.setIntentState(intentHash, createdAt + 1, createdAt + PERIOD);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
    }

    function test_RiskManagerExtensionRejectsOrchestratorOwnerDrift() public {
        bytes32 intentHash = keccak256("mutated-orchestrator-owner");
        _createPosition(intentHash);
        _setRiskIntent(intentHash, 100e6, PAYPAL, uint64(block.timestamp), other, beneficiary);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        vm.prank(taker);
        manager.extendIntent(intentHash, HOUR);
    }

    function test_RiskManagerReconcilesCancellationAtOriginalTimestamp() public {
        bytes32 intentHash = keccak256("reconcile-cancel");
        _createPosition(intentHash);
        uint64 cancelledAt = uint64(block.timestamp);
        orchestrator.setIntentCancellation(intentHash, cancelledAt);
        manager.reconcileCancellation(intentHash);
        assertEq(manager.getRiskPosition(intentHash).cancelledAt, cancelledAt);
        assertEq(orchestrator.getIntentCancellation(intentHash), 0);
        vm.expectRevert(IRiskManager.EmptyBatch.selector);
        manager.reconcileCancellations(new bytes32[](0));
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.CancellationNotRecorded.selector, unknown));
        manager.reconcileCancellation(unknown);
    }
}
