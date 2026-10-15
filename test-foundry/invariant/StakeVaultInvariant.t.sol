// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract StakeVaultInvariantHandler is Test {
    uint256 internal constant LOCK_SLOTS = 8;
    uint64 internal constant NEVER_MATURES = type(uint64).max;

    StakeVault public immutable vault;
    USDCMock public immutable token;

    constructor(StakeVault _vault, USDCMock _token) {
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
        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: address(this), amount: claimAmount});
        }
        vault.resolveLock(lockId, claims);
    }

    function withdraw(uint256 _rawAmount) external {
        uint256 available = vault.freeStake(address(this));
        if (available == 0) return;
        vault.withdrawStake(bound(_rawAmount, 1, available));
    }

    function withdrawClaim() external {
        if (vault.claimable(address(this)) == 0) return;
        vault.claim();
    }

    function lockIdAt(uint256 _slot) public pure returns (bytes32) {
        return keccak256(abi.encode("STAKE_VAULT_INVARIANT_LOCK", _slot));
    }

    function lockSlots() external pure returns (uint256) {
        return LOCK_SLOTS;
    }
}

contract StakeVaultInvariantTest is StdInvariant, Test {
    StakeVault internal vault;
    USDCMock internal token;
    StakeVaultInvariantHandler internal handler;

    function setUp() public {
        token = new USDCMock(10_000_000e6, "USD Coin", "USDC");
        vault = new StakeVault(address(this), token, address(0), 1 days);
        handler = new StakeVaultInvariantHandler(vault, token);
        vault.initializeController(address(handler));
        token.transfer(address(handler), 5_000_000e6);
        targetContract(address(handler));
    }

    function invariant_TokenBalanceCoversEveryRecordedLiability() public view {
        uint256 tokenBalance = token.balanceOf(address(vault));
        uint256 accounted = vault.totalAccounted();
        assertGe(tokenBalance, accounted);
        assertEq(vault.unaccountedBalance(), tokenBalance - accounted);
    }

    function invariant_StakeOwnerBalanceAlwaysCoversItsLocks() public view {
        assertLe(vault.lockedStake(address(handler)), vault.stakeBalance(address(handler)));
        assertEq(
            vault.freeStake(address(handler)),
            vault.stakeBalance(address(handler)) - vault.lockedStake(address(handler))
        );
    }

    function invariant_GlobalTotalsEqualPerAccountBalances() public view {
        assertEq(vault.totalStaked(), vault.stakeBalance(address(handler)));
        assertEq(vault.totalClaimable(), vault.claimable(address(handler)));
    }

    function invariant_EveryLockIsIncludedInAggregateLockedStake() public view {
        uint256 aggregateLockAmount;
        for (uint256 slot = 0; slot < handler.lockSlots(); slot++) {
            (, uint256 amount,) = vault.locks(handler.lockIdAt(slot));
            aggregateLockAmount += amount;
        }
        assertEq(aggregateLockAmount, vault.lockedStake(address(handler)));
    }
}
