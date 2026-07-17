// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { StakeVault } from "../../contracts/StakeVault.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { ISettlementHook } from "../../contracts/interfaces/ISettlementHook.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract RiskEscrowHarness {
    address public immutable maker;
    IERC20 public immutable token;
    uint256 public intentExpirationPeriod;

    constructor(address _maker, IERC20 _token, uint256 _intentExpirationPeriod) {
        maker = _maker;
        token = _token;
        intentExpirationPeriod = _intentExpirationPeriod;
    }

    function setIntentExpirationPeriod(uint256 _intentExpirationPeriod) external {
        intentExpirationPeriod = _intentExpirationPeriod;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory deposit) {
        deposit.depositor = maker;
        deposit.token = token;
        deposit.acceptingIntents = true;
    }
}

contract RiskOrchestratorHarness {
    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal intents;
    mapping(bytes32 => uint256) internal totalFeeRates;
    mapping(bytes32 => IOrchestratorV3.IntentSettlement) internal settlements;
    mapping(bytes32 => IOrchestratorV3.IntentCancellation) internal cancellations;
    function setIntent(
        bytes32 _intentHash,
        address _taker,
        address _escrow,
        uint256 _amount,
        bytes32 _paymentMethod,
        address _settlementHook
    ) external {
        intents[_intentHash] = IOrchestratorV3.RiskIntentData({
            owner: _taker,
            to: _taker,
            escrow: _escrow,
            depositId: 0,
            amount: _amount,
            paymentMethod: _paymentMethod,
            settlementHook: _settlementHook,
            createdAt: uint64(block.timestamp)
        });
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return intents[_intentHash];
    }

    function setIntentTotalFeeRate(bytes32 _intentHash, uint256 _totalFeeRate) external {
        totalFeeRates[_intentHash] = _totalFeeRate;
    }

    function getIntentTotalFeeRate(bytes32 _intentHash) external view returns (uint256) {
        return totalFeeRates[_intentHash];
    }

    function getIntentSettlement(bytes32 _intentHash) external view returns (uint256, bytes32, uint64) {
        IOrchestratorV3.IntentSettlement memory settlement = settlements[_intentHash];
        return (
            settlement.releasedAmount,
            settlement.paymentId,
            settlement.settledAt
        );
    }

    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64) {
        return cancellations[_intentHash].cancelledAt;
    }

    function createPosition(IIntentRiskHook _manager, bytes32 _intentHash) external returns (bool) {
        return _manager.onIntentCreated(_intentHash);
    }

    function cancelPosition(IIntentRiskHook _manager, bytes32 _intentHash) external {
        _manager.onIntentCancelled(_intentHash);
        delete intents[_intentHash];
    }

    function fulfillPosition(IIntentRiskHook _manager, bytes32 _intentHash, uint256 _amount) external {
        bytes32 paymentId = keccak256(abi.encodePacked("payment", _intentHash));
        _manager.onIntentFulfilled(_intentHash, _amount, paymentId);
        delete intents[_intentHash];
    }

    function recordCancellationWithoutCallback(bytes32 _intentHash, uint64 _cancelledAt) external {
        cancellations[_intentHash] = IOrchestratorV3.IntentCancellation({ cancelledAt: _cancelledAt });
        delete intents[_intentHash];
    }

    function recordSettlementWithoutCallback(bytes32 _intentHash, uint256 _amount, uint64 _settledAt) external {
        bytes32 paymentId = keccak256(abi.encodePacked("payment", _intentHash));
        settlements[_intentHash] = IOrchestratorV3.IntentSettlement({
            releasedAmount: _amount,
            paymentId: paymentId,
            settledAt: _settledAt
        });
        delete intents[_intentHash];
    }
}

