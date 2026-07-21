// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

/// @dev Stateful driver with a shadow accounting model. Expected reverts are caught so fail_on_revert can stay true.
contract StakeVaultHandler is Test {
    uint256 public constant ACTOR_COUNT = 3;
    uint256 public constant MAKER_COUNT = 2;
    uint256 public constant SLOT_COUNT = 12;
    uint256 public constant ACTION_COUNT = 11;
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

    function _call(address caller, bytes memory data) internal returns (bool success) {
        if (caller != address(this)) vm.prank(caller);
        (success,) = address(vault).call(data);
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
        bool success = _call(actor, abi.encodeCall(vault.depositStake, (amount)));
        _record(0, success);
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
        bool success = _call(address(this), abi.encodeCall(vault.reserveStake, (actor, position, amount, releaseTime)));
        _record(1, success);
        if (success) ghostReserved[actor] += amount;
    }

    function increase(uint256 slotSeed, uint256 rawAmount, uint64 rawDuration) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 free = beforeReservation.active ? vault.freeStake(beforeReservation.staker) : 0;
        uint256 amount = free == 0 ? 0 : bound(rawAmount, 0, free > MAX_ACTION_AMOUNT ? MAX_ACTION_AMOUNT : free);
        uint64 releaseTime = uint64(block.timestamp) + uint64(bound(uint256(rawDuration), 1, 30 days));
        bool success = _call(address(this), abi.encodeCall(vault.increaseReservation, (position, amount, releaseTime)));
        _record(2, success);
        if (success) ghostReserved[beforeReservation.staker] += amount;
    }

    function update(uint256 slotSeed, uint256 rawAmount, uint64 rawDuration) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 capacity;
        if (beforeReservation.active) {
            capacity = vault.stakeBalance(beforeReservation.staker)
                - (vault.reservedStake(beforeReservation.staker) - beforeReservation.amount);
        }
        uint256 newAmount = capacity == 0 ? 1 : bound(rawAmount, 1, capacity);
        uint64 releaseTime = uint64(block.timestamp) + uint64(bound(uint256(rawDuration), 1, 30 days));
        bool success = _call(address(this), abi.encodeCall(vault.updateReservation, (position, newAmount, releaseTime)));
        _record(3, success);
        if (success) {
            if (newAmount >= beforeReservation.amount) {
                ghostReserved[beforeReservation.staker] += newAmount - beforeReservation.amount;
            } else {
                ghostReserved[beforeReservation.staker] -= beforeReservation.amount - newAmount;
            }
        }
    }

    function release(uint256 slotSeed) external {
        bytes32 position = _position(slotSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        bool success = _call(address(this), abi.encodeCall(vault.releaseReservation, (position)));
        _record(4, success);
        if (success) ghostReserved[beforeReservation.staker] -= beforeReservation.amount;
    }

    function slash(uint256 slotSeed, uint256 makerSeed, uint256 rawAmount) external {
        bytes32 position = _position(slotSeed);
        address maker = _maker(makerSeed);
        IStakeVault.Reservation memory beforeReservation = vault.getReservation(position);
        uint256 amount = beforeReservation.active ? bound(rawAmount, 1, beforeReservation.amount) : 1;
        bool success = _call(address(this), abi.encodeCall(vault.slashReservation, (position, maker, amount)));
        _record(5, success);
        if (success) {
            ghostStake[beforeReservation.staker] -= amount;
            ghostReserved[beforeReservation.staker] -= amount;
            ghostCompensation[maker] += amount;
        }
    }

    function claimCompensation(uint256 makerSeed) external {
        address maker = _maker(makerSeed);
        uint256 amount = vault.claimableCompensation(maker);
        bool success = _call(maker, abi.encodeCall(vault.withdrawCompensation, (maker)));
        _record(6, success);
        if (success) {
            ghostCompensation[maker] -= amount;
            ghostTokensOut += amount;
        }
    }

    function requestPartialWithdrawal(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _actor(actorSeed);
        uint256 free = vault.freeStake(actor);
        uint256 amount = free == 0 ? 1 : bound(rawAmount, 1, free);
        bool success = _call(actor, abi.encodeCall(vault.requestStakeWithdrawal, (amount)));
        _record(7, success);
    }

    function settlePartialWithdrawal(uint256 actorSeed, bool cancel) external {
        address actor = _actor(actorSeed);
        uint256 beforeStake = vault.stakeBalance(actor);
        bytes memory data = cancel
            ? abi.encodeCall(vault.cancelStakeWithdrawal, ())
            : abi.encodeCall(vault.withdrawRequestedStake, (actor));
        bool success = _call(actor, data);
        _record(8, success);
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
        bytes memory data;
        if (!exiting) data = abi.encodeCall(vault.requestExit, ());
        else if (settle) data = abi.encodeCall(vault.withdrawStake, (actor));
        else data = abi.encodeCall(vault.cancelExit, ());
        bool success = _call(actor, data);
        _record(9, success);
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
            )
        );
        if (success) ++unauthorizedSuccesses;
        ++totalCalls;
        if (success) ++successfulCalls;
        else ++rejectedCalls;
    }
}
