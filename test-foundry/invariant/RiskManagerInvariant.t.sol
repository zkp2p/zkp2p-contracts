// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RiskManager } from "../../contracts/RiskManager.sol";
import { StakeVault } from "../../contracts/StakeVault.sol";
import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "../../contracts/interfaces/IIntentRiskHook.sol";
import { IOrchestratorV3 } from "../../contracts/interfaces/IOrchestratorV3.sol";
import { INullifierRegistryV2 } from "../../contracts/interfaces/INullifierRegistryV2.sol";
import { IRiskManager } from "../../contracts/interfaces/IRiskManager.sol";
import { IStakeVault } from "../../contracts/interfaces/IStakeVault.sol";
import { AttestationVerifierMock } from "../../contracts/mocks/AttestationVerifierMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";
import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { NullifierRegistryV2 } from "../../contracts/registries/NullifierRegistryV2.sol";

contract RiskInvariantEscrow {
    uint256 public constant intentExpirationPeriod = 6 hours;
    address public immutable lp;
    IERC20 public immutable token;
    address public intentGuardian;
    mapping(bytes32 => IEscrowV2.Intent) internal intents;

    constructor(address _lp, IERC20 _token) {
        lp = _lp;
        token = _token;
    }

    function setIntentGuardian(address _intentGuardian) external {
        require(intentGuardian == address(0), "guardian already set");
        intentGuardian = _intentGuardian;
    }

    function recordIntent(bytes32 _intentHash, uint64 _createdAt) external {
        intents[_intentHash] = IEscrowV2.Intent({
            intentHash: _intentHash,
            amount: 0,
            timestamp: _createdAt,
            expiryTime: uint256(_createdAt) + intentExpirationPeriod
        });
    }

    function getDepositIntent(uint256, bytes32 _intentHash) external view returns (IEscrowV2.Intent memory) {
        return intents[_intentHash];
    }

    function extendIntentExpiry(uint256, bytes32 _intentHash, uint256 _additionalTime) external {
        require(msg.sender == intentGuardian, "not guardian");
        require(
            intents[_intentHash].expiryTime + _additionalTime
                <= intents[_intentHash].timestamp + 5 days,
            "intent lifetime exceeded"
        );
        intents[_intentHash].expiryTime += _additionalTime;
    }

    function getDeposit(uint256) external view returns (IEscrowV2.Deposit memory deposit) {
        deposit.depositor = lp;
        deposit.token = token;
        deposit.acceptingIntents = true;
        deposit.intentGuardian = intentGuardian;
    }
}

