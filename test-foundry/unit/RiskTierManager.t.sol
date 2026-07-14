// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskTierManager } from "../../contracts/RiskTierManager.sol";
import { StakeVault } from "../../contracts/StakeVault.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IEscrow } from "../../contracts/interfaces/IEscrow.sol";
import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
import { IRiskTierManager } from "../../contracts/interfaces/IRiskTierManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract RiskEscrowHarness {
    address public immutable maker;
    IERC20 public immutable token;

    constructor(address _maker, IERC20 _token) {
        maker = _maker;
        token = _token;
    }

    function getDeposit(uint256) external view returns (IEscrow.Deposit memory deposit) {
        deposit.depositor = maker;
        deposit.token = token;
        deposit.acceptingIntents = true;
    }
}

contract RiskOrchestratorHarness {
    mapping(bytes32 => IOrchestratorV2.Intent) internal intents;
    mapping(address => bytes32[]) internal accountIntents;
    mapping(bytes32 => uint256) internal settlementAmounts;
    mapping(bytes32 => uint64) internal settlementTimestamps;

    function setIntent(
        bytes32 _intentHash,
        address _taker,
        address _escrow,
        uint256 _amount,
        bytes32 _paymentMethod,
        IPostIntentHookV2 _postIntentHook
    ) external {
        IOrchestratorV2.Intent storage intent = intents[_intentHash];
        intent.owner = _taker;
        intent.to = _taker;
        intent.escrow = _escrow;
        intent.depositId = 0;
        intent.amount = _amount;
        intent.timestamp = block.timestamp;
        intent.paymentMethod = _paymentMethod;
        intent.fiatCurrency = keccak256("USD");
        intent.conversionRate = 1e18;
        intent.postIntentHook = _postIntentHook;
        accountIntents[_taker].push(_intentHash);
    }

    function clearIntent(bytes32 _intentHash) external {
        delete intents[_intentHash];
    }

    function getIntent(bytes32 _intentHash) external view returns (IOrchestratorV2.Intent memory) {
        return intents[_intentHash];
    }

    function getAccountIntents(address _account) external view returns (bytes32[] memory) {
        return accountIntents[_account];
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory data) {
        IOrchestratorV2.Intent storage intent = intents[_intentHash];
        data = IOrchestratorV3.RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            postIntentHook: address(intent.postIntentHook)
        });
    }

    function getAccountIntentCount(address _account) external view returns (uint256) {
        return accountIntents[_account].length;
    }

    function getIntentSettlement(bytes32 _intentHash) external view returns (uint256, uint64) {
        return (settlementAmounts[_intentHash], settlementTimestamps[_intentHash]);
    }

    function createPosition(IIntentRiskHook _manager, bytes32 _intentHash) external returns (bool) {
        return _manager.onIntentCreated(_intentHash);
    }

    function cancelPosition(IIntentRiskHook _manager, bytes32 _intentHash) external {
        _manager.onIntentCancelled(_intentHash);
    }

    function fulfillPosition(IIntentRiskHook _manager, bytes32 _intentHash, uint256 _amount) external {
        _manager.onIntentFulfilled(_intentHash, _amount);
    }

    function recordSettlementWithoutCallback(bytes32 _intentHash, uint256 _amount) external {
        settlementAmounts[_intentHash] = _amount;
        settlementTimestamps[_intentHash] = uint64(block.timestamp);
        delete intents[_intentHash];
    }
}

