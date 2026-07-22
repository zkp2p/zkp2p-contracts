// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerIntegrationFixture} from "../helpers/RiskManagerIntegrationFixture.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {BoundedCall} from "contracts/lib/BoundedCall.sol";

contract RiskManagerAdmissionTest is RiskManagerIntegrationFixture {
    function test_FreeInitialExpiryAdmitsNonChargebackableIntentWithoutStake() public {
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        assertEq(uint256(manager.getRiskPosition(intentHash).mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_FreeInitialExpiryAllowsAnotherIntentAfterCancellation() public {
        bytes32 firstIntent = _signalDefault(taker, 20e6, ZELLE);
        vm.prank(taker);
        orchestrator.cancelIntent(firstIntent);
        bytes32 secondIntent = _signalDefault(taker, 20e6, ZELLE);
        assertEq(uint256(manager.getRiskPosition(secondIntent).mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_FreeInitialExpiryCancellationChargesNoStake() public {
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.warp(block.timestamp + BASE_INTENT_PERIOD - 1);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(position.slashedAmount, 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_FreeInitialExpiryPruningAfterBasePeriodChargesNoStake() public {
        bytes32 intentHash = _signalDefault(taker, 20e6, ZELLE);
        vm.warp(block.timestamp + BASE_INTENT_PERIOD + 1);
        escrow.pruneExpiredIntents(0);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(position.slashedAmount, 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_FreeInitialExpirySnapshotsIntentWithoutExtensionCollateral() public {
        bytes32 intentHash = _signalDefault(taker, 21e6, ZELLE);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.intentAmount, 21e6);
        assertEq(position.extensionReservation, 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_FreeInitialExpirySupportsConcurrentDelegatedTakers() public {
        vault.setTakerAuthorization(taker, true);
        vault.setTakerAuthorization(secondTaker, true);
        bytes32 firstIntent = _signalDefault(taker, 20e6, ZELLE);
        bytes32 secondIntent = _signalDefault(secondTaker, 20e6, ZELLE);
        assertEq(uint256(manager.getRiskPosition(firstIntent).mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(uint256(manager.getRiskPosition(secondIntent).mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(vault.reservedStake(address(this)), 0);
    }

    function test_OrchestratorV3ExposesNoRelayerOrGlobalMultipleIntentPrivilege() public view {
        (bool relayerGetter,) = address(orchestrator).staticcall(abi.encodeWithSignature("relayerRegistry()"));
        (bool relayerSetter,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("setRelayerRegistry(address)", address(this)));
        (bool multipleGetter,) = address(orchestrator).staticcall(abi.encodeWithSignature("allowMultipleIntents()"));
        (bool multipleSetter,) =
            address(orchestrator).staticcall(abi.encodeWithSignature("setAllowMultipleIntents(bool)", true));
        assertFalse(relayerGetter);
        assertFalse(relayerSetter);
        assertFalse(multipleGetter);
        assertFalse(multipleSetter);
    }

    function test_AdmissionUsesDelegatedSafeAsSharedStakeOwner() public {
        token.approve(address(vault), type(uint256).max);
        vault.depositStakeFor(taker, 1_000e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.stakeOwner, address(this));
        assertEq(vault.reservedStake(address(this)), 500e6);
        assertEq(vault.stakeBalance(taker), 0);
    }

    function test_AdmissionAllowsMultipleIntentsWithinSharedFreeStake() public {
        vm.prank(taker);
        vault.depositStake(1_500e6);
        _signalDefault(taker, 500e6, PAYPAL);
        _signalDefault(taker, 500e6, PAYPAL);
        _signalDefault(taker, 500e6, PAYPAL);
        assertEq(vault.reservedStake(taker), 1_500e6);
    }

    function test_AdmissionRejectsOnlyWhenPortfolioExceedsFreeStake() public {
        vm.prank(taker);
        vault.depositStake(999e6);
        _signalDefault(taker, 500e6, PAYPAL);
        vm.expectPartialRevert(BoundedCall.RiskHookAdmissionFailed.selector);
        vm.prank(taker);
        orchestrator.signalIntent(_signalParams(taker, 500e6, PAYPAL));
    }

    function test_AdmissionSnapshotsPlatformPolicyBeforeGovernanceChange() public {
        manager.setPlatformRiskConfig(PAYPAL, _platformConfig(true, false, 10_000, DAY, EXTENSION_SLOPE));
        vm.prank(taker);
        vault.depositStake(500e6);
        bytes32 intentHash = _signalDefault(taker, 500e6, PAYPAL);
        manager.setPlatformRiskConfig(PAYPAL, _platformConfig(true, false, 10_000, 30 * DAY, 20));
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.chargebackReserveBps, 10_000);
        assertEq(position.riskWindow, DAY);
        assertEq(position.extensionPenaltyBpsPerHour, EXTENSION_SLOPE);
    }
}