contract RiskManagerInvariantHandler is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant ZELLE = keccak256("zelle");
    address internal constant FEE_RECIPIENT = address(0xFEE);

    RiskManager public manager;
    RiskInvariantEscrow public immutable escrow;
    address public immutable stakeOwner;
    address public immutable delegatedTaker;
    uint256 public nonce;

    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal intents;
    bytes32[] internal intentHashes;

    constructor(RiskInvariantEscrow _escrow, address _stakeOwner, address _delegatedTaker) {
        escrow = _escrow;
        stakeOwner = _stakeOwner;
        delegatedTaker = _delegatedTaker;
    }

    function setManager(RiskManager _manager) external {
        require(address(manager) == address(0), "manager already set");
        manager = _manager;
        escrow.token().approve(address(_manager), type(uint256).max);
        escrow.token().approve(address(_manager.stakeVault()), type(uint256).max);
        escrow.setIntentGuardian(address(_manager));
    }

    function create(uint96 rawAmount, bool chargebackable, bool deferred) external {
        uint256 amount = bound(uint256(rawAmount), 1, 10_000e6);
        uint256 intentNonce = ++nonce;
        bytes32 intentHash = keccak256(abi.encode(intentNonce, amount, chargebackable, deferred));
        address intentOwner = deferred
            ? address(this)
            : (intentNonce % 2 == 0 ? stakeOwner : delegatedTaker);
        intents[intentHash] = IOrchestratorV3.RiskIntentData({
            owner: intentOwner,
            to: intentOwner,
            escrow: address(escrow),
            depositId: 0,
            amount: amount,
            paymentMethod: chargebackable || deferred ? PAYPAL : ZELLE,
            createdAt: uint64(block.timestamp)
        });

        try manager.onIntentCreated(intentHash) {
            intentHashes.push(intentHash);
            escrow.recordIntent(intentHash, uint64(block.timestamp));
        } catch {
            delete intents[intentHash];
        }
    }

    function extend(uint256 rawIndex, uint32 rawAdditionalTime, bool ownerCalls) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory beforeExtension = manager.getRiskPosition(intentHash);
        if (beforeExtension.status != IRiskManager.PositionStatus.PENDING) return;
        uint256 currentExpiry = uint256(beforeExtension.baseIntentExpiry) + beforeExtension.totalExtensionTime;
        if (block.timestamp >= currentExpiry) return;

        uint256 initialPeriod = beforeExtension.baseIntentExpiry - beforeExtension.createdAt;
        if (initialPeriod >= manager.MAX_TOTAL_INTENT_LIFETIME()) return;
        uint256 remainingTime = manager.MAX_TOTAL_INTENT_LIFETIME()
            - initialPeriod
            - beforeExtension.totalExtensionTime;
        if (remainingTime == 0) return;
        uint64 additionalTime = uint64(bound(uint256(rawAdditionalTime), 1, remainingTime));

        address extensionStakeOwner = beforeExtension.extensionStakeOwner;
        if (extensionStakeOwner == address(0)) {
            extensionStakeOwner = manager.stakeVault().stakeOwnerOf(beforeExtension.taker);
        }
        vm.prank(ownerCalls ? extensionStakeOwner : beforeExtension.taker);
        try manager.extendIntent(intentHash, additionalTime) { } catch { }
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
        IOrchestratorV3.RiskIntentData memory intent = intents[intentHash];
        uint256 feeAmount = releasedAmount / 100;
        IIntentRiskHook.FeeAllocation[] memory feeAllocations =
            new IIntentRiskHook.FeeAllocation[](feeAmount == 0 ? 0 : 1);
        if (feeAmount != 0) {
            feeAllocations[0] = IIntentRiskHook.FeeAllocation({
                feeType: IIntentRiskHook.FeeType.PROTOCOL,
                recipient: FEE_RECIPIENT,
                amount: feeAmount
            });
        }
        manager.settleIntent(IIntentRiskHook.RiskSettlementContext({
            intentHash: intentHash,
            token: address(escrow.token()),
            recipient: intent.to,
            grossAmount: releasedAmount,
            executableAmount: releasedAmount - feeAmount,
            isManualRelease: false,
            feeAllocations: feeAllocations
        }));
        delete intents[intentHash];
    }

    function mature(uint256 rawIndex) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.SETTLED) return;
        if (block.timestamp < position.coverageDeadline) vm.warp(position.coverageDeadline);

        manager.releaseMaturedPosition(intentHash);
    }

    function chargeback(uint256 rawIndex) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[rawIndex % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (
            position.status != IRiskManager.PositionStatus.SETTLED
                || block.timestamp >= position.coverageDeadline
        ) return;

        bytes32 originalPaymentId = keccak256(abi.encode(intentHash, "payment"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(position.paymentMethod, originalPaymentId));
        INullifierRegistryV2 registry = manager.nullifierRegistry();
        if (registry.nullifierByIntentHash(intentHash) == bytes32(0)) {
            registry.addNullifier(paymentNullifier, intentHash);
        }

        IRiskManager.ChargebackDetails memory details = IRiskManager.ChargebackDetails({
            paymentMethod: position.paymentMethod,
            originalPaymentId: originalPaymentId,
            disputeId: keccak256(abi.encode(intentHash, "dispute")),
            paymentAmount: position.grossReleasedAmount,
            paymentCurrency: keccak256("USD")
        });
        bytes memory data = abi.encode(details);
        bytes[] memory signatures = new bytes[](0);
        manager.submitChargeback(IRiskManager.ChargebackAttestation({
            intentHash: intentHash,
            dataHash: keccak256(data),
            signatures: signatures,
            data: data,
            metadata: ""
        }));

        IStakeVault vault = manager.stakeVault();
        vm.prank(escrow.lp());
        vault.withdrawCompensation(escrow.lp());
    }

    function getRiskIntent(bytes32 _intentHash) external view returns (IOrchestratorV3.RiskIntentData memory) {
        return intents[_intentHash];
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
    address internal delegatedTaker = makeAddr("delegatedTaker");
    address internal lp = makeAddr("lp");

    USDCMock internal token;
    StakeVault internal vault;
    RiskManager internal manager;
    RiskManagerInvariantHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        token = new USDCMock(2_000_000e6, "USD Coin", "USDC");
        RiskInvariantEscrow escrow = new RiskInvariantEscrow(lp, token);
        handler = new RiskManagerInvariantHandler(escrow, stakeOwner, delegatedTaker);
        AttestationVerifierMock verifier = new AttestationVerifierMock();
        NullifierRegistry legacyRegistry = new NullifierRegistry();
        NullifierRegistryV2 nullifierRegistry = new NullifierRegistryV2(legacyRegistry);
        vault = new StakeVault(address(this), token, address(0), 30 days, 1 days);
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(handler)),
            IStakeVault(address(vault)),
            verifier,
            nullifierRegistry
        );
        handler.setManager(manager);
        nullifierRegistry.addWritePermission(address(handler));
        vault.initializeController(address(manager));

        IRiskManager.IntentExtensionConfig memory intentExtension = IRiskManager.IntentExtensionConfig({
            extensionPenaltyBpsPerHour: 10
        });
        manager.setPlatformRiskConfig(PAYPAL, IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: true,
                deferredPayoutEnabled: true,
                reserveBps: 10_000,
                riskWindow: 30 days
            }),
            intentExtension: intentExtension
        }));
        manager.setPlatformRiskConfig(ZELLE, IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: false,
                deferredPayoutEnabled: false,
                reserveBps: 0,
                riskWindow: 0
            }),
            intentExtension: intentExtension
        }));

        deal(address(token), stakeOwner, 1_000_000e6);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
        vault.depositStake(1_000_000e6);
        vault.setTakerAuthorization(delegatedTaker, true);
        vm.stopPrank();
        deal(address(token), address(handler), 100_000_000e6);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = RiskManagerInvariantHandler.create.selector;
        selectors[1] = RiskManagerInvariantHandler.extend.selector;
        selectors[2] = RiskManagerInvariantHandler.cancel.selector;
        selectors[3] = RiskManagerInvariantHandler.settle.selector;
        selectors[4] = RiskManagerInvariantHandler.mature.selector;
        selectors[5] = RiskManagerInvariantHandler.chargeback.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    function invariant_PortfolioReservationsNeverExceedStake() public view {
        assertLe(vault.reservedStake(stakeOwner), vault.stakeBalance(stakeOwner));
        assertEq(vault.freeStake(stakeOwner) + vault.reservedStake(stakeOwner), vault.eligibleStake(stakeOwner));
        assertLe(vault.reservedStake(address(handler)), vault.stakeBalance(address(handler)));
        assertEq(
            vault.freeStake(address(handler)) + vault.reservedStake(address(handler)),
            vault.eligibleStake(address(handler))
        );
    }

    function invariant_PositionReservationsEqualVaultPortfolioReservation() public view {
        uint256 stakeOwnerReservations;
        uint256 handlerReservations;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            bytes32 intentHash = handler.hashAt(index);
            IStakeVault.Reservation memory mainReservation = vault.getReservation(intentHash);
            IStakeVault.Reservation memory extensionReservation =
                vault.getReservation(manager.extensionReservationId(intentHash));
            if (mainReservation.active && mainReservation.staker == stakeOwner) {
                stakeOwnerReservations += mainReservation.amount;
            } else if (mainReservation.active && mainReservation.staker == address(handler)) {
                handlerReservations += mainReservation.amount;
            }
            if (extensionReservation.active && extensionReservation.staker == stakeOwner) {
                stakeOwnerReservations += extensionReservation.amount;
            } else if (extensionReservation.active && extensionReservation.staker == address(handler)) {
                handlerReservations += extensionReservation.amount;
            }
        }
        assertEq(stakeOwnerReservations, vault.reservedStake(stakeOwner));
        assertEq(handlerReservations, vault.reservedStake(address(handler)));
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

    function invariant_ExtensionReservationsAreIsolatedAndTerminalChargesAreExact() public view {
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            bytes32 intentHash = handler.hashAt(index);
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
            IStakeVault.Reservation memory extensionReservation =
                vault.getReservation(manager.extensionReservationId(intentHash));
            uint256 maximumCharge = manager.calculateIntentExtensionCost(
                position.intentAmount,
                position.totalExtensionTime,
                position.extensionPenaltyBpsPerHour
            );

            assertLe(
                uint256(position.baseIntentExpiry - position.createdAt) + position.totalExtensionTime,
                manager.MAX_TOTAL_INTENT_LIFETIME()
            );
            assertLe(position.extensionPenalty, maximumCharge);
            if (position.status == IRiskManager.PositionStatus.PENDING) {
                assertEq(extensionReservation.amount, position.extensionReservation);
                assertEq(extensionReservation.active, position.extensionReservation != 0);
                if (extensionReservation.active) {
                    assertEq(extensionReservation.staker, position.extensionStakeOwner);
                }
                assertEq(position.extensionPenalty, 0);
            } else {
                assertEq(position.extensionReservation, 0);
                assertFalse(extensionReservation.active);
                uint64 terminalAt = position.status == IRiskManager.PositionStatus.CANCELLED
                    ? position.cancelledAt
                    : position.settledAt;
                (uint256 expectedPenalty,) = manager.calculateIntentExtensionPenalty(
                    position.intentAmount,
                    position.baseIntentExpiry,
                    terminalAt,
                    position.totalExtensionTime,
                    position.extensionPenaltyBpsPerHour
                );
                assertEq(position.extensionPenalty, expectedPenalty);
            }
        }
    }

    function invariant_DeferredCustodyIsFullyReservedMembershipStake() public view {
        uint256 deferredFees;
        uint256 vestedFees;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            bytes32 intentHash = handler.hashAt(index);
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
            if (
                position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                    && position.status == IRiskManager.PositionStatus.SETTLED
            ) {
                IStakeVault.DeferredStake memory deferredStake = vault.getDeferredStake(intentHash);
                deferredFees += deferredStake.feeAmount;
                assertEq(vault.getReservation(intentHash).staker, address(handler));
                assertEq(vault.getReservation(intentHash).amount, deferredStake.grossAmount);
            } else if (
                position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT
                    && position.status == IRiskManager.PositionStatus.RELEASED
            ) {
                vestedFees += position.grossReleasedAmount - position.executableAmount;
            }
        }

        assertEq(deferredFees, vault.totalDeferredFees());
        assertEq(vestedFees, vault.totalClaimableFees());
        assertEq(vestedFees, vault.claimableFees(address(0xFEE)));
    }

    function invariant_StakeBalancesEqualDepositsMinusEverySlash() public view {
        uint256 stakeOwnerSlashes;
        uint256 handlerSlashes;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(handler.hashAt(index));
            if (position.extensionStakeOwner == stakeOwner) stakeOwnerSlashes += position.extensionPenalty;
            else if (position.extensionStakeOwner == address(handler)) {
                handlerSlashes += position.extensionPenalty;
            }
            if (position.stakeOwner == stakeOwner) stakeOwnerSlashes += position.slashedAmount;
            else if (position.stakeOwner == address(handler)) handlerSlashes += position.slashedAmount;
        }

        uint256 handlerDeferredDeposits;
        uint256 vestedDeferredFees;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(handler.hashAt(index));
            if (position.mode != IRiskManager.RiskMode.DEFERRED_PAYOUT) continue;
            handlerDeferredDeposits += position.grossReleasedAmount;
            if (position.status == IRiskManager.PositionStatus.RELEASED) {
                vestedDeferredFees += position.grossReleasedAmount - position.executableAmount;
            }
        }

        assertEq(vault.stakeBalance(stakeOwner), 1_000_000e6 - stakeOwnerSlashes);
        assertEq(
            vault.stakeBalance(address(handler)),
            handlerDeferredDeposits - handlerSlashes - vestedDeferredFees
        );
    }

    function invariant_VaultAccountingRemainsSolvent() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }
}
