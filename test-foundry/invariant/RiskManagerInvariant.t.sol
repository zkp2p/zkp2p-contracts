// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";

import {RiskManager} from "../../contracts/RiskManager.sol";
import {StakeVault} from "../../contracts/StakeVault.sol";
import {IIntentLifecycleHook} from "../../contracts/interfaces/IIntentLifecycleHook.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {
    RiskEscrowMock,
    RiskManagerFixture,
    RiskOrchestratorMock
} from "../deterministic/helpers/RiskManagerFixture.sol";

contract RiskManagerInvariantHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    RiskManager internal immutable manager;
    StakeVault internal immutable vault;
    RiskOrchestratorMock internal immutable orchestrator;
    RiskEscrowMock internal immutable escrow;
    address internal immutable payoutRecipient;
    address internal immutable lp;
    address internal immutable feeRecipient;
    bytes32 internal immutable paymentMethod;

    bytes32[] internal intentHashes;
    uint256 internal nonce;

    constructor(
        RiskManager _manager,
        StakeVault _vault,
        RiskOrchestratorMock _orchestrator,
        RiskEscrowMock _escrow,
        address _payoutRecipient,
        address _lp,
        address _feeRecipient,
        bytes32 _paymentMethod
    ) {
        manager = _manager;
        vault = _vault;
        orchestrator = _orchestrator;
        escrow = _escrow;
        payoutRecipient = _payoutRecipient;
        lp = _lp;
        feeRecipient = _feeRecipient;
        paymentMethod = _paymentMethod;
    }

    function selectSponsor(address _sponsor) external {
        try vault.selectStakeOwner(_sponsor) {} catch {}
    }

    function admit(uint96 _rawAmount) external {
        uint256 amount = 1 + uint256(_rawAmount) % 2_000e6;
        bytes32 intentHash = keccak256(abi.encode("invariant-intent", ++nonce));
        uint64 createdAt = uint64(block.timestamp);
        orchestrator.setIntent(
            intentHash, address(this), payoutRecipient, address(escrow), amount, paymentMethod, createdAt
        );
        escrow.setIntent(intentHash, amount, createdAt);
        try orchestrator.admit(manager, intentHash) {
            intentHashes.push(intentHash);
        } catch {}
    }

    function extend(uint256 _seed, uint32 _rawTime) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[_seed % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.PENDING) return;

        (,, uint256 currentTimestamp, uint256 currentExpiry) = _escrowIntent(intentHash);
        if (block.timestamp >= currentExpiry) return;
        uint256 maximumExpiry = currentTimestamp + 5 days;
        if (currentExpiry >= maximumExpiry) return;
        uint64 maximumAdditional = uint64(_min(maximumExpiry - currentExpiry, 6 hours));
        uint64 additionalTime = uint64(1 + uint256(_rawTime) % maximumAdditional);
        try manager.extendIntent(intentHash, additionalTime) {} catch {}
    }

    function cancel(uint256 _seed) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[_seed % intentHashes.length];
        if (manager.getRiskPosition(intentHash).status != IRiskManager.PositionStatus.PENDING) return;
        try orchestrator.cancel(manager, intentHash) {} catch {}
    }

    function settle(uint256 _seed, uint96 _rawGross) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[_seed % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.PENDING) return;

        uint256 grossAmount = 1 + uint256(_rawGross) % position.intentAmount;
        uint256 feeAmount = grossAmount / 100;
        IIntentLifecycleHook.FeeAllocation[] memory fees = new IIntentLifecycleHook.FeeAllocation[](1);
        fees[0] = IIntentLifecycleHook.FeeAllocation({
            feeType: IIntentLifecycleHook.FeeType.PROTOCOL, recipient: feeRecipient, amount: feeAmount
        });
        IIntentLifecycleHook.RiskSettlementContext memory context = IIntentLifecycleHook.RiskSettlementContext({
            intentHash: intentHash,
            token: address(vault.stakeToken()),
            recipient: payoutRecipient,
            grossAmount: grossAmount,
            executableAmount: grossAmount - feeAmount,
            isManualRelease: true,
            feeAllocations: fees
        });
        try orchestrator.settle(manager, context) {} catch {}
    }

    function mature(uint256 _seed) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[_seed % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.SETTLED) return;
        vm.warp(position.coverageDeadline);
        try manager.releaseMaturedPosition(intentHash) {} catch {}
    }

    function chargeback(uint256 _seed) external {
        if (intentHashes.length == 0) return;
        bytes32 intentHash = intentHashes[_seed % intentHashes.length];
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        if (position.status != IRiskManager.PositionStatus.SETTLED || block.timestamp >= position.coverageDeadline) {
            return;
        }

        IRiskManager.ChargebackDetails memory details = IRiskManager.ChargebackDetails({
            paymentMethod: paymentMethod,
            originalPaymentId: keccak256(abi.encode("payment", intentHash)),
            disputeId: keccak256(abi.encode("dispute", intentHash)),
            paymentAmount: 1,
            paymentCurrency: keccak256("USD")
        });
        bytes memory data = abi.encode(details);
        IRiskManager.ChargebackAttestation memory attestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
        try manager.submitChargeback(attestation) {} catch {}
    }

    function intentCount() external view returns (uint256) {
        return intentHashes.length;
    }

    function intentHashAt(uint256 _index) external view returns (bytes32) {
        return intentHashes[_index];
    }

    function _escrowIntent(bytes32 _intentHash)
        internal
        view
        returns (bytes32 intentHash, uint256 amount, uint256 timestamp, uint256 expiryTime)
    {
        (intentHash, amount, timestamp, expiryTime) = _decodeEscrowIntent(_intentHash);
    }

    function _decodeEscrowIntent(bytes32 _intentHash)
        internal
        view
        returns (bytes32 intentHash, uint256 amount, uint256 timestamp, uint256 expiryTime)
    {
        bytes memory result;
        bool success;
        (success, result) =
            address(escrow).staticcall(abi.encodeWithSignature("getDepositIntent(uint256,bytes32)", 1, _intentHash));
        require(success, "escrow read");
        return abi.decode(result, (bytes32, uint256, uint256, uint256));
    }

    function _min(uint256 _left, uint256 _right) internal pure returns (uint256) {
        return _left < _right ? _left : _right;
    }
}