contract RiskManagerTest is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");
    uint64 internal constant DAY = 1 days;
    uint64 internal constant MAX_INTENT_PERIOD = 6 hours;
    uint64 internal constant GRIEFING_CLIFF = 15 minutes;
    uint32 internal constant GRIEFING_SLOPE = 10;

    address internal owner = makeAddr("owner");
    address internal taker = makeAddr("taker");
    address internal secondTaker = makeAddr("secondTaker");
    address internal stakeOwner = makeAddr("stakeOwner");
    address internal maker = makeAddr("maker");

    USDCMock internal token;
    StakeVault internal vault;
    RiskManager internal manager;
    RiskOrchestratorHarness internal orchestrator;
    RiskEscrowHarness internal escrow;
    AttestationVerifierMock internal verifier;

    function setUp() public {
        vm.warp(1_000_000);
        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        orchestrator = new RiskOrchestratorHarness();
        escrow = new RiskEscrowHarness(maker, token, MAX_INTENT_PERIOD);
        verifier = new AttestationVerifierMock();
        vault = new StakeVault(owner, token, address(this), 30 days, DAY);
        manager = new RiskManager(
            owner,
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            verifier
        );

        vm.prank(owner);
        vault.proposeController(address(manager));
        vm.warp(block.timestamp + DAY);
        vm.prank(owner);
        manager.acceptVaultController();

        vm.startPrank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, 30 days));
        manager.setPlatformRiskConfig(ZELLE, _nonChargebackableConfig(20e6));
        manager.setDeferredPayoutHook(address(verifier));
        vm.stopPrank();

        deal(address(token), taker, 10_000e6);
        vm.prank(taker);
        token.approve(address(vault), type(uint256).max);
        deal(address(token), stakeOwner, 10_000e6);
        vm.prank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
    }

    function _chargebackConfig(
        uint16 _reserveBps,
        uint64 _riskWindow
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: false,
                reserveBps: _reserveBps,
                riskWindow: _riskWindow
            }),
            griefing: IRiskManager.GriefingConfig({
                griefingCliff: GRIEFING_CLIFF,
                griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
                baseUnbondedAmount: 0
            })
        });
    }

    function _nonChargebackableConfig(
        uint256 _baseUnbondedAmount
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
                griefingCliff: GRIEFING_CLIFF,
                griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
                baseUnbondedAmount: _baseUnbondedAmount
            })
        });
    }

    function _stake(address _staker, uint256 _amount) internal {
        vm.prank(_staker);
        vault.depositStake(_amount);
    }

    function _setIntent(
        bytes32 _intentHash,
        address _taker,
        uint256 _amount,
        bytes32 _paymentMethod,
        address _settlementHook
    ) internal {
        orchestrator.setIntent(
            _intentHash,
            _taker,
            address(escrow),
            _amount,
            _paymentMethod,
            _settlementHook
        );
    }

    function _createPosition(bytes32 _intentHash) internal returns (bool) {
        return orchestrator.createPosition(manager, _intentHash);
    }

    function _enableDeferredPayouts() internal {
        IRiskManager.PlatformRiskConfig memory config = _chargebackConfig(10_000, 30 days);
        config.chargeback.deferredPayoutEnabled = true;
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, config);
    }

    function _fundAndRegisterDeferredPayout(
        bytes32 _intentHash,
        address _beneficiary,
        uint256 _amount
    ) internal {
        assertTrue(token.transfer(address(vault), _amount));
        vm.prank(address(verifier));
        manager.registerDeferredPayout(_intentHash, _beneficiary, _amount);
    }

    function _chargeback(
        bytes32 _intentHash,
        uint256 _disputeNonce
    ) internal view returns (IRiskManager.ChargebackAttestation memory) {
        return IRiskManager.ChargebackAttestation({
            intentHash: _intentHash,
            originalPaymentId: keccak256(abi.encodePacked("payment", _intentHash)),
            disputeId: keccak256(abi.encode(_intentHash, _disputeNonce)),
            signatures: new bytes[](0)
        });
    }

    function test_AdmissionReservesMaximumOfBothCurves() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("max-reservation");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));

        _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.maxGriefingBond, 5.75e6);
        assertEq(position.initialReservation, 1_000e6);
        assertEq(vault.reservedStake(taker), 1_000e6);
    }

    function test_BaseAmountIsUnbondedWithoutReservation() public {
        bytes32 intentHash = keccak256("base-unbonded");
        _setIntent(intentHash, taker, 20e6, ZELLE, address(0));

        _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(position.bondedAmount, 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_BaseAmountIsReusableAfterCancellation() public {
        bytes32 firstIntentHash = keccak256("cancelled-base");
        _setIntent(firstIntentHash, taker, 20e6, ZELLE, address(0));
        _createPosition(firstIntentHash);

        orchestrator.cancelPosition(manager, firstIntentHash);

        bytes32 secondIntentHash = keccak256("reused-base");
        _setIntent(secondIntentHash, taker, 20e6, ZELLE, address(0));
        _createPosition(secondIntentHash);
        assertEq(uint256(manager.getRiskPosition(secondIntentHash).mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_BaseAmountCancellationAfterCliffNeverChargesStake() public {
        bytes32 intentHash = keccak256("cancelled-base-after-cliff");
        _setIntent(intentHash, taker, 20e6, ZELLE, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + 2 hours);

        orchestrator.cancelPosition(manager, intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(position.slashedAmount, 0);
        assertEq(vault.claimableCompensation(maker), 0);
    }

    function test_BaseAmountCancellationReconciliationAfterCliffNeverChargesStake() public {
        bytes32 intentHash = keccak256("reconciled-base-after-cliff");
        _setIntent(intentHash, taker, 20e6, ZELLE, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        orchestrator.recordCancellationWithoutCallback(intentHash, createdAt + 2 hours);

        manager.reconcileCancellation(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(position.slashedAmount, 0);
        assertEq(vault.claimableCompensation(maker), 0);
    }

    function test_AdmissionRejectsIntentTokenUnitMismatch() public {
        USDCMock otherToken = new USDCMock(1e6, "Other Token", "OTHER");
        RiskEscrowHarness otherEscrow = new RiskEscrowHarness(maker, otherToken, MAX_INTENT_PERIOD);
        bytes32 intentHash = keccak256("token-mismatch");
        orchestrator.setIntent(intentHash, taker, address(otherEscrow), 20e6, ZELLE, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.IntentTokenMismatch.selector,
                address(token),
                address(otherToken)
            )
        );
        _createPosition(intentHash);
    }

    function test_PlatformConfigurationRejectsRiskWindowAboveMaximum() public {
        uint64 invalidWindow = manager.MAX_RISK_WINDOW() + 1;
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYPAL));
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, invalidWindow));
    }

    function test_DelegatedTakersShareStakeOwnerReservations() public {
        _stake(stakeOwner, 1_000e6);
        vm.startPrank(stakeOwner);
        vault.setTakerAuthorization(taker, true);
        vault.setTakerAuthorization(secondTaker, true);
        vm.stopPrank();
        bytes32 first = keccak256("delegated-first");
        bytes32 second = keccak256("delegated-second");
        _setIntent(first, taker, 400e6, PAYPAL, address(0));
        _setIntent(second, secondTaker, 600e6, PAYPAL, address(0));

        _createPosition(first);
        _createPosition(second);

        assertEq(manager.getRiskPosition(first).stakeOwner, stakeOwner);
        assertEq(manager.getRiskPosition(second).stakeOwner, stakeOwner);
        assertEq(vault.reservedStake(stakeOwner), 1_000e6);
    }

    function test_CancellationAtCliffChargesZero() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("cliff");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + GRIEFING_CLIFF);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_CancellationAfterTwoHoursChargesLinearPenalty() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("two-hours");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + 2 hours);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.claimableCompensation(maker), 1.75e6);
        assertEq(vault.stakeBalance(taker), 998.25e6);
        assertEq(manager.getRiskPosition(intentHash).slashedAmount, 1.75e6);
    }

    function test_CancellationPenaltyCapsAtSnapshottedIntentPeriod() public {
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("extended");
        _setIntent(intentHash, taker, 1_000e6, ZELLE, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + 2 days);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.claimableCompensation(maker), 5.635e6);
    }

    function test_ReconcileCancellationUsesRecordedTimestamp() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("reconcile-cancel");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        orchestrator.recordCancellationWithoutCallback(intentHash, createdAt + 2 hours);
        vm.warp(createdAt + 3 days);

        manager.reconcileCancellation(intentHash);

        assertEq(vault.claimableCompensation(maker), 1.75e6);
        assertEq(manager.getRiskPosition(intentHash).cancelledAt, createdAt + 2 hours);
    }

    function test_ChargebackSettlementResizesToExactReleasedAmount() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("partial-settlement");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);

        orchestrator.fulfillPosition(manager, intentHash, 600e6);

        assertEq(manager.getRiskPosition(intentHash).reservedAmount, 600e6);
        assertEq(vault.reservedStake(taker), 600e6);
    }

    function test_NonChargebackableSettlementReleasesBond() public {
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("irreversible-settlement");
        _setIntent(intentHash, taker, 1_000e6, ZELLE, address(0));
        _createPosition(intentHash);

        orchestrator.fulfillPosition(manager, intentHash, 1_000e6);

        assertEq(vault.reservedStake(taker), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_ReconcileSettlementUsesRecordedAmountAndTimestamp() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("reconcile-settlement");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 settledAt = uint64(block.timestamp + 1 hours);
        orchestrator.recordSettlementWithoutCallback(intentHash, 700e6, settledAt);
        vm.warp(settledAt + 1 days);

        manager.reconcileSettlement(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.settledAt, settledAt);
        assertEq(position.coverageDeadline, settledAt + 30 days);
        assertEq(position.reservedAmount, 700e6);
    }

    function test_ChargebackCompensatesExactGrossRelease() public {
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("partial-chargeback");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        manager.submitChargeback(_chargeback(intentHash, 1));

        assertEq(vault.claimableCompensation(maker), 500e6);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(manager.getRiskPosition(intentHash).reservedAmount, 0);
    }

    function test_ChargebackRejectsMismatchedPaymentId() public {
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("capped-chargeback");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        IRiskManager.ChargebackAttestation memory attestation = _chargeback(intentHash, 1);
        attestation.originalPaymentId = keccak256("wrong-payment-id");
        vm.expectRevert(IRiskManager.InvalidAttestation.selector);
        manager.submitChargeback(attestation);

        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SETTLED));
    }

    function test_MaturityReleasesRemainingStakeCoverage() public {
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("maturity");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);
        vm.warp(manager.getRiskPosition(intentHash).coverageDeadline);

        manager.releaseMaturedPosition(intentHash);

        assertEq(vault.reservedStake(taker), 0);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
    }

    function test_DeferredAdmissionReservesMaxGriefingBondWhenFeeGapIsZero() public {
        _enableDeferredPayouts();
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));

        bool requiresHook = _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(requiresHook);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.initialReservation, 4.025e6);
        assertEq(vault.reservedStake(taker), 4.025e6);
    }

    function test_DeferredAdmissionReservesFeeGapUpperBoundInsteadOfGrossRelease() public {
        _enableDeferredPayouts();
        _stake(taker, 25e6);
        bytes32 intentHash = keccak256("deferred-hybrid-admission");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);

        bool requiresHook = _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(requiresHook);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.maxGriefingBond, 4.025e6);
        assertEq(position.initialReservation, 21e6);
        assertEq(vault.reservedStake(taker), 21e6);
    }

    function test_CanonicalDeferredHookSelectsHybridModeWithExcessStake() public {
        _enableDeferredPayouts();
        _stake(taker, 700e6);
        bytes32 intentHash = keccak256("deferred-explicit-mode");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);

        bool requiresHook = _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(requiresHook);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.initialReservation, 21e6);
        assertEq(vault.reservedStake(taker), 21e6);
        assertEq(vault.freeStake(taker), 679e6);
    }

    function test_CanonicalDeferredHookSelectionSurvivesReconciliationCapacityIncrease() public {
        _enableDeferredPayouts();
        _stake(taker, 704.025e6);

        bytes32 previousIntent = keccak256("reconciliation-capacity-source");
        _setIntent(previousIntent, taker, 700e6, PAYPAL, address(0));
        _createPosition(previousIntent);
        assertEq(vault.freeStake(taker), 4.025e6);

        bytes32 quotedIntent = keccak256("reconciliation-stable-deferred-selection");
        _setIntent(quotedIntent, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.recordSettlementWithoutCallback(previousIntent, 1e6, uint64(block.timestamp));
        manager.reconcileSettlement(previousIntent);
        assertEq(vault.freeStake(taker), 703.025e6);

        bool requiresHook = _createPosition(quotedIntent);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(quotedIntent);
        assertTrue(requiresHook);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.initialReservation, 4.025e6);
        assertEq(vault.reservedStake(taker), 5.025e6);
    }

    function test_DeferredAdmissionRejectsStakeBelowFeeGapUpperBound() public {
        _enableDeferredPayouts();
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred-hybrid-undercollateralized");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.InsufficientCollateral.selector,
                taker,
                10e6,
                21e6
            )
        );
        _createPosition(intentHash);

        assertEq(vault.reservedStake(taker), 0);
    }

    function test_DeferredRegistrationCannotRequireUnreservedStake() public {
        _enableDeferredPayouts();
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred-shortfall");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 700e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.IncompleteChargebackCoverage.selector,
                354.025e6,
                700e6
            )
        );
        vm.prank(address(verifier));
        manager.registerDeferredPayout(intentHash, taker, 350e6);
    }

    function test_DeferredChargebackSlashesNetProceedsPlusExactFeeGap() public {
        _enableDeferredPayouts();
        _stake(taker, 25e6);
        bytes32 intentHash = keccak256("deferred-hybrid-chargeback");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 700e6);
        _fundAndRegisterDeferredPayout(intentHash, taker, 679e6);

        IRiskManager.RiskPosition memory settled = manager.getRiskPosition(intentHash);
        assertEq(settled.deferredPayoutAmount, 679e6);
        assertEq(settled.reservedAmount, 21e6);
        assertEq(settled.deferredPayoutAmount + settled.reservedAmount, settled.releasedAmount);

        manager.submitChargeback(_chargeback(intentHash, 1));

        IRiskManager.RiskPosition memory slashed = manager.getRiskPosition(intentHash);
        assertEq(vault.claimableCompensation(maker), 700e6);
        assertEq(vault.stakeBalance(taker), 4e6);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(vault.getDeferredPayout(intentHash).amount, 0);
        assertEq(slashed.slashedAmount, 700e6);
        assertEq(slashed.deferredPayoutAmount, 0);
        assertEq(slashed.reservedAmount, 0);
        assertEq(vault.totalLiabilities(), token.balanceOf(address(vault)));
    }

    function test_DeferredMaturityUnlocksFeeGapAndPaysNetProceeds() public {
        _enableDeferredPayouts();
        _stake(taker, 25e6);
        bytes32 intentHash = keccak256("deferred-hybrid-maturity");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 700e6);
        _fundAndRegisterDeferredPayout(intentHash, taker, 679e6);
        uint64 coverageDeadline = manager.getRiskPosition(intentHash).coverageDeadline;
        vm.warp(coverageDeadline);

        manager.releaseMaturedPosition(intentHash);
        uint256 takerBalanceBefore = token.balanceOf(taker);
        vm.prank(taker);
        vault.withdrawDeferredPayout(intentHash, taker);

        assertEq(token.balanceOf(taker) - takerBalanceBefore, 679e6);
        assertEq(vault.stakeBalance(taker), 25e6);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(vault.getDeferredPayout(intentHash).amount, 0);
        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(vault.totalLiabilities(), token.balanceOf(address(vault)));
    }

    function test_DeferredHookRegistrationReconcilesFailedSettlementCallback() public {
        _enableDeferredPayouts();
        _stake(taker, 25e6);
        bytes32 intentHash = keccak256("deferred-hybrid-reconcile");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        orchestrator.setIntentTotalFeeRate(intentHash, 0.03e18);
        _createPosition(intentHash);
        uint64 settledAt = uint64(block.timestamp + 1 hours);
        orchestrator.recordSettlementWithoutCallback(intentHash, 700e6, settledAt);
        vm.warp(settledAt);

        _fundAndRegisterDeferredPayout(intentHash, taker, 679e6);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(position.settledAt, settledAt);
        assertEq(position.deferredPayoutAmount, 679e6);
        assertEq(position.reservedAmount, 21e6);
        assertEq(vault.totalLiabilities(), token.balanceOf(address(vault)));
    }

    function test_DeferredManualReleaseClearsAuthorizationWithoutFunding() public {
        _enableDeferredPayouts();
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred-manual-release");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        _createPosition(intentHash);

        vm.prank(address(orchestrator));
        manager.onIntentReleased(intentHash, 700e6);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        IStakeVault.DeferredPayout memory payout = vault.getDeferredPayout(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(position.paymentId, bytes32(0));
        assertEq(position.reservedAmount, 0);
        assertEq(position.deferredPayoutAmount, 0);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(payout.beneficiary, address(0));
        assertEq(payout.amount, 0);
    }

    function test_PlatformChangesDoNotAlterPositionSnapshots() public {
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, 10 days));
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("snapshot");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);

        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, 30 days));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.chargebackReserveBps, 10_000);
        assertEq(position.riskWindow, 10 days);
        assertEq(position.initialReservation, 500e6);
    }
}
