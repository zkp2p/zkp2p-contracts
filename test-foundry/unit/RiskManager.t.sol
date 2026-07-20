// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { StakeVault } from "../../contracts/StakeVault.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
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
    mapping(bytes32 => IOrchestratorV3.IntentSettlement) internal settlements;
    mapping(bytes32 => IOrchestratorV3.IntentCancellation) internal cancellations;

    function setIntent(
        bytes32 _intentHash,
        address _taker,
        address _escrow,
        uint256 _amount,
        bytes32 _paymentMethod,
        address _postIntentHook
    ) external {
        intents[_intentHash] = IOrchestratorV3.RiskIntentData({
            owner: _taker,
            to: _taker,
            escrow: _escrow,
            depositId: 0,
            amount: _amount,
            paymentMethod: _paymentMethod,
            postIntentHook: _postIntentHook,
            createdAt: uint64(block.timestamp)
        });
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return intents[_intentHash];
    }

    function getIntentSettlement(bytes32 _intentHash) external view returns (uint256, uint64) {
        IOrchestratorV3.IntentSettlement memory settlement = settlements[_intentHash];
        return (settlement.releasedAmount, settlement.settledAt);
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

    function extendPosition(
        IRiskManager _manager,
        bytes32 _intentHash,
        uint256 _extensionSeconds,
        uint256 _newExpiry
    ) external returns (uint256) {
        return _manager.onIntentExpiryExtension(_intentHash, _extensionSeconds, _newExpiry);
    }

    function fulfillPosition(IIntentRiskHook _manager, bytes32 _intentHash, uint256 _amount) external {
        _manager.onIntentFulfilled(_intentHash, _amount);
        delete intents[_intentHash];
    }

    function recordCancellationWithoutCallback(bytes32 _intentHash, uint64 _cancelledAt) external {
        cancellations[_intentHash] = IOrchestratorV3.IntentCancellation({ cancelledAt: _cancelledAt });
        delete intents[_intentHash];
    }

    function recordSettlementWithoutCallback(bytes32 _intentHash, uint256 _amount, uint64 _settledAt) external {
        settlements[_intentHash] = IOrchestratorV3.IntentSettlement({
            releasedAmount: _amount,
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
    uint16 internal constant EXTENSION_FEE_BPS = 2_000;
    uint64 internal constant MAX_INTENT_LIFETIME = 5 days;

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
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, 30 days, true));
        manager.setPlatformRiskConfig(ZELLE, _nonChargebackableConfig());
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
        uint64 _riskWindow,
        bool _deferred
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: _deferred,
                reserveBps: _reserveBps,
                riskWindow: _riskWindow
            }),
            extension: IRiskManager.IntentExtensionConfig({
                feeBps: EXTENSION_FEE_BPS,
                maxIntentLifetime: MAX_INTENT_LIFETIME
            })
        });
    }

    function _nonChargebackableConfig() internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false,
                deferredPayoutEnabled: false,
                reserveBps: 0,
                riskWindow: 0
            }),
            extension: IRiskManager.IntentExtensionConfig({
                feeBps: EXTENSION_FEE_BPS,
                maxIntentLifetime: MAX_INTENT_LIFETIME
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
        address _postIntentHook
    ) internal {
        orchestrator.setIntent(
            _intentHash,
            _taker,
            address(escrow),
            _amount,
            _paymentMethod,
            _postIntentHook
        );
    }

    function _createPosition(bytes32 _intentHash) internal returns (bool) {
        return orchestrator.createPosition(manager, _intentHash);
    }

    function _chargeback(
        bytes32 _intentHash,
        uint256 _amount,
        uint256 _nonce
    ) internal view returns (IRiskManager.ChargebackAttestation memory) {
        return IRiskManager.ChargebackAttestation({
            chainId: block.chainid,
            riskManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: _intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: _amount,
            evidenceId: keccak256(abi.encode(_intentHash, _nonce)),
            nonce: _nonce,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
    }

    function test_AdmissionReservesChargebackCoverageOnly() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("max-reservation");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));

        _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.initialReservation, 1_000e6);
        assertEq(vault.reservedStake(taker), 1_000e6);
    }

    function test_NonChargebackableIntentIsUnbondedWithoutReservation() public {
        bytes32 intentHash = keccak256("non-chargebackable-unbonded");
        _setIntent(intentHash, taker, 20e6, ZELLE, address(0));

        _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.UNBONDED));
        assertEq(vault.reservedStake(taker), 0);
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
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, invalidWindow, true));
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

    function test_CancellationReleasesReservationWithoutChargingStake() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("cliff");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + 2 hours);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_CancellationAfterTwoHoursRemainsFree() public {
        _stake(taker, 1_000e6);
        bytes32 intentHash = keccak256("two-hours");
        _setIntent(intentHash, taker, 1_000e6, PAYPAL, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;
        vm.warp(createdAt + 2 hours);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.claimableCompensation(maker), 0);
        assertEq(vault.stakeBalance(taker), 1_000e6);
        assertEq(manager.getRiskPosition(intentHash).slashedAmount, 0);
    }

    function test_ExtensionChargesAnnualizedFeeFromFreeStake() public {
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("extended");
        _setIntent(intentHash, taker, 1_000e6, ZELLE, address(0));
        _createPosition(intentHash);
        uint64 createdAt = manager.getRiskPosition(intentHash).createdAt;

        uint256 fee = orchestrator.extendPosition(
            manager,
            intentHash,
            1 hours,
            createdAt + MAX_INTENT_PERIOD + 1 hours
        );

        assertEq(fee, manager.calculateIntentExtensionFee(1_000e6, EXTENSION_FEE_BPS, 1 hours));
        assertEq(vault.claimableCompensation(maker), fee);
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

        assertEq(vault.claimableCompensation(maker), 0);
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

    function test_NonChargebackableSettlementReleasesPosition() public {
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

    function test_PartialChargebackPreservesRemainingCoverage() public {
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("partial-chargeback");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        manager.submitChargeback(_chargeback(intentHash, 200e6, 1), new bytes[](0), "");

        assertEq(vault.claimableCompensation(maker), 200e6);
        assertEq(vault.reservedStake(taker), 300e6);
        assertEq(manager.getRiskPosition(intentHash).reservedAmount, 300e6);
    }

    function test_ChargebackCapsCompensationAtRemainingCoverage() public {
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("capped-chargeback");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        manager.submitChargeback(_chargeback(intentHash, 900e6, 1), new bytes[](0), "");

        assertEq(vault.claimableCompensation(maker), 500e6);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
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

    function test_DeferredAdmissionDoesNotReserveCancellationBond() public {
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));

        bool requiresHook = _createPosition(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertTrue(requiresHook);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(position.initialReservation, 0);
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_DeferredRegistrationRejectsCoverageBelowConfiguredReserve() public {
        _stake(taker, 10e6);
        bytes32 intentHash = keccak256("deferred-shortfall");
        _setIntent(intentHash, taker, 700e6, PAYPAL, address(verifier));
        _createPosition(intentHash);
        orchestrator.fulfillPosition(manager, intentHash, 700e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IRiskManager.InsufficientDeferredPayoutCoverage.selector,
                350e6,
                700e6
            )
        );
        vm.prank(address(verifier));
        manager.registerDeferredPayout(intentHash, taker, 350e6);
    }

    function test_PlatformChangesDoNotAlterPositionSnapshots() public {
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(5_000, 10 days, false));
        _stake(taker, 500e6);
        bytes32 intentHash = keccak256("snapshot");
        _setIntent(intentHash, taker, 500e6, PAYPAL, address(0));
        _createPosition(intentHash);

        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(10_000, 30 days, false));

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.chargebackReserveBps, 5_000);
        assertEq(position.riskWindow, 10 days);
        assertEq(position.extensionFeeBps, EXTENSION_FEE_BPS);
        assertEq(position.maxIntentLifetime, MAX_INTENT_LIFETIME);
        assertEq(position.initialReservation, 250e6);
    }
}
