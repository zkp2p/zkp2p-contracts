// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract StakeVaultFuzzTest is Test {
    uint256 internal constant MAX_AMOUNT = 1_000_000e6;
    uint64 internal constant NEVER_MATURES = type(uint64).max;

    address internal controller;
    address internal stakeOwner;
    address internal beneficiary;
    address internal taker;
    address internal alternateOwner;

    USDCMock internal token;
    StakeVault internal vault;

    function setUp() public {
        controller = makeAddr("controller");
        stakeOwner = makeAddr("stakeOwner");
        beneficiary = makeAddr("beneficiary");
        taker = makeAddr("taker");
        alternateOwner = makeAddr("alternateOwner");

        token = new USDCMock(MAX_AMOUNT * 4, "USD Coin", "USDC");
        vault = new StakeVault(address(this), token, controller, 1 days);
        token.transfer(stakeOwner, MAX_AMOUNT);
        token.transfer(alternateOwner, MAX_AMOUNT);
        vm.prank(stakeOwner);
        token.approve(address(vault), type(uint256).max);
        vm.prank(alternateOwner);
        token.approve(address(vault), type(uint256).max);
    }

    function testFuzz_ResolveConservesStakeClaimsAndTokens(uint96 rawDeposit, uint96 rawLock, uint96 rawClaim) public {
        uint256 depositAmount = bound(uint256(rawDeposit), 1, MAX_AMOUNT);
        uint256 lockAmount = bound(uint256(rawLock), 1, depositAmount);
        uint256 claimAmount = bound(uint256(rawClaim), 0, lockAmount);
        bytes32 lockId = keccak256(abi.encode(depositAmount, lockAmount, claimAmount));

        vm.prank(stakeOwner);
        vault.depositStake(depositAmount);
        vm.prank(controller);
        vault.lockStake(stakeOwner, lockId, lockAmount, NEVER_MATURES);

        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: beneficiary, amount: claimAmount});
        }
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        assertEq(vault.stakeBalance(stakeOwner), depositAmount - claimAmount);
        assertEq(vault.freeStake(stakeOwner), depositAmount - claimAmount);
        assertEq(vault.lockedStake(stakeOwner), 0);
        assertEq(vault.claimable(beneficiary), claimAmount);
        assertEq(vault.totalAccounted(), depositAmount);
        assertEq(token.balanceOf(address(vault)), depositAmount);
    }

    function testFuzz_IndependentLocksCannotConsumeEachOther(uint96 rawFirst, uint96 rawSecond, uint96 rawFirstClaim)
        public
    {
        uint256 firstAmount = bound(uint256(rawFirst), 1, MAX_AMOUNT / 2);
        uint256 secondAmount = bound(uint256(rawSecond), 1, MAX_AMOUNT / 2);
        uint256 claimAmount = bound(uint256(rawFirstClaim), 0, firstAmount);
        uint256 depositAmount = firstAmount + secondAmount;
        bytes32 firstLockId = keccak256(abi.encode("first", firstAmount, secondAmount));
        bytes32 secondLockId = keccak256(abi.encode("second", firstAmount, secondAmount));

        vm.prank(stakeOwner);
        vault.depositStake(depositAmount);
        vm.startPrank(controller);
        vault.lockStake(stakeOwner, firstLockId, firstAmount, NEVER_MATURES);
        vault.lockStake(stakeOwner, secondLockId, secondAmount, NEVER_MATURES);

        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: beneficiary, amount: claimAmount});
        }
        vault.resolveLock(firstLockId, claims);
        vm.stopPrank();

        (, uint256 remainingLockAmount,) = vault.locks(secondLockId);
        assertEq(remainingLockAmount, secondAmount);
        assertEq(vault.lockedStake(stakeOwner), secondAmount);
        assertEq(vault.freeStake(stakeOwner), firstAmount - claimAmount);
        assertEq(vault.totalAccounted(), depositAmount);
    }

    function testFuzz_FundedLockResolutionConservesGross(uint96 rawGross, uint96 rawClaim) public {
        uint256 grossAmount = bound(uint256(rawGross), 1, MAX_AMOUNT);
        uint256 claimAmount = bound(uint256(rawClaim), 0, grossAmount);
        bytes32 lockId = keccak256(abi.encode("funded", grossAmount, claimAmount));

        token.transfer(address(vault), grossAmount);
        vm.prank(controller);
        vault.fundLock(stakeOwner, lockId, grossAmount, uint64(block.timestamp + 30 days));

        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: beneficiary, amount: claimAmount});
        }
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        assertEq(vault.stakeBalance(stakeOwner), grossAmount - claimAmount);
        assertEq(vault.claimable(beneficiary), claimAmount);
        assertEq(vault.totalAccounted(), grossAmount);
        assertEq(token.balanceOf(address(vault)), grossAmount);
        assertEq(vault.unaccountedBalance(), 0);
    }

    function testFuzz_ArbitrarySponsorAuthorizationCannotChangeTakerSelection(address sponsor) public {
        vm.assume(sponsor != address(0) && sponsor != taker && sponsor != stakeOwner && sponsor != alternateOwner);

        vm.prank(stakeOwner);
        vault.setTakerAuthorization(taker, true);
        vm.prank(alternateOwner);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(stakeOwner);

        vm.prank(sponsor);
        vault.setTakerAuthorization(taker, true);

        assertEq(vault.stakeOwnerOf(taker), stakeOwner);
        assertEq(vault.selectedStakeOwner(taker), stakeOwner);
    }

    function testFuzz_MultipleStakeOwnersRemainAccountingIsolated(
        uint96 rawFirstAmount,
        uint96 rawSecondAmount,
        uint96 rawClaimAmount
    ) public {
        uint256 firstAmount = bound(uint256(rawFirstAmount), 1, MAX_AMOUNT);
        uint256 secondAmount = bound(uint256(rawSecondAmount), 1, MAX_AMOUNT);
        uint256 claimAmount = bound(uint256(rawClaimAmount), 0, firstAmount);
        bytes32 firstLockId = keccak256(abi.encode("owner-one", firstAmount));
        bytes32 secondLockId = keccak256(abi.encode("owner-two", secondAmount));

        vm.prank(stakeOwner);
        vault.depositStake(firstAmount);
        vm.prank(alternateOwner);
        vault.depositStake(secondAmount);
        vm.startPrank(controller);
        vault.lockStake(stakeOwner, firstLockId, firstAmount, NEVER_MATURES);
        vault.lockStake(alternateOwner, secondLockId, secondAmount, NEVER_MATURES);

        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: beneficiary, amount: claimAmount});
        }
        vault.resolveLock(firstLockId, claims);
        vm.stopPrank();

        assertEq(vault.stakeBalance(stakeOwner), firstAmount - claimAmount);
        assertEq(vault.lockedStake(stakeOwner), 0);
        assertEq(vault.stakeBalance(alternateOwner), secondAmount);
        assertEq(vault.lockedStake(alternateOwner), secondAmount);
        assertEq(vault.totalAccounted(), firstAmount + secondAmount);
    }

    function testFuzz_MaturityBoundaryPreventsFurtherLockMutation(uint96 rawAmount, uint32 rawDuration) public {
        uint256 amount = bound(uint256(rawAmount), 1, MAX_AMOUNT);
        uint64 duration = uint64(bound(uint256(rawDuration), 1, 365 days));
        uint64 maturesAt = uint64(block.timestamp) + duration;
        bytes32 lockId = keccak256(abi.encode("maturity", amount, duration));

        vm.prank(stakeOwner);
        vault.depositStake(amount);
        vm.prank(controller);
        vault.lockStake(stakeOwner, lockId, amount, maturesAt);
        vm.warp(maturesAt);

        assertTrue(vault.isLockMature(lockId));
        vm.expectPartialRevert(IStakeVault.LockAlreadyMatured.selector);
        vm.prank(controller);
        vault.increaseLock(lockId, 1);

        vm.expectPartialRevert(IStakeVault.LockAlreadyMatured.selector);
        vm.prank(controller);
        vault.resizeLock(lockId, amount, NEVER_MATURES);

        vm.prank(controller);
        vault.unlockStake(lockId);
        assertEq(vault.freeStake(stakeOwner), amount);
    }

    function testFuzz_IncreaseResizeResolveSequenceConservesAccounting(
        uint96 rawDeposit,
        uint96 rawInitialLock,
        uint96 rawIncrease,
        uint96 rawResizedAmount,
        uint96 rawClaim
    ) public {
        uint256 depositAmount = bound(uint256(rawDeposit), 2, MAX_AMOUNT);
        uint256 initialAmount = bound(uint256(rawInitialLock), 1, depositAmount - 1);
        uint256 additionalAmount = bound(uint256(rawIncrease), 1, depositAmount - initialAmount);
        uint256 increasedAmount = initialAmount + additionalAmount;
        uint256 resizedAmount = bound(uint256(rawResizedAmount), 1, increasedAmount);
        uint256 claimAmount = bound(uint256(rawClaim), 0, resizedAmount);
        bytes32 lockId = keccak256(abi.encode("sequence", depositAmount, initialAmount, additionalAmount));

        vm.prank(stakeOwner);
        vault.depositStake(depositAmount);
        vm.startPrank(controller);
        vault.lockStake(stakeOwner, lockId, initialAmount, NEVER_MATURES);
        vault.increaseLock(lockId, additionalAmount);
        vault.resizeLock(lockId, resizedAmount, NEVER_MATURES);

        IStakeVault.Claim[] memory claims;
        if (claimAmount == 0) {
            claims = new IStakeVault.Claim[](0);
        } else {
            claims = new IStakeVault.Claim[](1);
            claims[0] = IStakeVault.Claim({beneficiary: beneficiary, amount: claimAmount});
        }
        vault.resolveLock(lockId, claims);
        vm.stopPrank();

        assertEq(vault.stakeBalance(stakeOwner), depositAmount - claimAmount);
        assertEq(vault.lockedStake(stakeOwner), 0);
        assertEq(vault.claimable(beneficiary), claimAmount);
        assertEq(vault.totalAccounted(), depositAmount);
        assertEq(token.balanceOf(address(vault)), depositAmount);
    }
}
