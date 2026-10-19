// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {IStakeVaultV2} from "contracts/interfaces/IStakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract ReentrantTokenV2 is ERC20 {
    StakeVaultV2 internal vault;
    bool public reentrySucceeded;

    constructor(address _holder) ERC20("Reentrant Token", "REENTRANT") {
        _mint(_holder, 1_000_000e6);
    }

    function setVault(StakeVaultV2 _vault) external {
        vault = _vault;
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        super._transfer(_from, _to, _amount);
        if (_to == address(vault)) {
            (reentrySucceeded,) = address(vault).call(abi.encodeCall(StakeVaultV2.depositStake, (1)));
        }
    }
}

contract StakeVaultV2Test is Test {
    event ControllerUpdated(address indexed controller, bool authorized);
    event StakeLocked(
        bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint64 maturesAt, uint256 totalLockedStake
    );
    event StakeUnlocked(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 totalLockedStake);
    event StakeWithdrawn(address indexed stakeOwner, address indexed to, uint256 amount, uint256 newStakeBalance);
    event LockFunded(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);

    uint64 internal constant NEVER_MATURES = type(uint64).max;

    address internal controller;
    address internal nextController;
    address internal safeA;
    address internal safeB;
    address internal taker;
    address internal attacker;
    address internal lp;
    address internal feeRecipient;

    USDCMock internal token;
    StakeVaultV2 internal vault;

    function setUp() public {
        controller = makeAddr("controller");
        vm.etch(controller, hex"00");
        nextController = makeAddr("nextController");
        vm.etch(nextController, hex"00");
        safeA = makeAddr("safeA");
        safeB = makeAddr("safeB");
        taker = makeAddr("taker");
        attacker = makeAddr("attacker");
        lp = makeAddr("lp");
        feeRecipient = makeAddr("feeRecipient");

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        vault = new StakeVaultV2(address(this), token);
        vault.setController(controller, true);

        token.transfer(safeA, 10_000e6);
        token.transfer(safeB, 10_000e6);
        vm.prank(safeA);
        token.approve(address(vault), type(uint256).max);
        vm.prank(safeB);
        token.approve(address(vault), type(uint256).max);
    }

    function test_ConstructorRejectsInvalidConfiguration() public {
        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        new StakeVaultV2(address(0), token);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        new StakeVaultV2(address(this), IERC20(address(0)));
    }

    function test_OwnershipTransferIsTwoStepAndOwnershipCannotBeRenounced() public {
        vault.transferOwnership(safeA);
        assertEq(vault.owner(), address(this));
        assertEq(vault.pendingOwner(), safeA);

        vm.prank(safeA);
        vault.acceptOwnership();
        assertEq(vault.owner(), safeA);
        assertEq(vault.pendingOwner(), address(0));

        vm.expectRevert(IStakeVaultV2.OwnershipRenunciationDisabled.selector);
        vm.prank(safeA);
        vault.renounceOwnership();
    }

    function test_DepositAndImmediateFreeWithdrawalMaintainAccounting() public {
        _deposit(safeA, 500e6);
        assertEq(vault.stakeBalance(safeA), 500e6);
        assertEq(vault.freeStake(safeA), 500e6);
        assertEq(vault.totalStaked(), 500e6);
        assertEq(vault.totalAccounted(), 500e6);
        assertEq(token.balanceOf(address(vault)), 500e6);

        uint256 balanceBefore = token.balanceOf(safeA);
        vm.prank(safeA);
        vault.withdrawStake(175e6);

        assertEq(token.balanceOf(safeA) - balanceBefore, 175e6);
        assertEq(vault.stakeBalance(safeA), 325e6);
        assertEq(vault.totalStaked(), 325e6);
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
    }

    function test_DepositBlocksTokenCallbackReentrancy() public {
        ReentrantTokenV2 reentrantToken = new ReentrantTokenV2(address(this));
        StakeVaultV2 reentrantVault = new StakeVaultV2(address(this), reentrantToken);
        reentrantToken.setVault(reentrantVault);
        reentrantToken.approve(address(reentrantVault), type(uint256).max);

        reentrantVault.depositStake(100e6);

        assertFalse(reentrantToken.reentrySucceeded());
        assertEq(reentrantVault.stakeBalance(address(this)), 100e6);
        assertEq(reentrantVault.totalAccounted(), 100e6);
    }

    function test_ZeroValueUserActionsRevert() public {
        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(safeA);
        vault.depositStake(0);

        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(safeA);
        vault.withdrawStake(0);

        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(safeA);
        vault.claim();
    }

    function test_DelegationLockAndGovernanceBoundaryInputsRevert() public {
        _deposit(safeA, 1);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("zero-amount"), 1, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InvalidTaker.selector, address(0)));
        vm.prank(safeA);
        vault.setTakerAuthorization(address(0), true);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InvalidTaker.selector, safeA));
        vm.prank(safeA);
        vault.setTakerAuthorization(safeA, true);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vm.prank(taker);
        vault.selectStakeOwner(address(0));

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vm.prank(taker);
        vault.selectStakeOwner(taker);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vault.setController(address(0), true);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vault.setController(address(0), false);
    }

    function test_DelegationRequiresOwnerAuthorizationAndTakerSelection() public {
        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        vm.prank(safeB);
        vault.setTakerAuthorization(taker, true);

        assertEq(vault.stakeOwnerOf(taker), taker);

        vm.prank(taker);
        vault.selectStakeOwner(safeA);
        assertEq(vault.stakeOwnerOf(taker), safeA);

        vm.prank(taker);
        vault.selectStakeOwner(safeB);
        assertEq(vault.stakeOwnerOf(taker), safeB);
        assertTrue(vault.authorizedTakers(safeA, taker));
        assertTrue(vault.authorizedTakers(safeB, taker));
    }

    function test_GetTakerStateReturnsSelectedOwnerBalancesAndFallsBackAfterRevocation() public {
        _deposit(safeA, 500e6);
        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(safeA);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("selected-owner-lock"), 125e6, NEVER_MATURES);

        (address stakeOwner, uint256 totalStake, uint256 lockedStakeAmount, uint256 freeStakeAmount) =
            vault.getTakerState(taker);
        assertEq(stakeOwner, safeA);
        assertEq(totalStake, 500e6);
        assertEq(lockedStakeAmount, 125e6);
        assertEq(freeStakeAmount, 375e6);

        vm.prank(safeA);
        vault.setTakerAuthorization(taker, false);
        (stakeOwner, totalStake, lockedStakeAmount, freeStakeAmount) = vault.getTakerState(taker);
        assertEq(stakeOwner, taker);
        assertEq(totalStake, 0);
        assertEq(lockedStakeAmount, 0);
        assertEq(freeStakeAmount, 0);
    }

    function test_AttackerAuthorizationCannotSquatOrReplaceSelection() public {
        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(safeA);

        vm.prank(attacker);
        vault.setTakerAuthorization(taker, true);

        assertEq(vault.selectedStakeOwner(taker), safeA);
        assertEq(vault.stakeOwnerOf(taker), safeA);
        assertTrue(vault.authorizedTakers(attacker, taker));
    }

    function test_RevocationClearsSelectionAndReauthorizationDoesNotRestoreIt() public {
        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(safeA);

        vm.prank(safeA);
        vault.setTakerAuthorization(taker, false);
        assertEq(vault.selectedStakeOwner(taker), address(0));
        assertEq(vault.stakeOwnerOf(taker), taker);

        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        assertEq(vault.stakeOwnerOf(taker), taker);
    }

    function test_TakerCannotSelectUnauthorizedStakeOwner() public {
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.UnauthorizedStakeOwner.selector, taker, safeA));
        vm.prank(taker);
        vault.selectStakeOwner(safeA);
    }

    function test_TakerCanExplicitlyClearSelectedStakeOwner() public {
        vm.prank(safeA);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(safeA);

        vm.prank(taker);
        vault.clearStakeOwner();

        assertEq(vault.selectedStakeOwner(taker), address(0));
        assertEq(vault.stakeOwnerOf(taker), taker);
        assertTrue(vault.authorizedTakers(safeA, taker));
    }

    function test_LockConsumesOnlyFreeStake() public {
        _deposit(safeA, 500e6);
        bytes32 lockId = keccak256("dispute");

        vm.prank(controller);
        vault.lockStake(safeA, lockId, 300e6, NEVER_MATURES);

        assertEq(vault.lockedStake(safeA), 300e6);
        assertEq(vault.freeStake(safeA), 200e6);
        (address lockOwner, uint256 amount, uint64 maturesAt) = vault.locks(lockId);
        assertEq(lockOwner, safeA);
        assertEq(amount, 300e6);
        assertEq(maturesAt, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientFreeStake.selector, safeA, 200e6, 201e6));
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("second-lock"), 201e6, NEVER_MATURES);
    }

    function test_LockRejectsInvalidIdentityAmountMaturityAndDuplicate() public {
        bytes32 lockId = keccak256("lock");
        _deposit(safeA, 100e6);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vm.prank(controller);
        vault.lockStake(address(0), lockId, 1, NEVER_MATURES);

        vm.expectRevert(IStakeVaultV2.ZeroLockId.selector);
        vm.prank(controller);
        vault.lockStake(safeA, bytes32(0), 1, NEVER_MATURES);

        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 0, NEVER_MATURES);

        vm.expectRevert(
            abi.encodeWithSelector(
                IStakeVaultV2.InvalidMaturity.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, uint64(block.timestamp));

        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, NEVER_MATURES);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockAlreadyExists.selector, lockId));
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, NEVER_MATURES);
    }

    function test_OnlyControllerCanMutateLocks() public {
        _deposit(safeA, 100e6);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.UnauthorizedController.selector, safeA));
        vm.prank(safeA);
        vault.lockStake(safeA, keccak256("unauthorized"), 1e6, NEVER_MATURES);
    }

    function test_MissingLockRevertsEveryMutation() public {
        bytes32 missingLockId = keccak256("missing");

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.unlockStake(missingLockId);

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](0);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.resolveLock(missingLockId, claims);
    }

    function test_UnlockDeletesLockAndMakesAllStakeFreeImmediately() public {
        _deposit(safeA, 500e6);
        bytes32 lockId = keccak256("cancelled");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 400e6, NEVER_MATURES);

        vm.prank(controller);
        vault.unlockStake(lockId);

        (address lockOwner, uint256 amount,) = vault.locks(lockId);
        assertEq(lockOwner, address(0));
        assertEq(amount, 0);
        assertEq(vault.lockedStake(safeA), 0);
        assertEq(vault.freeStake(safeA), 500e6);
    }

    function test_ResolveCreatesImmediateAggregatedClaimsAndFreesRemainder() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("deferred-clean-maturity");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 80e6, NEVER_MATURES);

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](3);
        claims[0] = IStakeVaultV2.Claim({beneficiary: lp, amount: 30e6});
        claims[1] = IStakeVaultV2.Claim({beneficiary: feeRecipient, amount: 10e6});
        claims[2] = IStakeVaultV2.Claim({beneficiary: feeRecipient, amount: 5e6});

        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        assertEq(vault.stakeBalance(safeA), 55e6);
        assertEq(vault.lockedStake(safeA), 0);
        assertEq(vault.freeStake(safeA), 55e6);
        assertEq(vault.claimable(lp), 30e6);
        assertEq(vault.claimable(feeRecipient), 15e6);
        assertEq(vault.totalStaked(), 55e6);
        assertEq(vault.totalClaimable(), 45e6);
        assertEq(vault.totalAccounted(), 100e6);
        assertEq(token.balanceOf(address(vault)), 100e6);
    }

    function test_ResolveRejectsInvalidOrExcessClaimsAtomically() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("invalid-claims");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 80e6, NEVER_MATURES);

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](2);
        claims[0] = IStakeVaultV2.Claim({beneficiary: lp, amount: 50e6});
        claims[1] = IStakeVaultV2.Claim({beneficiary: feeRecipient, amount: 31e6});
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.ClaimsExceedLock.selector, 80e6, 81e6));
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        (, uint256 amount,) = vault.locks(lockId);
        assertEq(amount, 80e6);
        assertEq(vault.lockedStake(safeA), 80e6);
        assertEq(vault.claimable(lp), 0);
    }

    function test_ResolveRejectsZeroBeneficiaryAndZeroClaimAmount() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("malformed-claim");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 100e6, NEVER_MATURES);

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: address(0), amount: 1});
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InvalidClaim.selector, address(0), 1));
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        claims[0] = IStakeVaultV2.Claim({beneficiary: lp, amount: 0});
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InvalidClaim.selector, lp, 0));
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        (, uint256 amount,) = vault.locks(lockId);
        assertEq(amount, 100e6);
    }

    function test_ClaimWithdrawsAllImmediately() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("claim");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 80e6, NEVER_MATURES);

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: lp, amount: 80e6});
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        uint256 balanceBefore = token.balanceOf(lp);
        vm.prank(lp);
        vault.claim();

        assertEq(token.balanceOf(lp) - balanceBefore, 80e6);
        assertEq(vault.claimable(lp), 0);
        assertEq(vault.totalClaimable(), 0);
        assertEq(vault.totalAccounted(), 20e6);
        assertEq(token.balanceOf(address(vault)), 20e6);
    }

    function test_FundLockCreditsOnlyActuallyUnaccountedTokens() public {
        bytes32 lockId = keccak256("funded-deferred");
        uint64 maturesAt = uint64(block.timestamp + 30 days);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientUnaccountedTokens.selector, 0, 100e6));
        vm.prank(controller);
        vault.fundLock(taker, lockId, 100e6, maturesAt);

        token.transfer(address(vault), 120e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit LockFunded(lockId, taker, 100e6, 100e6);
        vm.prank(controller);
        vault.fundLock(taker, lockId, 100e6, maturesAt);

        assertEq(vault.stakeBalance(taker), 100e6);
        assertEq(vault.lockedStake(taker), 100e6);
        assertEq(vault.totalStaked(), 100e6);
        assertEq(vault.unaccountedBalance(), 20e6);
    }

    function test_FundLockRejectsInvalidInputsAndDuplicateId() public {
        bytes32 lockId = keccak256("fund-validation");
        token.transfer(address(vault), 100e6);

        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vm.prank(controller);
        vault.fundLock(address(0), lockId, 1, NEVER_MATURES);

        vm.expectRevert(IStakeVaultV2.ZeroLockId.selector);
        vm.prank(controller);
        vault.fundLock(taker, bytes32(0), 1, NEVER_MATURES);

        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(controller);
        vault.fundLock(taker, lockId, 0, NEVER_MATURES);

        vm.expectRevert(
            abi.encodeWithSelector(
                IStakeVaultV2.InvalidMaturity.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        vm.prank(controller);
        vault.fundLock(taker, lockId, 1, uint64(block.timestamp));

        vm.prank(controller);
        vault.fundLock(taker, lockId, 100e6, NEVER_MATURES);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockAlreadyExists.selector, lockId));
        vm.prank(controller);
        vault.fundLock(taker, lockId, 1, NEVER_MATURES);
    }

    function test_MaturityIsRecordedButResolutionRemainsControllerDriven() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("maturity");
        uint64 maturesAt = uint64(block.timestamp + 30 days);
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 100e6, maturesAt);

        (,, uint64 recordedMaturity) = vault.locks(lockId);
        assertEq(recordedMaturity, maturesAt);
        vm.warp(maturesAt);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.UnauthorizedController.selector, safeA));
        vm.prank(safeA);
        vault.unlockStake(lockId);

        vm.prank(controller);
        vault.unlockStake(lockId);
        assertEq(vault.freeStake(safeA), 100e6);
    }

    function test_WithdrawCannotConsumeLockedStake() public {
        _deposit(safeA, 100e6);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("locked-withdrawal"), 80e6, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientFreeStake.selector, safeA, 20e6, 21e6));
        vm.prank(safeA);
        vault.withdrawStake(21e6);

        vm.prank(safeA);
        vault.withdrawStake(20e6);
        assertEq(vault.stakeBalance(safeA), 80e6);
        assertEq(vault.lockedStake(safeA), 80e6);
    }

    function test_WithdrawStakeToSendsFreeStakeToRecipient() public {
        _deposit(safeA, 100e6);
        address recipient = makeAddr("recipient");
        uint256 ownerBefore = token.balanceOf(safeA);
        uint256 totalStakedBefore = vault.totalStaked();

        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeWithdrawn(safeA, recipient, 40e6, 60e6);
        vm.prank(safeA);
        vault.withdrawStakeTo(recipient, 40e6);

        assertEq(token.balanceOf(recipient), 40e6);
        assertEq(token.balanceOf(safeA), ownerBefore);
        assertEq(vault.stakeBalance(safeA), 60e6);
        assertEq(vault.totalStaked(), totalStakedBefore - 40e6);
    }

    function test_WithdrawStakeToRejectsLockedStakeAndZero() public {
        _deposit(safeA, 100e6);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("locked-withdrawal-to"), 70e6, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InsufficientFreeStake.selector, safeA, 30e6, 31e6));
        vm.prank(safeA);
        vault.withdrawStakeTo(makeAddr("recipient"), 31e6);

        vm.expectRevert(IStakeVaultV2.ZeroAmount.selector);
        vm.prank(safeA);
        vault.withdrawStakeTo(makeAddr("recipient"), 0);
    }

    function test_WithdrawFundedLockAfterUnlock() public {
        bytes32 lockId = keccak256("funded-payout");
        uint256 balanceBefore = token.balanceOf(safeA);
        token.transfer(controller, 50e6);

        vm.startPrank(controller);
        token.transfer(address(vault), 50e6);
        vault.fundLock(safeA, lockId, 50e6, NEVER_MATURES);
        vault.unlockStake(lockId);
        vm.stopPrank();
        vm.prank(safeA);
        vault.withdrawStake(50e6);

        assertEq(token.balanceOf(safeA), balanceBefore + 50e6);
        assertEq(vault.stakeBalance(safeA), 0);
        assertEq(vault.totalStaked(), 0);
        assertEq(vault.totalAccounted(), token.balanceOf(address(vault)));
    }

    function test_ControllerAuthorizationChecksAndEvents() public {
        StakeVaultV2 emptyVault = new StakeVaultV2(address(this), token);
        assertFalse(emptyVault.isController(controller));
        vm.expectEmit(true, false, false, true, address(emptyVault));
        emit ControllerUpdated(controller, true);
        emptyVault.setController(controller, true);
        assertTrue(emptyVault.isController(controller));
        vm.expectEmit(true, false, false, true, address(emptyVault));
        emit ControllerUpdated(controller, false);
        emptyVault.setController(controller, false);
        assertFalse(emptyVault.isController(controller));

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(attacker);
        vault.setController(nextController, true);
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(controller);
        vault.setController(controller, false);
        vm.expectRevert(IStakeVaultV2.ZeroAddress.selector);
        vault.setController(address(0), true);
    }

    function test_AuthorizeSuccessorWithExistingStakeAndLocks() public {
        _deposit(safeA, 300e6);
        bytes32 first = keccak256("first-controller");
        bytes32 second = keccak256("second-controller");
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeLocked(first, safeA, 100e6, NEVER_MATURES, 100e6);
        vm.prank(controller);
        vault.lockStake(safeA, first, 100e6, NEVER_MATURES);
        vault.setController(nextController, true);
        vm.prank(nextController);
        vault.lockStake(safeA, second, 100e6, NEVER_MATURES);
        assertEq(vault.lockController(first), controller);
        assertEq(vault.lockController(second), nextController);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeUnlocked(first, safeA, 100e6, 100e6);
        vm.prank(controller);
        vault.unlockStake(first);
        assertEq(vault.lockController(first), address(0));
        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim(lp, 50e6);
        vm.prank(nextController);
        vault.resolveLock(second, claims);
        assertEq(vault.lockController(second), address(0));
        assertEq(vault.freeStake(safeA), 250e6);
        assertEq(vault.claimable(lp), 50e6);
    }

    function test_OtherAuthorizedControllerCannotServiceLock() public {
        _deposit(safeA, 100e6);
        bytes32 id = keccak256("creator-only");
        vm.prank(controller);
        vault.lockStake(safeA, id, 50e6, NEVER_MATURES);
        vault.setController(nextController, true);
        bytes memory reason =
            abi.encodeWithSelector(IStakeVaultV2.UnauthorizedLockController.selector, id, nextController, controller);
        _expectServiceReverts(id, nextController, reason);
        assertEq(vault.lockedStake(safeA), 50e6);
        assertEq(vault.lockController(id), controller);
        // The same isolation applies to a funded lock created by the other controller.
        token.transfer(address(vault), 20e6);
        bytes32 funded = keccak256("other-funded");
        vm.prank(nextController);
        vault.fundLock(safeA, funded, 20e6, NEVER_MATURES);
        assertEq(vault.lockController(funded), nextController);
        _expectServiceReverts(
            funded,
            controller,
            abi.encodeWithSelector(
                IStakeVaultV2.UnauthorizedLockController.selector, funded, controller, nextController
            )
        );
    }

    function test_DeauthorizedControllerCannotCreateServiceOrPayOut() public {
        _deposit(safeA, 100e6);
        bytes32 id = keccak256("retired");
        vm.prank(controller);
        vault.lockStake(safeA, id, 50e6, NEVER_MATURES);
        vault.setController(controller, false);
        bytes memory reason = abi.encodeWithSelector(IStakeVaultV2.UnauthorizedController.selector, controller);
        _expectServiceReverts(id, controller, reason);
        vm.expectRevert(reason);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("new"), 1, NEVER_MATURES);
        token.transfer(address(vault), 1);
        vm.expectRevert(reason);
        vm.prank(controller);
        vault.fundLock(safeA, keccak256("funded"), 1, NEVER_MATURES);
        assertEq(vault.lockController(id), controller);
        vault.setController(controller, true);
        vm.prank(controller);
        vault.unlockStake(id);
        assertEq(vault.freeStake(safeA), 100e6);
        assertEq(vault.lockController(id), address(0));
    }

    function test_ReusedLockIdRecordsNewCreator() public {
        _deposit(safeA, 100e6);
        bytes32 id = keccak256("reuse");
        vm.startPrank(controller);
        vault.lockStake(safeA, id, 20e6, NEVER_MATURES);
        vault.unlockStake(id);
        vm.stopPrank();
        vault.setController(nextController, true);
        vm.prank(nextController);
        vault.lockStake(safeA, id, 30e6, NEVER_MATURES);
        assertEq(vault.lockController(id), nextController);
        _expectServiceReverts(
            id,
            controller,
            abi.encodeWithSelector(IStakeVaultV2.UnauthorizedLockController.selector, id, controller, nextController)
        );
    }

    function _expectServiceReverts(bytes32 id, address caller, bytes memory reason) internal {
        vm.startPrank(caller);
        vm.expectRevert(reason);
        vault.unlockStake(id);
        vm.expectRevert(reason);
        vault.resolveLock(id, new IStakeVaultV2.Claim[](0));
        vm.stopPrank();
    }

    function _deposit(address _stakeOwner, uint256 _amount) internal {
        vm.prank(_stakeOwner);
        vault.depositStake(_amount);
    }
}
