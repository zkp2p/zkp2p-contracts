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
    address public immutable stakeOwner;
    uint256 public nonce;

    mapping(bytes32 => IOrchestratorV3.RiskIntentData) internal intents;
    bytes32[] internal intentHashes;

    constructor(RiskInvariantEscrow _escrow, address _stakeOwner) {
        escrow = _escrow;
        stakeOwner = _stakeOwner;
    }

    function setManager(RiskManager _manager) external {
        require(address(manager) == address(0), "manager already set");
        manager = _manager;
        escrow.token().approve(address(_manager), type(uint256).max);
    }

    function create(uint96 rawAmount, bool chargebackable, bool deferred) external {
        uint256 amount = bound(uint256(rawAmount), 1, 10_000e6);
        bytes32 intentHash = keccak256(abi.encode(++nonce, amount, chargebackable, deferred));
        address intentOwner = deferred ? address(this) : stakeOwner;
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
        } catch {
            delete intents[intentHash];
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
        IOrchestratorV3.RiskIntentData memory intent = intents[intentHash];
        manager.settleIntent(IIntentRiskHook.RiskSettlementContext({
            intentHash: intentHash,
            token: address(escrow.token()),
            recipient: intent.to,
            grossAmount: releasedAmount,
            executableAmount: releasedAmount,
            isManualRelease: false
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
        if (position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT) {
            IStakeVault vault = manager.stakeVault();
            vault.withdrawDeferredPayout(intentHash, address(this));
        }
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
    address internal lp = makeAddr("lp");

    USDCMock internal token;
    StakeVault internal vault;
    RiskManager internal manager;
    RiskManagerInvariantHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        token = new USDCMock(2_000_000e6, "USD Coin", "USDC");
        RiskInvariantEscrow escrow = new RiskInvariantEscrow(lp, token);
        handler = new RiskManagerInvariantHandler(escrow, stakeOwner);
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

        IRiskManager.GriefingConfig memory griefing = IRiskManager.GriefingConfig({
            griefingCliff: 15 minutes,
            griefingPenaltyBpsPerHour: 0,
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

        deal(address(token), stakeOwner, 1_000_000e6);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
        vault.depositStake(1_000_000e6);
        vm.stopPrank();
        deal(address(token), address(handler), 100_000_000e6);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = RiskManagerInvariantHandler.create.selector;
        selectors[1] = RiskManagerInvariantHandler.cancel.selector;
        selectors[2] = RiskManagerInvariantHandler.settle.selector;
        selectors[3] = RiskManagerInvariantHandler.mature.selector;
        selectors[4] = RiskManagerInvariantHandler.chargeback.selector;
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
                position.mode == IRiskManager.RiskMode.STAKE_BACKED
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

    function invariant_DeferredCustodyNeverBecomesMembershipStake() public view {
        uint256 deferredLiabilities;
        for (uint256 index = 0; index < handler.hashCount(); index++) {
            bytes32 intentHash = handler.hashAt(index);
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
            if (position.mode == IRiskManager.RiskMode.DEFERRED_PAYOUT) {
                deferredLiabilities += vault.getDeferredPayout(intentHash).amount;
            }
        }

        assertEq(vault.stakeBalance(address(handler)), 0);
        assertEq(vault.freeStake(address(handler)), 0);
        assertEq(deferredLiabilities, vault.totalDeferredPayouts());
    }

    function invariant_VaultAccountingRemainsSolvent() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalLiabilities());
    }
}
