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
        vault.setTakerState(taker, taker, 10_000e6, 10_000e6, false);
        token.transfer(address(orchestrator), 10_000e6);

        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(false, 10));
        manager.setPlatformRiskConfig(ZELLE, _nonChargebackConfig(20e6, 10));
    }

    function test_AdmissionHasNoPostIntentHookReturnOrDependency() public {
        bytes32 intentHash = keccak256("stake-backed");
        _setIntent(intentHash, 100e6, PAYPAL);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));
        assertEq(position.initialReservation, 100e6);
    }

    function test_ReusableBaseCreatesUnbondedPosition() public {
        bytes32 intentHash = keccak256("unbonded");
        _setIntent(intentHash, 20e6, ZELLE);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.bondedAmount, 0);
        assertEq(position.reservedAmount, 0);
    }

    function test_DeferredAdmissionDependsOnlyOnPolicyAndCapacity() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 0));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred");
        _setIntent(intentHash, 100e6, PAYPAL);

        orchestrator.createPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        (,,, bool authorized) = vault.deferredPayouts(intentHash);
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
        assertEq(position.coveredAmount, 100e6);
        assertEq(position.reservedAmount, 100e6);
        assertEq(token.balanceOf(address(orchestrator)), balanceBefore);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_DeferredSettlementPullsAndCoversExactExecutableAmount() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 0));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred-settle");
        _create(intentHash, 100e6, PAYPAL);
        uint256 vaultBalanceBefore = token.balanceOf(address(vault));

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 98e6, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.grossReleasedAmount, 100e6);
        assertEq(position.executableAmount, 98e6);
        assertEq(position.coveredAmount, 98e6);
        assertEq(position.deferredPayoutAmount, 98e6);
        assertEq(position.reservedAmount, 98e6);
        assertEq(token.balanceOf(address(vault)) - vaultBalanceBefore, 98e6);
        (, uint256 amount,,) = vault.deferredPayouts(intentHash);
        assertEq(amount, 98e6);
        assertEq(token.allowance(address(orchestrator), address(manager)), 0);
    }

    function test_ManualReleaseUsesTheSameDeferredSettlement() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 0));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("manual-deferred");
        _create(intentHash, 100e6, PAYPAL);

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 99e6, true));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.coveredAmount, 99e6);
        assertEq(position.deferredPayoutAmount, 99e6);
    }

    function test_NonChargebackSettlementReleasesPendingReservation() public {
        bytes32 intentHash = keccak256("ordinary-settle");
        _create(intentHash, 100e6, ZELLE);

        orchestrator.settlePosition(manager, _context(intentHash, 100e6, 100e6, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(position.reservedAmount, 0);
    }

    function test_CancellationReleasesDeferredAuthorization() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 0));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256("deferred-cancel");
        _create(intentHash, 100e6, PAYPAL);

        orchestrator.cancelPosition(manager, intentHash);

        (address payoutBeneficiary,,,) = vault.deferredPayouts(intentHash);
        assertEq(payoutBeneficiary, address(0));
        assertEq(
            uint256(manager.getRiskPosition(intentHash).status),
            uint256(IRiskManager.PositionStatus.CANCELLED)
        );
    }

    function test_ReconcileCancellationUsesRecordedTimestamp() public {
        bytes32 intentHash = keccak256("reconcile");
        _create(intentHash, 100e6, PAYPAL);
        uint64 cancelledAt = uint64(block.timestamp + 1 hours);
        orchestrator.setIntentCancellation(intentHash, cancelledAt);

        manager.reconcileCancellation(intentHash);

        assertEq(manager.getRiskPosition(intentHash).cancelledAt, cancelledAt);
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

    function testFuzz_DeferredCoverageEqualsExecutableAmount(
        uint96 rawGrossAmount,
        uint96 rawFeeAmount,
        bool isManualRelease
    ) public {
        uint256 grossAmount = bound(uint256(rawGrossAmount), 1, 1_000_000e6);
        uint256 feeAmount = bound(uint256(rawFeeAmount), 0, grossAmount - 1);
        uint256 executableAmount = grossAmount - feeAmount;
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true, 0));
        vault.setTakerState(taker, taker, 0, 0, false);
        bytes32 intentHash = keccak256(abi.encode(grossAmount, feeAmount, isManualRelease));
        _create(intentHash, grossAmount, PAYPAL);
        deal(address(token), address(orchestrator), executableAmount);

        orchestrator.settlePosition(
            manager,
            _context(intentHash, grossAmount, executableAmount, isManualRelease)
        );

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.coveredAmount, executableAmount);
        assertEq(position.deferredPayoutAmount, executableAmount);
        assertEq(position.reservedAmount, executableAmount);
    }

    function _create(bytes32 _intentHash, uint256 _amount, bytes32 _paymentMethod) internal {
        _setIntent(_intentHash, _amount, _paymentMethod);
        orchestrator.createPosition(manager, _intentHash);
    }

    function _setIntent(bytes32 _intentHash, uint256 _amount, bytes32 _paymentMethod) internal {
        orchestrator.setRiskIntent(_intentHash, IOrchestratorV3.RiskIntentData({
            owner: taker,
            to: beneficiary,
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
        return IIntentRiskHook.RiskSettlementContext({
            intentHash: _intentHash,
            token: address(token),
            recipient: beneficiary,
            grossAmount: _grossAmount,
            executableAmount: _executableAmount,
            isManualRelease: _isManualRelease
        });
    }

    function _chargebackConfig(
        bool _deferredPayoutEnabled,
        uint32 _griefingSlope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: _deferredPayoutEnabled,
                reserveBps: 10_000,
                riskWindow: RISK_WINDOW
            }),
            griefing: IRiskManager.GriefingConfig({
                griefingCliff: 15 minutes,
                griefingPenaltyBpsPerHour: _griefingSlope,
                baseUnbondedAmount: 0
            })
        });
    }

    function _nonChargebackConfig(
        uint256 _baseUnbondedAmount,
        uint32 _griefingSlope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false,
                deferredPayoutEnabled: false,
                reserveBps: 0,
                riskWindow: 0
            }),
            griefing: IRiskManager.GriefingConfig({
                griefingCliff: 15 minutes,
                griefingPenaltyBpsPerHour: _griefingSlope,
                baseUnbondedAmount: _baseUnbondedAmount
            })
        });
    }
}
