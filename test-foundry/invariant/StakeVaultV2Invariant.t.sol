// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {IStakeVaultV2} from "contracts/interfaces/IStakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract StakeVaultV2InvariantHandler is Test {
    uint256 internal constant LOCK_SLOTS = 8;
    uint64 internal constant NEVER_MATURES = type(uint64).max;

    StakeVaultV2 public immutable vault;
    USDCMock public immutable token;

    constructor(StakeVaultV2 _vault, USDCMock _token) {
        vault = _vault;
        token = _token;
        _token.approve(address(_vault), type(uint256).max);
    }

    function deposit(uint256 _rawAmount) external {
        uint256 available = token.balanceOf(address(this));
        if (available == 0) return;
        vault.depositStake(bound(_rawAmount, 1, available));
    }

    function lock(uint256 _rawSlot, uint256 _rawAmount) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner,,) = vault.locks(lockId);
        uint256 available = vault.freeStake(address(this));
        if (stakeOwner != address(0) || available == 0) return;
        vault.lockStake(address(this), lockId, bound(_rawAmount, 1, available), NEVER_MATURES);
    }

    function fundLock(uint256 _rawSlot, uint256 _rawAmount) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner,,) = vault.locks(lockId);
        uint256 available = token.balanceOf(address(this));
        if (stakeOwner != address(0) || available == 0) return;

        uint256 amount = bound(_rawAmount, 1, available);
        token.transfer(address(vault), amount);
        vault.fundLock(address(this), lockId, amount, NEVER_MATURES);
    }

    function donate(uint256 _rawAmount) external {
        uint256 available = token.balanceOf(address(this));
        if (available == 0) return;
        token.transfer(address(vault), bound(_rawAmount, 1, available));
    }

    function increase(uint256 _rawSlot, uint256 _rawAmount) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner,,) = vault.locks(lockId);
        uint256 available = vault.freeStake(address(this));
        if (stakeOwner == address(0) || available == 0) return;
        vault.increaseLock(lockId, bound(_rawAmount, 1, available));
    }

    function resize(uint256 _rawSlot, uint256 _rawAmount) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner, uint256 amount,) = vault.locks(lockId);
        if (stakeOwner == address(0) || amount <= 1) return;
        vault.resizeLock(lockId, bound(_rawAmount, 1, amount), NEVER_MATURES);
    }

    function unlock(uint256 _rawSlot) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner,,) = vault.locks(lockId);
        if (stakeOwner == address(0)) return;
        vault.unlockStake(lockId);
    }

    function resolve(uint256 _rawSlot, uint256 _rawClaimAmount) external {
        bytes32 lockId = lockIdAt(_rawSlot % LOCK_SLOTS);
        (address stakeOwner, uint256 amount,) = vault.locks(lockId);
        if (stakeOwner == address(0)) return;

        uint256 claimAmount = bound(_rawClaimAmount, 0, amount);
        IStakeVaultV2.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVaultV2.Claim[](0);
        } else {
            claims = new IStakeVaultV2.Claim[](1);
            claims[0] = IStakeVaultV2.Claim({beneficiary: address(this), amount: claimAmount});
        }
        vault.resolveLock(lockId, claims);
    }

    function withdraw(uint256 _rawAmount) external {
        uint256 available = vault.freeStake(address(this));
        if (available == 0) return;
        vault.withdrawStake(bound(_rawAmount, 1, available));
    }

    /// @notice Withdraws the actor's free stake to another address.
    function withdrawTo(uint256 amount) external {
        uint256 available = vault.freeStake(address(this));
        if (available == 0) return;
        vault.withdrawStakeTo(address(0xBEEF), bound(amount, 1, available));
    }

    function withdrawClaim() external {
        if (vault.claimable(address(this)) == 0) return;
        vault.claim();
    }

    function lockIdAt(uint256 _slot) public view returns (bytes32) {
        return keccak256(abi.encode("STAKE_VAULT_INVARIANT_LOCK", address(this), _slot));
    }

    function lockSlots() external pure returns (uint256) {
        return LOCK_SLOTS;
    }
}

contract StakeVaultV2InvariantTest is StdInvariant, Test {
    StakeVaultV2 internal vault;
    USDCMock internal token;
    StakeVaultV2InvariantHandler internal handler;
    StakeVaultV2InvariantHandler internal successor;

    function setUp() public {
        token = new USDCMock(10_000_000e6, "USD Coin", "USDC");
        vault = new StakeVaultV2(address(this), token, address(0));
        handler = new StakeVaultV2InvariantHandler(vault, token);
        vault.setController(address(handler), true);
        token.transfer(address(handler), 5_000_000e6);
        targetContract(address(handler));
        successor = new StakeVaultV2InvariantHandler(vault, token);
        vault.setController(address(successor), true);
        token.transfer(address(successor), 5_000_000e6);
        targetContract(address(successor));
    }

    function invariant_TokenBalanceCoversEveryRecordedLiability() public view {
        uint256 tokenBalance = token.balanceOf(address(vault));
        uint256 accounted = vault.totalAccounted();
        assertGe(tokenBalance, accounted);
        assertEq(vault.unaccountedBalance(), tokenBalance - accounted);
    }

    function invariant_StakeOwnerBalanceAlwaysCoversItsLocks() public view {
        _assertOwnerBalance(address(handler));
        _assertOwnerBalance(address(successor));
    }

    function _assertOwnerBalance(address owner) internal view {
        assertLe(vault.lockedStake(owner), vault.stakeBalance(owner));
        assertEq(vault.freeStake(owner), vault.stakeBalance(owner) - vault.lockedStake(owner));
    }

    function invariant_GlobalTotalsEqualPerAccountBalances() public view {
        assertEq(vault.totalStaked(), vault.stakeBalance(address(handler)) + vault.stakeBalance(address(successor)));
        assertEq(vault.totalClaimable(), vault.claimable(address(handler)) + vault.claimable(address(successor)));
    }

    function invariant_EveryLockIsIncludedInAggregateLockedStakeAndRetainsCreator() public view {
        _assertLocks(handler);
        _assertLocks(successor);
    }

    function _assertLocks(StakeVaultV2InvariantHandler actor) internal view {
        uint256 aggregateLockAmount;
        for (uint256 slot = 0; slot < actor.lockSlots(); slot++) {
            bytes32 id = actor.lockIdAt(slot);
            (address owner, uint256 amount,) = vault.locks(id);
            aggregateLockAmount += amount;
            assertEq(vault.lockController(id), owner == address(0) ? address(0) : address(actor));
        }
        assertEq(aggregateLockAmount, vault.lockedStake(address(actor)));
    }
}
