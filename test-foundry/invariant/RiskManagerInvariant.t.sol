// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { StakeVault } from "../../contracts/StakeVault.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { NullifierRegistryV2 } from "../../contracts/registries/NullifierRegistryV2.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract RiskInvariantEscrow {
    uint256 public constant intentExpirationPeriod = 6 hours;
    address public immutable lp;
    IERC20 public immutable token;

    constructor(address _lp, IERC20 _token) {
        lp = _lp;
        token = _token;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory deposit) {
        deposit.depositor = lp;
        deposit.token = token;
        deposit.acceptingIntents = true;
    }
}

contract RiskManagerInvariantHandler is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");

    RiskManager public manager;
    RiskInvariantEscrow public immutable escrow;
    StakeVault public immutable vault;
    IERC20 public immutable token;
    NullifierRegistryV2 public immutable nullifierRegistry;
    address public immutable stakeOwner;
    uint256 public nonce;

    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal intents;
    mapping(bytes32 => uint256) internal totalFeeRates;
    bytes32[] internal intentHashes;

    constructor(
        RiskInvariantEscrow _escrow,
        StakeVault _vault,
        NullifierRegistryV2 _nullifierRegistry,
        address _stakeOwner
    ) {
        escrow = _escrow;
        vault = _vault;
        token = _escrow.token();
        nullifierRegistry = _nullifierRegistry;
        stakeOwner = _stakeOwner;
    }

    function setManager(RiskManager _manager) external {
        require(address(manager) == address(0), "manager already set");
        manager = _manager;
    }

    function create(
        uint96 rawAmount,
        bool chargebackable,
        bool useDeferredPayout,
        uint16 rawFeeBps
    ) external {
        uint256 availableStake = vault.freeStake(stakeOwner);
        uint256 amount;
        uint256 totalFeeRate;
        address settlementHook;

        if (chargebackable && useDeferredPayout) {
            if (availableStake == 0 || availableStake >= 10_000e6) return;
            amount = bound(uint256(rawAmount), availableStake + 1, 10_000e6);
            uint256 feeBps = bound(uint256(rawFeeBps), 0, 500);
            totalFeeRate = feeBps * 1e14;
            uint256 feeGapUpperBound = (amount * totalFeeRate) / 1e18;
            uint256 maxGriefingBond = manager.calculateMaxGriefingBond(
                amount,
                6 hours,
                IRiskManager.GriefingConfig({
                    griefingCliff: 15 minutes,
                    griefingPenaltyBpsPerHour: 10,
                    baseUnbondedAmount: 0
                })
            );
            uint256 hybridReservation = feeGapUpperBound > maxGriefingBond
                ? feeGapUpperBound
                : maxGriefingBond;
            if (hybridReservation > availableStake) return;
            settlementHook = address(this);
        } else if (chargebackable) {
            if (availableStake == 0) return;
            amount = bound(uint256(rawAmount), 1, availableStake < 10_000e6 ? availableStake : 10_000e6);
        } else {
            amount = bound(uint256(rawAmount), 1, 10_000e6);
        }

        bytes32 intentHash = keccak256(
            abi.encode(++nonce, amount, chargebackable, useDeferredPayout, totalFeeRate)
        );
        intents[intentHash] = IOrchestratorV3.RiskIntentData({
            owner: stakeOwner,
            to: stakeOwner,
            escrow: address(escrow),
            depositId: 0,
            amount: amount,
            paymentMethod: chargebackable ? PAYPAL : ZELLE,
            settlementHook: settlementHook,
            createdAt: uint64(block.timestamp)
        });
        totalFeeRates[intentHash] = totalFeeRate;

        try manager.onIntentCreated(intentHash) {
            intentHashes.push(intentHash);
        } catch {
            delete intents[intentHash];
            delete totalFeeRates[intentHash];
        }
    }

    function cancel(uint256 rawIndex, uint32 rawElapsed) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        if (manager.getRiskPosition(intentHash).status != IRiskManager.PositionStatus.PENDING) return;
        vm.warp(block.timestamp + bound(uint256(rawElapsed), 0, 2 days));
        manager.onIntentCancelled(intentHash);
        delete intents[intentHash];
    }

    function settle(uint256 rawIndex, uint96 rawReleasedAmount) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.PENDING) return;
        uint256 releasedAmount = bound(uint256(rawReleasedAmount), 1, position.intentAmount);
        bytes32 paymentId = keccak256(abi.encodePacked("payment", intentHash));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(PAYPAL, paymentId));
        nullifierRegistry.addNullifier(paymentNullifier, intentHash);
        manager.onIntentFulfilled(intentHash, releasedAmount);
        if (position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT) {
            uint256 feeGap = (releasedAmount * totalFeeRates[intentHash]) / 1e18;
            uint256 deferredCoverage = releasedAmount - feeGap;
            require(token.transfer(address(vault), deferredCoverage), "deferred transfer failed");
            manager.registerDeferredPayout(intentHash, stakeOwner, deferredCoverage);
        }
        delete intents[intentHash];
    }

    function chargeback(uint256 rawIndex) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.SETTLED) return;
        bytes32 paymentId = keccak256(abi.encodePacked("payment", intentHash));
        bytes memory data = abi.encode(IRiskManager.ChargebackDetails({
            paymentMethod: PAYPAL,
            originalPaymentId: paymentId,
            disputeId: keccak256(abi.encode("dispute", intentHash, ++nonce)),
            paymentAmount: position.releasedAmount,
            paymentCurrency: keccak256("USD")
        }));
        manager.submitChargeback(IRiskManager.ChargebackAttestation({
            intentHash: intentHash,
            dataHash: keccak256(data),
            signatures: new bytes[](0),
            data: data,
            metadata: ""
        }));
    }

    function mature(uint256 rawIndex) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.SETTLED) return;
        if (block.timestamp < position.coverageDeadline) vm.warp(position.coverageDeadline);
        manager.releaseMaturedPosition(intentHash);
        IStakeVault.DeferredPayout memory payout = vault.getDeferredPayout(intentHash);
        if (payout.amount != 0) {
            vm.prank(stakeOwner);
            vault.withdrawDeferredPayout(intentHash, stakeOwner);
        }
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return intents[_intentHash];
    }

    function getIntentTotalFeeRate(bytes32 _intentHash) external view returns (uint256) {
        return totalFeeRates[_intentHash];
    }

    function getIntentSettlement(bytes32) external pure returns (uint256, uint64, bool) {
        return (0, 0, false);
    }

    function getIntentCancellation(bytes32) external pure returns (uint64) {
        return 0;
    }

    function hashCount() external view returns (uint256) {
        return intentHashes.length;
    }

    function hashAt(uint256 _index) external view returns (bytes32) {
        return intentHashes[_index];
    }
}

