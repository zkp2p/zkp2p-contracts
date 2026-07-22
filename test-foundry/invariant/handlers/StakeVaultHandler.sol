// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

/// @dev Stateful driver with a shadow accounting model. Expected reverts are caught so fail_on_revert can stay true.
contract StakeVaultHandler is Test {
    error UnexpectedSuccess(uint256 action);
    error UnexpectedRevert(uint256 action, bytes revertData);

    uint256 public constant ACTOR_COUNT = 3;
    uint256 public constant MAKER_COUNT = 2;
    uint256 public constant SLOT_COUNT = 12;
    uint256 public constant ACTION_COUNT = 12;
    uint256 internal constant MAX_ACTION_AMOUNT = 1_000e6;

    StakeVault public immutable vault;
    USDCMock public immutable token;

    address[ACTOR_COUNT] internal actors;
    address[MAKER_COUNT] internal makers;
    mapping(address => uint256) public ghostStake;
    mapping(address => uint256) public ghostReserved;
    mapping(address => uint256) public ghostCompensation;
    uint256 public ghostTokensIn;
    uint256 public ghostTokensOut;

    uint256[ACTION_COUNT] public actionCalls;
    uint256 public totalCalls;
    uint256 public successfulCalls;
    uint256 public rejectedCalls;
    uint256 public unauthorizedAttempts;
    uint256 public unauthorizedSuccesses;

    constructor(StakeVault vault_, USDCMock token_) {
        vault = vault_;
        token = token_;
        for (uint256 index; index < ACTOR_COUNT; ++index) {
            actors[index] = address(uint160(0xA100 + index));
        }
        for (uint256 index; index < MAKER_COUNT; ++index) {
            makers[index] = address(uint160(0xB100 + index));
        }
    }

    function configureActors(uint256 balance) external {
        for (uint256 index; index < ACTOR_COUNT; ++index) {
            token.transfer(actors[index], balance);
            vm.prank(actors[index]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }

    function makerAt(uint256 index) external view returns (address) {
        return makers[index];
    }

    function positionAt(uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("stake-vault-invariant-position", index));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % ACTOR_COUNT];
    }

    function _maker(uint256 seed) internal view returns (address) {
        return makers[seed % MAKER_COUNT];
    }

    function _position(uint256 seed) internal pure returns (bytes32) {
        return positionAt(seed % SLOT_COUNT);
    }

    function _call(address caller, bytes memory data, uint256 action, bytes4 expectedRevert)
        internal
        returns (bool success)
    {
        if (caller != address(this)) vm.prank(caller);
        bytes memory revertData;
        (success, revertData) = address(vault).call(data);
        if (success && expectedRevert != bytes4(0)) revert UnexpectedSuccess(action);
        if (!success && (expectedRevert == bytes4(0) || _selector(revertData) != expectedRevert)) {
            revert UnexpectedRevert(action, revertData);
        }
        _record(action, success);
    }

    function _selector(bytes memory revertData) internal pure returns (bytes4 selector) {
        if (revertData.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(revertData, 0x20))
        }
    }

    function _record(uint256 action, bool success) internal {
        ++actionCalls[action];
        ++totalCalls;
        if (success) ++successfulCalls;
        else ++rejectedCalls;
    }

    function deposit(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _actor(actorSeed);
        uint256 available = token.balanceOf(actor);
        uint256 amount =
            available == 0 ? 1 : bound(rawAmount, 1, available > MAX_ACTION_AMOUNT ? MAX_ACTION_AMOUNT : available);
        uint256 beforeStake = vault.stakeBalance(actor);
        bytes4 expectedRevert = available == 0 ? bytes4(keccak256("Error(string)")) : bytes4(0);
        bool success = _call(actor, abi.encodeCall(vault.depositStake, (amount)), 0, expectedRevert);
        if (success) {
            uint256 delta = vault.stakeBalance(actor) - beforeStake;
            ghostStake[actor] += delta;
            ghostTokensIn += delta;
        }
    }

    function reserve(uint256 actorSeed, uint256 slotSeed, uint256 rawAmount, uint64 rawDuration) external {
        address actor = _actor(actorSeed);
        bytes32 position = _position(slotSeed);
        uint256 free = vault.freeStake(actor);
        uint256 amount = free == 0 ? 1 : bound(rawAmount, 1, free > MAX_ACTION_AMOUNT ? MAX_ACTION_AMOUNT : free);
        uint64 releaseTime = uint64(block.timestamp) + uint64(bound(uint256(rawDuration), 1, 30 days));
        IStakeVault.Reservation memory existingReservation = vault.getReservation(position);
        bytes4 expectedRevert;
        if (vault.isExiting(actor)) expectedRevert = StakeVault.AlreadyExiting.selector;
        else if (existingReservation.active) expectedRevert = StakeVault.ReservationAlreadyExists.selector;
        else if (free == 0) expectedRevert = StakeVault.InsufficientFreeStake.selector;
        bool success = _call(
            address(this), abi.encodeCall(vault.reserveStake, (actor, position, amount, releaseTime)), 1, expectedRevert
        );
        if (success) ghostReserved[actor] += amount;
    }

    function increase(uint256 slotSeed, uint256 rawAmount, uint64 rawDuration) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 free = beforeReservation.active ? vault.freeStake(beforeReservation.staker) : 0;
        uint256 amount = free == 0 ? 0 : bound(rawAmount, 0, free > MAX_ACTION_AMOUNT ? MAX_ACTION_AMOUNT : free);
        uint64 releaseTime = uint64(block.timestamp) + uint64(bound(uint256(rawDuration), 1, 30 days));
        bytes4 expectedRevert;
        if (!beforeReservation.active) expectedRevert = StakeVault.ReservationNotFound.selector;
        else if (vault.isExiting(beforeReservation.staker)) expectedRevert = StakeVault.AlreadyExiting.selector;
        bool success = _call(
            address(this), abi.encodeCall(vault.increaseReservation, (position, amount, releaseTime)), 2, expectedRevert
        );
        if (success) ghostReserved[beforeReservation.staker] += amount;
    }

    function update(uint256 slotSeed, uint256 rawAmount, uint64 rawDuration) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 newAmount = beforeReservation.active ? bound(rawAmount, 1, beforeReservation.amount) : 1;
        uint64 releaseTime = uint64(block.timestamp) + uint64(bound(uint256(rawDuration), 1, 30 days));
        bytes4 expectedRevert = beforeReservation.active ? bytes4(0) : StakeVault.ReservationNotFound.selector;
        bool success = _call(
            address(this),
            abi.encodeCall(vault.updateReservation, (position, newAmount, releaseTime)),
            3,
            expectedRevert
        );
        if (success) {
            ghostReserved[beforeReservation.staker] -= beforeReservation.amount - newAmount;
        }
    }

    function release(uint256 slotSeed) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        bytes4 expectedRevert = beforeReservation.active ? bytes4(0) : StakeVault.ReservationNotFound.selector;
        bool success = _call(address(this), abi.encodeCall(vault.releaseReservation, (position)), 4, expectedRevert);
        if (success) ghostReserved[beforeReservation.staker] -= beforeReservation.amount;
    }

    function slash(uint256 slotSeed, uint256 makerSeed, uint256 rawAmount) external {
        bytes32 position = _position(slotSeed);
        address maker = _maker(makerSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 amount = beforeReservation.active ? bound(rawAmount, 1, beforeReservation.amount) : 1;
        bytes4 expectedRevert = beforeReservation.active ? bytes4(0) : StakeVault.ReservationNotFound.selector;
        bool success =
            _call(address(this), abi.encodeCall(vault.slashReservation, (position, maker, amount)), 5, expectedRevert);
        if (success) {
            ghostStake[beforeReservation.staker] -= amount;
            ghostReserved[beforeReservation.staker] -= amount;
            ghostCompensation[maker] += amount;
        }
    }

    function claimCompensation(uint256 makerSeed) external {
        address maker = _maker(makerSeed);
        uint256 amount = vault.claimableCompensation(maker);
        bytes4 expectedRevert = amount == 0 ? StakeVault.ZeroAmount.selector : bytes4(0);
        bool success = _call(maker, abi.encodeCall(vault.withdrawCompensation, (maker)), 6, expectedRevert);
        if (success) {
            ghostCompensation[maker] -= amount;
            ghostTokensOut += amount;
        }
    }

    function requestPartialWithdrawal(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _actor(actorSeed);
        uint256 free = vault.freeStake(actor);
        uint256 amount = free == 0 ? 1 : bound(rawAmount, 1, free);
        IStakeVault.StakeWithdrawalRequest memory existingRequest = vault.getStakeWithdrawalRequest(actor);
        bytes4 expectedRevert;
        if (vault.isExiting(actor)) expectedRevert = StakeVault.AlreadyExiting.selector;
        else if (existingRequest.amount != 0) expectedRevert = StakeVault.StakeWithdrawalAlreadyRequested.selector;
        else if (free == 0) expectedRevert = StakeVault.InsufficientFreeStake.selector;
        _call(actor, abi.encodeCall(vault.requestStakeWithdrawal, (amount)), 7, expectedRevert);
    }

    function settlePartialWithdrawal(uint256 actorSeed, bool cancel) external {
        address actor = _actor(actorSeed);
        uint256 beforeStake = vault.stakeBalance(actor);
        IStakeVault.StakeWithdrawalRequest memory withdrawalRequest = vault.getStakeWithdrawalRequest(actor);
        bytes memory data = cancel
            ? abi.encodeCall(vault.cancelStakeWithdrawal, ())
            : abi.encodeCall(vault.withdrawRequestedStake, (actor));
        bytes4 expectedRevert;
        if (withdrawalRequest.amount == 0) {
            expectedRevert = StakeVault.StakeWithdrawalNotFound.selector;
        } else if (!cancel && block.timestamp < withdrawalRequest.availableAt) {
            expectedRevert = StakeVault.StakeWithdrawalNotReady.selector;
        }
        bool success = _call(actor, data, 8, expectedRevert);
        if (success && !cancel) {
            uint256 withdrawn = beforeStake - vault.stakeBalance(actor);
            ghostStake[actor] -= withdrawn;
            ghostTokensOut += withdrawn;
        }
    }

    function toggleOrSettleExit(uint256 actorSeed, bool settle) external {
        address actor = _actor(actorSeed);
        bool exiting = vault.isExiting(actor);
        uint256 beforeStake = vault.stakeBalance(actor);
        IStakeVault.ExitRequest memory exitRequest = vault.getExitRequest(actor);
        IStakeVault.StakeWithdrawalRequest memory withdrawalRequest = vault.getStakeWithdrawalRequest(actor);
        bytes memory data;
        if (!exiting) data = abi.encodeCall(vault.requestExit, ());
        else if (settle) data = abi.encodeCall(vault.withdrawStake, (actor));
        else data = abi.encodeCall(vault.cancelExit, ());
        bytes4 expectedRevert;
        if (!exiting && beforeStake == 0) {
            expectedRevert = StakeVault.ZeroAmount.selector;
        } else if (!exiting && withdrawalRequest.amount != 0) {
            expectedRevert = StakeVault.PendingStakeWithdrawal.selector;
        } else if (exiting && settle && block.timestamp < exitRequest.availableAt) {
            expectedRevert = StakeVault.ExitNotReady.selector;
        } else if (exiting && settle && vault.reservedStake(actor) != 0) {
            expectedRevert = StakeVault.ActiveReservations.selector;
        } else if (exiting && settle && beforeStake == 0) {
            expectedRevert = StakeVault.ZeroAmount.selector;
        }
        bool success = _call(actor, data, 9, expectedRevert);
        if (success && exiting && settle) {
            uint256 withdrawn = beforeStake - vault.stakeBalance(actor);
            ghostStake[actor] -= withdrawn;
            ghostTokensOut += withdrawn;
        }
    }

    function advanceTime(uint32 rawDuration) external {
        vm.warp(block.timestamp + bound(uint256(rawDuration), 1, 14 days));
        _record(10, true);
    }

    function unauthorizedReserve(uint256 attackerSeed, uint256 slotSeed) external {
        address attacker = address(uint160(0xC100 + attackerSeed % 100));
        ++unauthorizedAttempts;
        bool success = _call(
            attacker,
            abi.encodeCall(
                vault.reserveStake, (_actor(attackerSeed), _position(slotSeed), 1, uint64(block.timestamp + 1))
            ),
            11,
            StakeVault.UnauthorizedController.selector
        );
        if (success) ++unauthorizedSuccesses;
    }
}