contract RiskTierManagerTest is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    uint64 internal constant DAY = 1 days;

    address internal owner = makeAddr("owner");
    address internal taker = makeAddr("taker");
    address internal secondTaker = makeAddr("secondTaker");
    address internal stakeOwner = makeAddr("stakeOwner");
    address internal maker = makeAddr("maker");

    USDCMock internal token;
    StakeVault internal vault;
    RiskTierManager internal manager;
    RiskOrchestratorHarness internal orchestrator;
    RiskEscrowHarness internal escrow;
    AttestationVerifierMock internal verifier;

    function setUp() public {
        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        orchestrator = new RiskOrchestratorHarness();
        escrow = new RiskEscrowHarness(maker, token);
        verifier = new AttestationVerifierMock();
        vault = new StakeVault(owner, token, address(this), 30 days, DAY);

        uint256[4] memory thresholds = [uint256(100e6), uint256(500e6), uint256(1_000e6), uint256(5_000e6)];
        uint256[5] memory concurrency = [uint256(1), uint256(2), uint256(5), uint256(10), uint256(100)];
        manager = new RiskTierManager(
            owner,
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            verifier,
            thresholds,
            concurrency,
            DAY,
            DAY
        );

        vm.prank(owner);
        vault.proposeController(address(manager));
        vm.warp(block.timestamp + DAY);
        vm.prank(owner);
        manager.acceptVaultController();

        IRiskTierManager.PlatformRiskConfig memory config = IRiskTierManager.PlatformRiskConfig({
            enabled: true,
            chargebackable: true,
            deferredPayoutEnabled: false,
            reserveBps: 10_000,
            riskWindow: 30 days,
            tierCaps: [uint256(0), uint256(0), uint256(750e6), uint256(1_875e6), uint256(3_750e6)]
        });
        vm.prank(owner);
        manager.setPlatformRiskConfig(PAYPAL, config);

        deal(address(token), taker, 10_000e6);
        vm.prank(taker);
        token.approve(address(vault), type(uint256).max);
        deal(address(token), stakeOwner, 10_000e6);
        vm.prank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
    }

    function _stake(uint256 _amount) internal {
        vm.prank(taker);
        vault.depositStake(_amount);
    }

    function _createPosition(bytes32 _intentHash, uint256 _amount) internal {
        _createPositionFor(taker, _intentHash, _amount);
    }

    function _createPositionFor(address _taker, bytes32 _intentHash, uint256 _amount) internal {
        orchestrator.setIntent(
            _intentHash,
            _taker,
            address(escrow),
            _amount,
            PAYPAL,
            IPostIntentHookV2(address(0))
        );
        orchestrator.createPosition(manager, _intentHash);
    }

    function test_TierBoundaries() public view {
        assertEq(uint256(manager.getTierForStake(0)), uint256(IRiskTierManager.Tier.PEASANT));
        assertEq(uint256(manager.getTierForStake(100e6)), uint256(IRiskTierManager.Tier.PEER));
        assertEq(uint256(manager.getTierForStake(500e6)), uint256(IRiskTierManager.Tier.PLUS));
        assertEq(uint256(manager.getTierForStake(1_000e6)), uint256(IRiskTierManager.Tier.PRO));
        assertEq(uint256(manager.getTierForStake(5_000e6)), uint256(IRiskTierManager.Tier.PLATINUM));
    }

    function test_ChargebackableAdmissionReservesFreeStake() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");

        _createPosition(intentHash, 500e6);

        assertEq(vault.reservedStake(taker), 500e6);
        assertEq(uint256(manager.getRiskPosition(intentHash).mode), uint256(IRiskTierManager.RiskMode.STAKE_BACKED));
    }

    function test_DelegatedAdmissionUsesStakeOwnerBalance() public {
        vm.prank(stakeOwner);
        vault.depositStakeFor(taker, 1_000e6);
        bytes32 intentHash = keccak256("delegated-intent");

        _createPosition(intentHash, 500e6);

        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.taker, taker);
        assertEq(position.stakeOwner, stakeOwner);
        assertEq(vault.reservedStake(stakeOwner), 500e6);
        assertEq(vault.stakeBalance(taker), 0);
    }

    function test_DelegatedTakersShareStakeOwnerConcurrency() public {
        vm.prank(stakeOwner);
        vault.depositStakeFor(taker, 1_000e6);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(secondTaker, true);
        uint256[5] memory oneIntentPerTier = [uint256(1), uint256(1), uint256(1), uint256(1), uint256(1)];
        vm.prank(owner);
        manager.setConcurrencyLimits(oneIntentPerTier);
        bytes32 firstIntent = keccak256("first-delegated-intent");
        bytes32 secondIntent = keccak256("second-delegated-intent");
        _createPositionFor(taker, firstIntent, 100e6);
        orchestrator.setIntent(
            secondIntent,
            secondTaker,
            address(escrow),
            100e6,
            PAYPAL,
            IPostIntentHookV2(address(0))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskTierManager.ConcurrentIntentLimitReached.selector,
                stakeOwner,
                1,
                1
            )
        );
        orchestrator.createPosition(manager, secondIntent);

        orchestrator.cancelPosition(manager, firstIntent);
        orchestrator.createPosition(manager, secondIntent);
        assertEq(manager.activeIntentCount(stakeOwner), 1);
    }

    function test_DelegatedPositionKeepsSnapshottedOwnerAfterRevocationAndSlash() public {
        vm.prank(stakeOwner);
        vault.depositStakeFor(taker, 1_000e6);
        bytes32 intentHash = keccak256("revoked-delegated-intent");
        _createPosition(intentHash, 500e6);
        vm.prank(stakeOwner);
        vault.setTakerAuthorization(taker, false);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        IRiskTierManager.ChargebackAttestation memory attestation = IRiskTierManager.ChargebackAttestation({
            chainId: block.chainid,
            riskTierManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: 200e6,
            evidenceId: keccak256("delegated-evidence"),
            nonce: 77,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
        bytes[] memory signatures = new bytes[](0);

        manager.submitChargeback(attestation, signatures, "");

        assertEq(manager.getRiskPosition(intentHash).stakeOwner, stakeOwner);
        assertEq(vault.stakeBalance(stakeOwner), 800e6);
        assertEq(vault.stakeBalance(taker), 0);
    }

    function test_PendingStakeWithdrawalReducesDelegatedTakerTier() public {
        vm.prank(stakeOwner);
        vault.depositStakeFor(taker, 1_000e6);
        vm.prank(stakeOwner);
        vault.requestStakeWithdrawal(600e6);

        assertEq(uint256(manager.getTier(taker)), uint256(IRiskTierManager.Tier.PEER));
        (
            IRiskTierManager.Tier tier,
            uint256 totalStake,
            uint256 reserved,
            uint256 free,
            bool exiting,
            uint256 activeIntents
        ) = manager.getTakerState(taker);
        assertEq(uint256(tier), uint256(IRiskTierManager.Tier.PEER));
        assertEq(totalStake, 1_000e6);
        assertEq(reserved, 0);
        assertEq(free, 400e6);
        assertFalse(exiting);
        assertEq(activeIntents, 0);
    }

    function test_CancellationReleasesReservation() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);

        orchestrator.cancelPosition(manager, intentHash);

        assertEq(vault.reservedStake(taker), 0);
        assertEq(
            uint256(manager.getRiskPosition(intentHash).status),
            uint256(IRiskTierManager.PositionStatus.CANCELLED)
        );
    }

    function test_PartialFulfillmentReducesReservation() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);

        orchestrator.fulfillPosition(manager, intentHash, 200e6);

        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.releasedAmount, 200e6);
        assertEq(position.reservedAmount, 200e6);
        assertEq(vault.reservedStake(taker), 200e6);
    }

    function test_ReconcileSettlementRecoversMissedTerminalCallback() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        orchestrator.recordSettlementWithoutCallback(intentHash, 300e6);

        manager.reconcileSettlement(intentHash);

        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.releasedAmount, 300e6);
        assertEq(position.reservedAmount, 300e6);
        assertEq(vault.getReservation(intentHash).amount, 300e6);
    }

    function test_BatchReconcileSettlementsRecoversMultipleCallbacks() public {
        _stake(1_000e6);
        bytes32 firstIntent = keccak256("first-intent");
        bytes32 secondIntent = keccak256("second-intent");
        _createPosition(firstIntent, 300e6);
        _createPosition(secondIntent, 300e6);
        orchestrator.recordSettlementWithoutCallback(firstIntent, 200e6);
        orchestrator.recordSettlementWithoutCallback(secondIntent, 250e6);
        bytes32[] memory intentHashes = new bytes32[](2);
        intentHashes[0] = firstIntent;
        intentHashes[1] = secondIntent;

        manager.reconcileSettlements(intentHashes);

        assertEq(manager.getRiskPosition(firstIntent).releasedAmount, 200e6);
        assertEq(manager.getRiskPosition(secondIntent).releasedAmount, 250e6);
        assertEq(vault.reservedStake(taker), 450e6);
        assertEq(manager.activeIntentCount(taker), 0);
    }

    function test_BatchReleaseMaturedPositionsReleasesEveryReservation() public {
        _stake(1_000e6);
        bytes32 firstIntent = keccak256("first-intent");
        bytes32 secondIntent = keccak256("second-intent");
        _createPosition(firstIntent, 200e6);
        _createPosition(secondIntent, 200e6);
        orchestrator.fulfillPosition(manager, firstIntent, 200e6);
        orchestrator.fulfillPosition(manager, secondIntent, 200e6);
        uint64 releaseTime = manager.getRiskPosition(firstIntent).releaseTime;
        vm.warp(releaseTime);
        bytes32[] memory intentHashes = new bytes32[](2);
        intentHashes[0] = firstIntent;
        intentHashes[1] = secondIntent;

        manager.releaseMaturedPositions(intentHashes);

        assertEq(uint256(manager.getRiskPosition(firstIntent).status), uint256(IRiskTierManager.PositionStatus.RELEASED));
        assertEq(uint256(manager.getRiskPosition(secondIntent).status), uint256(IRiskTierManager.PositionStatus.RELEASED));
        assertEq(vault.reservedStake(taker), 0);
    }

    function test_ChargebackSlashesBoundedAmount() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        IRiskTierManager.ChargebackAttestation memory attestation = IRiskTierManager.ChargebackAttestation({
            chainId: block.chainid,
            riskTierManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: 200e6,
            evidenceId: keccak256("evidence"),
            nonce: 1,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
        bytes[] memory signatures = new bytes[](0);

        manager.submitChargeback(attestation, signatures, "");

        assertEq(vault.stakeBalance(taker), 800e6);
        assertEq(vault.claimableCompensation(maker), 200e6);
        assertEq(vault.reservedStake(taker), 300e6);
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskTierManager.PositionStatus.ACTIVE));
        assertEq(manager.getRiskPosition(intentHash).slashedAmount, 200e6);
    }

    function test_CumulativeChargebacksConsumeOnlyRemainingCoverage() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);
        bytes[] memory signatures = new bytes[](0);

        IRiskTierManager.ChargebackAttestation memory firstClaim = IRiskTierManager.ChargebackAttestation({
            chainId: block.chainid,
            riskTierManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: 200e6,
            evidenceId: keccak256("evidence-1"),
            nonce: 10,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
        manager.submitChargeback(firstClaim, signatures, "");
        firstClaim.chargebackAmount = 300e6;
        firstClaim.evidenceId = keccak256("evidence-2");
        firstClaim.nonce = 11;
        manager.submitChargeback(firstClaim, signatures, "");

        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.slashedAmount, 500e6);
        assertEq(position.reservedAmount, 0);
        assertEq(uint256(position.status), uint256(IRiskTierManager.PositionStatus.SLASHED));
        assertEq(vault.claimableCompensation(maker), 500e6);
    }

    function test_FallbackReleaseRejectsLiveIntentAndLateSettlementRemainsCovered() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        uint64 fallbackReleaseTime = manager.getRiskPosition(intentHash).releaseTime;
        vm.warp(fallbackReleaseTime);

        vm.expectRevert(abi.encodeWithSelector(RiskTierManager.PositionNotSettled.selector, intentHash));
        manager.releaseMaturedPosition(intentHash);

        orchestrator.fulfillPosition(manager, intentHash, 500e6);
        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertGt(position.releaseTime, fallbackReleaseTime);
        assertEq(vault.reservedStake(taker), 500e6);
    }

    function test_FallbackReleaseRechecksMaturityAfterReconcilingLateSettlement() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        uint64 fallbackReleaseTime = manager.getRiskPosition(intentHash).releaseTime;
        vm.warp(fallbackReleaseTime);
        orchestrator.recordSettlementWithoutCallback(intentHash, 500e6);
        uint64 exactReleaseTime = uint64(block.timestamp + 31 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskTierManager.PositionNotMature.selector,
                exactReleaseTime,
                uint64(block.timestamp)
            )
        );
        manager.releaseMaturedPosition(intentHash);

        assertEq(vault.reservedStake(taker), 500e6);
    }

    function test_FallbackReleaseAllowsPrunedCancellationOnlyAfterMaturity() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        uint64 fallbackReleaseTime = manager.getRiskPosition(intentHash).releaseTime;
        orchestrator.clearIntent(intentHash);

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskTierManager.PositionNotMature.selector,
                fallbackReleaseTime,
                uint64(block.timestamp)
            )
        );
        manager.releaseMaturedPosition(intentHash);

        vm.warp(fallbackReleaseTime);
        manager.releaseMaturedPosition(intentHash);
        assertEq(vault.reservedStake(taker), 0);
        assertEq(
            uint256(manager.getRiskPosition(intentHash).status),
            uint256(IRiskTierManager.PositionStatus.RELEASED)
        );
    }

    function test_SettlementUsesSnapshottedBuffer() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        vm.prank(owner);
        manager.setTimingConfig(DAY, 3 * DAY);

        orchestrator.fulfillPosition(manager, intentHash, 500e6);

        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(position.settlementBuffer, DAY);
        assertEq(position.releaseTime - position.slashDeadline, DAY);
    }

    function test_ChargebackRejectedBeforeSettlement() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);

        IRiskTierManager.ChargebackAttestation memory attestation = IRiskTierManager.ChargebackAttestation({
            chainId: block.chainid,
            riskTierManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: 200e6,
            evidenceId: keccak256("evidence"),
            nonce: 3,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
        bytes[] memory signatures = new bytes[](0);

        vm.expectRevert(abi.encodeWithSelector(RiskTierManager.PositionNotSettled.selector, intentHash));
        manager.submitChargeback(attestation, signatures, "");

        assertEq(vault.stakeBalance(taker), 1_000e6);
    }

    function test_ChargebackRejectedAtDeadline() public {
        _stake(1_000e6);
        bytes32 intentHash = keccak256("intent");
        _createPosition(intentHash, 500e6);
        orchestrator.fulfillPosition(manager, intentHash, 500e6);
        IRiskTierManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        vm.warp(position.slashDeadline);

        IRiskTierManager.ChargebackAttestation memory attestation = IRiskTierManager.ChargebackAttestation({
            chainId: block.chainid,
            riskTierManager: address(manager),
            orchestrator: address(orchestrator),
            intentHash: intentHash,
            paymentMethod: PAYPAL,
            chargebackAmount: 1e6,
            evidenceId: keccak256("evidence"),
            nonce: 2,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + DAY)
        });
        bytes[] memory signatures = new bytes[](0);

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskTierManager.ChargebackWindowClosed.selector,
                position.slashDeadline,
                uint64(block.timestamp)
            )
        );
        manager.submitChargeback(attestation, signatures, "");
    }

    function test_ExitBlocksAdmission() public {
        _stake(500e6);
        vm.prank(taker);
        vault.requestExit();
        bytes32 intentHash = keccak256("intent");
        orchestrator.setIntent(
            intentHash,
            taker,
            address(escrow),
            100e6,
            PAYPAL,
            IPostIntentHookV2(address(0))
        );

        vm.expectRevert(abi.encodeWithSelector(RiskTierManager.StakeOwnerExiting.selector, taker, taker));
        orchestrator.createPosition(manager, intentHash);
    }
}