contract RiskManagerInvariantTest is StdInvariant, Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");

    address internal stakeOwner = makeAddr("stakeOwner");
    address internal lp = makeAddr("lp");

    USDCMock internal token;
    StakeVault internal vault;
    RiskManager internal manager;
    RiskManagerInvariantHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        token = new USDCMock(2_000_000e6, "USD Coin", "USDC");
        RiskInvariantEscrow escrow = new RiskInvariantEscrow(lp, token);
        vault = new StakeVault(address(this), token, address(0), 30 days, 1 days);
        NullifierRegistry legacyNullifierRegistry = new NullifierRegistry();
        NullifierRegistryV2 nullifierRegistry = new NullifierRegistryV2(legacyNullifierRegistry);
        handler = new RiskManagerInvariantHandler(escrow, vault, nullifierRegistry, stakeOwner);
        nullifierRegistry.addWritePermission(address(handler));
        AttestationVerifierMock verifier = new AttestationVerifierMock();
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(handler)),
            IStakeVault(address(vault)),
            verifier,
            nullifierRegistry
        );
        handler.setManager(manager);
        vault.initializeController(address(manager));

        IRiskManager.GriefingConfig memory griefing = IRiskManager.GriefingConfig({
            griefingCliff: 15 minutes,
            griefingPenaltyBpsPerHour: 10,
            baseUnbondedAmount: 0
        });
        manager.setPlatformRiskConfig(PAYPAL, IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: true,
                reserveBps: 10_000,
                riskWindow: 30 days
            }),
            griefing: griefing
        }));
        manager.setDeferredPayoutHook(address(handler));
        griefing.baseUnbondedAmount = 20e6;
        manager.setPlatformRiskConfig(ZELLE, IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false,
                deferredPayoutEnabled: false,
                reserveBps: 0,
                riskWindow: 0
            }),
            griefing: griefing
        }));

        deal(address(token), stakeOwner, 1_000e6);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
        vault.depositStake(1_000e6);
        vm.stopPrank();
        deal(address(token), address(handler), 2_000_000e6);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = RiskManagerInvariantHandler.create.selector;
        selectors[1] = RiskManagerInvariantHandler.cancel.selector;
        selectors[2] = RiskManagerInvariantHandler.settle.selector;
        selectors[3] = RiskManagerInvariantHandler.chargeback.selector;
        selectors[4] = RiskManagerInvariantHandler.mature.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    function invariant_PortfolioReservationsNeverExceedStake() public view {
        assertLe(vault.reservedStake(stakeOwner), vault.stakeBalance(stakeOwner));
        assertEq(vault.freeStake(stakeOwner) + vault.reservedStake(stakeOwner), vault.eligibleStake(stakeOwner));
    }

    function invariant_PositionReservationsEqualVaultPortfolioReservation() public view {
        uint256 positionReservations;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(handler.hashAt(index));
            if (
                (
                    position.mode == IRiskManager.RiskMode.STAKE_BACKED
                        || position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                )
                    && (
                        position.status == IRiskManager.PositionStatus.PENDING
                            || position.status == IRiskManager.PositionStatus.SETTLED
                    )
            ) {
                positionReservations += position.reservedAmount;
            }
        }
        assertEq(positionReservations, vault.reservedStake(stakeOwner));
    }

    function invariant_UnbondedPositionsNeverReserveOrSlashStake() public view {
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(handler.hashAt(index));
            if (position.mode == IRiskManager.RiskMode.UNBONDED) {
                assertEq(position.initialReservation, 0);
                assertEq(position.reservedAmount, 0);
                assertEq(position.slashedAmount, 0);
            }
        }
    }

    function invariant_DeferredSettlementAlwaysHasExactGrossCoverage() public view {
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(handler.hashAt(index));
            if (
                position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                    && position.status == IRiskManager.PositionStatus.SETTLED
            ) {
                assertEq(
                    position.deferredPayoutAmount + position.reservedAmount,
                    position.releasedAmount
                );
            }
            if (
                position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                    && position.status == IRiskManager.PositionStatus.SLASHED
            ) {
                assertEq(position.deferredPayoutAmount, 0);
                assertEq(position.reservedAmount, 0);
                assertEq(position.slashedAmount, position.releasedAmount);
            }
            if (
                position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                    && position.status == IRiskManager.PositionStatus.RELEASED
            ) {
                assertEq(position.reservedAmount, 0);
            }
        }
    }

    function invariant_VaultAccountingRemainsSolvent() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }
}
