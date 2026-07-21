// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { INullifierRegistryV2 } from "../../contracts/interfaces/INullifierRegistryV2.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";
import {
    RiskManagerEscrowHarness,
    RiskManagerOrchestratorHarness,
    RiskManagerVaultHarness
} from "../../contracts/mocks/RiskManagerHarnessMocks.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { NullifierRegistryV2 } from "../../contracts/registries/NullifierRegistryV2.sol";

contract RiskManagerTest is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");
    uint64 internal constant INTENT_PERIOD = 6 hours;
    uint64 internal constant RISK_WINDOW = 30 days;

    address internal taker = makeAddr("taker");
    address internal maker = makeAddr("maker");
    address internal beneficiary = makeAddr("beneficiary");

    USDCMock internal token;
    RiskManagerOrchestratorHarness internal orchestrator;
    RiskManagerVaultHarness internal vault;
    RiskManagerEscrowHarness internal escrow;
    RiskManager internal manager;

    function setUp() public {
        vm.warp(1_000_000);
        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        orchestrator = new RiskManagerOrchestratorHarness();
        vault = new RiskManagerVaultHarness();
        escrow = new RiskManagerEscrowHarness(INTENT_PERIOD, maker);
        AttestationVerifierMock verifier = new AttestationVerifierMock();
        NullifierRegistry legacyRegistry = new NullifierRegistry();
        NullifierRegistryV2 registry = new NullifierRegistryV2(legacyRegistry);

        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            verifier,
            INullifierRegistryV2(address(registry))
        );
        vault.setStakeToken(token);
        escrow.setToken(token);
        escrow.setIntentGuardian(address(manager));
        vault.setTakerState(taker, taker, 10_000e6, 10_000e6, false);
        token.transfer(address(orchestrator), 10_000e6);

        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(false, 10));
        manager.setPlatformRiskConfig(ZELLE, _nonChargebackConfig(10));
    }

    function test_AdmissionHasNoPostIntentHookReturnOrDependency() public {
        bytes32 intentHash = keccak256("stake-backed");
        _setIntent(intentHash, 100e6, PAYPAL);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));
        assertEq(position.initialReservation, 100e6);
    }

    function test_NonChargebackableAdmissionCreatesUnbondedPosition() public {
        bytes32 intentHash = keccak256("unbonded");
        _setIntent(intentHash, 20e6, ZELLE);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.reservedAmount, 0);
    }

    function test_DeferredAdmissionDependsOnlyOnPolicyAndCapacity() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 10));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred");
        _setIntent(intentHash, 100e6, PAYPAL);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        (address deferredStaker,,,, bool authorized,) = vault.deferredStakes(intentHash);
        assertEq(deferredStaker, taker);
        assertTrue(authorized);
    }

    function test_StakeBackedSettlementCoversGrossAndConsumesZero() public {
        bytes32 intentHash = keccak256("stake-settle");
        _create(intentHash, 100e6, PAYPAL);
        uint256 balanceBefore = token.balanceOf(address(orchestrator));

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 98e6, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 98e6);
        assertEq(position.reservedAmount, 100e6);
        assertEq(token.balanceOf(address(orchestrator)), balanceBefore);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_DeferredSettlementPullsAndCoversGrossWithContingentFees() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 10));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred-settle");
        _create(intentHash, 100e6, PAYPAL);
        uint256 vaultBalanceBefore = token.balanceOf(address(vault));

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 98e6, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 98e6);
        assertEq(position.reservedAmount, 100e6);
        assertEq(token.balanceOf(address(vault)) - vaultBalanceBefore, 100e6);
        (, uint256 grossAmount, uint256 feeAmount,,,) = vault.deferredStakes(intentHash);
        assertEq(grossAmount, 100e6);
        assertEq(feeAmount, 2e6);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_ManualReleaseUsesTheSameDeferredSettlement() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 10));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("manual-deferred");
        _create(intentHash, 100e6, PAYPAL);

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 99e6, true));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.grossReleasedAmount - position.executableAmount, 1e6);
    }

    function test_NonChargebackSettlementChargesAndReleasesExtensionReservation() public {
        bytes32 intentHash = keccak256("ordinary-settle");
        _create(intentHash, 100e6, ZELLE);

        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);
        vm.warp(manager.getRiskPosition(intentHash).baseIntentExpiry + 1 hours);

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 100e6, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(position.reservedAmount, 0);
        assertEq(position.extensionReservation, 0);
        assertEq(position.extensionPenalty, 100_000);
        assertEq(vault.claimableCompensation(maker), 100_000);
    }

    function test_ExtensionReservationIsIsolatedFromChargebackAndChargedOnCancellation() public {
        bytes32 intentHash = keccak256("isolated-extension-cancel");
        _create(intentHash, 100e6, PAYPAL);

        bytes32 extensionId = manager.extensionReservationId(intentHash);
        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);

        (, uint256 chargebackReservation,) = vault.reservations(intentHash);
        (, uint256 extensionReservation,) = vault.reservations(extensionId);
        assertEq(chargebackReservation, 100e6);
        assertEq(extensionReservation, 200_000);
        assertTrue(extensionId != intentHash);

        IRiskManager.RiskPosition memory beforeCancel = manager.getRiskPosition(intentHash);
        vm.warp(beforeCancel.baseIntentExpiry + 1 hours);
        orchestrator.cancelPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.extensionPenalty, 100_000);
        assertEq(position.extensionReservation, 0);
        assertEq(position.reservedAmount, 0);
        assertEq(vault.claimableCompensation(maker), 100_000);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(vault.freeStake(taker), 10_000e6 - 100_000);
    }

    function test_SettlementChargesTheSameElapsedExtensionPenaltyAsCancellation() public {
        bytes32 cancelledHash = keccak256("extension-cancel-parity");
        bytes32 settledHash = keccak256("extension-settle-parity");
        _create(cancelledHash, 100e6, ZELLE);
        _create(settledHash, 100e6, ZELLE);

        vm.startPrank(taker);
        manager.extendIntent(cancelledHash, 2 hours);
        manager.extendIntent(settledHash, 2 hours);
        vm.stopPrank();

        uint64 terminalAt = manager.getRiskPosition(cancelledHash).baseIntentExpiry + 1 hours;
        vm.warp(terminalAt);
        orchestrator.cancelPosition(manager, cancelledHash);
        orchestrator.settlePosition(manager, _context(settledHash, 100e6, 100e6, false));

        IRiskManager.RiskPosition memory cancelled = manager.getRiskPosition(cancelledHash);
        IRiskManager.RiskPosition memory settled = manager.getRiskPosition(settledHash);
        assertEq(cancelled.extensionPenalty, 100_000);
        assertEq(settled.extensionPenalty, cancelled.extensionPenalty);
        assertEq(cancelled.extensionReservation, 0);
        assertEq(settled.extensionReservation, 0);
        assertEq(vault.claimableCompensation(maker), 200_000);
    }

    function test_SponsorSuppliesNewStakeWithoutUsingTakerFreeStake() public {
        bytes32 intentHash = keccak256("sponsored-extension");
        _create(intentHash, 100e6, ZELLE);
        uint256 freeStakeBefore = vault.freeStake(taker);
        uint256 stakeBefore = vault.stakeBalance(taker);

        token.transfer(beneficiary, 1e6);
        vm.startPrank(beneficiary);
        token.approve(address(vault), type(uint256).max);
        manager.stakeAndExtendIntent(intentHash, 2 hours);
        vm.stopPrank();

        uint256 extensionCost = 200_000;
        (, uint256 reservation,) = vault.reservations(manager.extensionReservationId(intentHash));
        assertEq(reservation, extensionCost);
        assertEq(vault.stakeBalance(taker), stakeBefore + extensionCost);
        assertEq(vault.freeStake(taker), freeStakeBefore);

        vm.warp(manager.getRiskPosition(intentHash).baseIntentExpiry + 1 hours);
        orchestrator.cancelPosition(manager, intentHash);

        assertEq(manager.getRiskPosition(intentHash).extensionPenalty, 100_000);
        assertEq(vault.stakeBalance(taker), stakeBefore + 100_000);
        assertEq(vault.freeStake(taker), freeStakeBefore + 100_000);
        assertEq(vault.claimableCompensation(maker), 100_000);
    }

    function test_CancellationReleasesDeferredAuthorization() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 10));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred-cancel");
        _create(intentHash, 100e6, PAYPAL);

        orchestrator.cancelPosition(manager, intentHash);

        (address deferredStaker,,,,,) = vault.deferredStakes(intentHash);
        assertEq(deferredStaker, address(0));
        assertEq(
            uint256(manager.getRiskPosition(intentHash).status),
            uint256(IRiskManager.PositionStatus.CANCELLED)
        );
    }

    function test_ReconcileCancellationUsesRecordedTimestamp() public {
        bytes32 intentHash = keccak256("reconcile");
        _create(intentHash, 100e6, PAYPAL);

        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);
        uint64 cancelledAt = manager.getRiskPosition(intentHash).baseIntentExpiry + 1 hours;
        orchestrator.setIntentCancellation(intentHash, cancelledAt);

        vm.warp(cancelledAt + 1 days);

        manager.reconcileCancellation(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.cancelledAt, cancelledAt);
        assertEq(position.extensionPenalty, 100_000);
        assertEq(vault.claimableCompensation(maker), 100_000);
    }

    function test_SettlementRejectsTokenRecipientAndAmountMismatch() public {
        bytes32 intentHash = keccak256("invalid-settle");
        _create(intentHash, 100e6, PAYPAL);

        USDCMock otherToken = new USDCMock(1, "Other", "OTHER");
        IIntentRiskHook.RiskSettlementContext memory context = _context(intentHash, 100e6, 98e6, false);
        context.token = address(otherToken);
        vm.expectRevert(abi.encodeWithSelector(
            IRiskManager.IntentTokenMismatch.selector,
            address(token),
            address(otherToken)
        ));
        orchestrator.settlePosition(manager, context);

        context = _context(intentHash, 100e6, 0, false);
        vm.expectRevert(abi.encodeWithSelector(
            IRiskManager.InvalidSettlementAmounts.selector,
            100e6,
            0
        ));
        orchestrator.settlePosition(manager, context);

        context = _context(intentHash, 100e6, 98e6, false);
        context.recipient = maker;
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        orchestrator.settlePosition(manager, context);
    }

    function test_OnlyOrchestratorCanAdmitCancelOrSettle() public {
        bytes32 intentHash = keccak256("unauthorized");
        vm.expectRevert(abi.encodeWithSelector(
            IRiskManager.UnauthorizedOrchestrator.selector,
            address(this)
        ));
        manager.onIntentCreated(intentHash);
        vm.expectRevert(abi.encodeWithSelector(
            IRiskManager.UnauthorizedOrchestrator.selector,
            address(this)
        ));
        manager.onIntentCancelled(intentHash);
        vm.expectRevert(abi.encodeWithSelector(
            IRiskManager.UnauthorizedOrchestrator.selector,
            address(this)
        ));
        manager.settleIntent(_context(intentHash, 1, 1, false));
    }

    function testFuzz_DeferredCoverageEqualsGrossAndTracksFees(
        uint96 rawGrossAmount,
        uint96 rawFeeAmount,
        bool isManualRelease
    ) public {
        uint256 grossAmount = bound(uint256(rawGrossAmount), 1, 1_000_000e6);
        uint256 feeAmount = bound(uint256(rawFeeAmount), 0, grossAmount - 1);
        uint256 executableAmount = grossAmount - feeAmount;
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 10));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256(abi.encode(grossAmount, feeAmount, isManualRelease));
        _create(intentHash, grossAmount, PAYPAL);
        deal(address(token), address(orchestrator), grossAmount);

        orchestrator.settlePosition(
            manager,
            _context(intentHash, grossAmount, executableAmount, isManualRelease)
        );

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, grossAmount);
        assertEq(position.grossReleasedAmount - position.executableAmount, feeAmount);
        assertEq(position.reservedAmount, grossAmount);
    }

    function _create(bytes32 _intentHash, uint256 _amount, bytes32 _paymentMethod) internal {
        _setIntent(_intentHash, _amount, _paymentMethod);
        orchestrator.createPosition(manager, _intentHash);
        escrow.setIntent(_intentHash, block.timestamp);
    }

    function _setIntent(bytes32 _intentHash, uint256 _amount, bytes32 _paymentMethod) internal {
        orchestrator.setRiskIntent(_intentHash, IOrchestratorV3.RiskIntentData({
            owner: taker,
            to: taker,
            escrow: address(escrow),
            depositId: 0,
            amount: _amount,
            paymentMethod: _paymentMethod,
            createdAt: uint64(block.timestamp)
        }));
    }

    function _context(
        bytes32 _intentHash,
        uint256 _grossAmount,
        uint256 _executableAmount,
        bool _isManualRelease
    ) internal view returns (IIntentRiskHook.RiskSettlementContext memory) {
        uint256 feeAmount = _grossAmount - _executableAmount;
        IIntentRiskHook.FeeAllocation[] memory feeAllocations = new IIntentRiskHook.FeeAllocation[](
            feeAmount == 0 ? 0 : 1
        );
        if (feeAmount != 0) {
            feeAllocations[0] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.PROTOCOL,
                recipient: beneficiary,
                amount: feeAmount
            });
        }
        return IIntentRiskHook.RiskSettlementContext({
            intentHash: _intentHash,
            token: address(token),
            recipient: taker,
            grossAmount: _grossAmount,
            executableAmount: _executableAmount,
            feeAllocations: feeAllocations,
            isManualRelease: _isManualRelease
        });
    }

    function _chargebackConfig(
        bool _deferredPayoutEnabled,
        uint32 _extensionSlope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: _deferredPayoutEnabled,
                reserveBps: 10_000,
                riskWindow: RISK_WINDOW
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({
                extensionPenaltyBpsPerHour: _extensionSlope
            })
        });
    }

    function _nonChargebackConfig(
        uint32 _extensionSlope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false,
                deferredPayoutEnabled: false,
                reserveBps: 0,
                riskWindow: 0
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({
                extensionPenaltyBpsPerHour: _extensionSlope
            })
        });
    }
}