contract RiskManagerInvariantTest is RiskManagerFixture {
    RiskManagerInvariantHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new RiskManagerInvariantHandler(
            manager, vault, orchestrator, escrow, payoutRecipient, lp, protocolFeeRecipient, PAYMENT_METHOD
        );
        vm.prank(safe);
        vault.setTakerAuthorization(address(handler), true);
        handler.selectSponsor(safe);
        targetContract(address(handler));
    }

    function invariant_VaultRemainsExactlySolvent() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
    }

    function invariant_GlobalTotalsEqualKnownAccountBalances() public view {
        assertEq(vault.totalStaked(), vault.stakeBalance(safe) + vault.stakeBalance(payoutRecipient));
        assertEq(vault.totalClaimable(), vault.claimable(lp) + vault.claimable(protocolFeeRecipient));
    }

    function invariant_EveryPositionMatchesItsVaultLocks() public view {
        uint256 count = handler.intentCount();
        for (uint256 intentIndex = 0; intentIndex < count; intentIndex++) {
            bytes32 intentHash = handler.intentHashAt(intentIndex);
            IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
            (address coverageOwner, uint256 coverageAmount, uint64 coverageMaturity) = vault.locks(intentHash);
            (address extensionOwner, uint256 extensionAmount,) = vault.locks(manager.extensionLockId(intentHash));

            if (position.status == IRiskManager.PositionStatus.PENDING) {
                if (position.mode == IRiskManager.RiskMode.STAKE_BACKED) {
                    assertEq(coverageOwner, position.stakeOwner);
                    assertEq(coverageAmount, position.coverageAmount);
                    assertEq(coverageMaturity, type(uint64).max);
                } else {
                    assertEq(coverageOwner, address(0));
                    assertEq(position.coverageAmount, 0);
                }
                if (position.extensionAmount != 0) {
                    assertEq(extensionOwner, position.extensionStakeOwner);
                    assertEq(extensionAmount, position.extensionAmount);
                } else {
                    assertEq(extensionOwner, address(0));
                }
            } else if (position.status == IRiskManager.PositionStatus.SETTLED) {
                assertEq(coverageOwner, position.stakeOwner);
                assertEq(coverageAmount, position.coverageAmount);
                assertEq(coverageMaturity, position.coverageDeadline);
                assertEq(extensionOwner, address(0));
                assertEq(position.extensionAmount, 0);
            } else {
                assertEq(coverageOwner, address(0));
                assertEq(extensionOwner, address(0));
                assertEq(position.coverageAmount, 0);
                assertEq(position.extensionAmount, 0);
            }
        }
    }

    function invariant_EachStakeOwnerBalanceCoversItsLocks() public view {
        assertLe(vault.lockedStake(safe), vault.stakeBalance(safe));
        assertLe(vault.lockedStake(payoutRecipient), vault.stakeBalance(payoutRecipient));
    }
}
