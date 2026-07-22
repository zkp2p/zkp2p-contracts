// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakeVault} from "contracts/StakeVault.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract FeeOnTransferToken is ERC20 {
    constructor(address _holder) ERC20("Fee Token", "FEE") {
        _mint(_holder, 1_000_000e6);
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        uint256 fee = _amount / 100;
        super._transfer(_from, _to, _amount - fee);
        _burn(_from, fee);
    }
}

contract ReentrantToken is ERC20 {
    StakeVault internal vault;
    bool public reentrySucceeded;

    constructor(address _holder) ERC20("Reentrant Token", "REENTRANT") {
        _mint(_holder, 1_000_000e6);
    }

    function setVault(StakeVault _vault) external {
        vault = _vault;
    }

    function _transfer(address _from, address _to, uint256 _amount) internal override {
        super._transfer(_from, _to, _amount);
        if (_to == address(vault)) {
            (reentrySucceeded,) = address(vault).call(abi.encodeCall(StakeVault.depositStake, (1)));
        }
    }
}

contract StakeVaultTest is Test {
    event LockFunded(bytes32 indexed lockId, address indexed stakeOwner, uint256 amount, uint256 newStakeBalance);

    uint64 internal constant CONTROLLER_DELAY = 1 days;
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
    StakeVault internal vault;

    function setUp() public {
        controller = makeAddr("controller");
        nextController = makeAddr("nextController");
        safeA = makeAddr("safeA");
        safeB = makeAddr("safeB");
        taker = makeAddr("taker");
        attacker = makeAddr("attacker");
        lp = makeAddr("lp");
        feeRecipient = makeAddr("feeRecipient");

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        vault = new StakeVault(address(this), token, controller, CONTROLLER_DELAY);

        token.transfer(safeA, 10_000e6);
        token.transfer(safeB, 10_000e6);
        vm.prank(safeA);
        token.approve(address(vault), type(uint256).max);
        vm.prank(safeB);
        token.approve(address(vault), type(uint256).max);
    }

    function test_ConstructorRejectsInvalidConfiguration() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        new StakeVault(address(0), token, controller, CONTROLLER_DELAY);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        new StakeVault(address(this), IERC20(address(0)), controller, CONTROLLER_DELAY);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidControllerChangeDelay.selector, CONTROLLER_DELAY - 1));
        new StakeVault(address(this), token, controller, CONTROLLER_DELAY - 1);
    }

    function test_InitialControllerCanBeInitializedOnce() public {
        StakeVault uninitializedVault = new StakeVault(address(this), token, address(0), CONTROLLER_DELAY);

        uninitializedVault.initializeController(controller);
        assertEq(uninitializedVault.controller(), controller);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.ControllerAlreadyInitialized.selector, controller));
        uninitializedVault.initializeController(nextController);
    }

    function test_InitialControllerCannotBeInstalledAfterStakeIsDeposited() public {
        StakeVault uninitializedVault = new StakeVault(address(this), token, address(0), CONTROLLER_DELAY);
        vm.prank(safeA);
        token.approve(address(uninitializedVault), type(uint256).max);
        vm.prank(safeA);
        uninitializedVault.depositStake(100e6);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.ControllerInitializationWithLiabilities.selector, 100e6, 0));
        uninitializedVault.initializeController(controller);

        vm.prank(safeA);
        uninitializedVault.withdrawStake(100e6);
        uninitializedVault.initializeController(controller);
        assertEq(uninitializedVault.controller(), controller);
    }

    function test_OwnershipTransferIsTwoStepAndOwnershipCannotBeRenounced() public {
        vault.transferOwnership(safeA);
        assertEq(vault.owner(), address(this));
        assertEq(vault.pendingOwner(), safeA);

        vm.prank(safeA);
        vault.acceptOwnership();
        assertEq(vault.owner(), safeA);
        assertEq(vault.pendingOwner(), address(0));

        vm.expectRevert(StakeVault.OwnershipRenunciationDisabled.selector);
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

    function test_DepositRejectsFeeOnTransferToken() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken(address(this));
        StakeVault feeVault = new StakeVault(address(this), feeToken, controller, CONTROLLER_DELAY);
        feeToken.approve(address(feeVault), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidReceivedAmount.selector, 100e6, 99e6));
        feeVault.depositStake(100e6);
        assertEq(feeToken.balanceOf(address(feeVault)), 0);
    }

    function test_DepositBlocksTokenCallbackReentrancy() public {
        ReentrantToken reentrantToken = new ReentrantToken(address(this));
        StakeVault reentrantVault = new StakeVault(address(this), reentrantToken, controller, CONTROLLER_DELAY);
        reentrantToken.setVault(reentrantVault);
        reentrantToken.approve(address(reentrantVault), type(uint256).max);

        reentrantVault.depositStake(100e6);

        assertFalse(reentrantToken.reentrySucceeded());
        assertEq(reentrantVault.stakeBalance(address(this)), 100e6);
        assertEq(reentrantVault.totalAccounted(), 100e6);
    }

    function test_ZeroValueUserActionsRevert() public {
        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(safeA);
        vault.depositStake(0);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(safeA);
        vault.withdrawStake(0);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(safeA);
        vault.claim();
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
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedStakeOwner.selector, taker, safeA));
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
        bytes32 lockId = keccak256("chargeback");

        vm.prank(controller);
        vault.lockStake(safeA, lockId, 300e6, NEVER_MATURES);

        assertEq(vault.lockedStake(safeA), 300e6);
        assertEq(vault.freeStake(safeA), 200e6);
        (address lockOwner, uint256 amount, uint64 maturesAt) = vault.locks(lockId);
        assertEq(lockOwner, safeA);
        assertEq(amount, 300e6);
        assertEq(maturesAt, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, safeA, 200e6, 201e6));
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("second-lock"), 201e6, NEVER_MATURES);
    }

    function test_LockRejectsInvalidIdentityAmountMaturityAndDuplicate() public {
        bytes32 lockId = keccak256("lock");
        _deposit(safeA, 100e6);

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.lockStake(address(0), lockId, 1, NEVER_MATURES);

        vm.expectRevert(StakeVault.ZeroLockId.selector);
        vm.prank(controller);
        vault.lockStake(safeA, bytes32(0), 1, NEVER_MATURES);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 0, NEVER_MATURES);

        vm.expectRevert(
            abi.encodeWithSelector(
                StakeVault.InvalidMaturity.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, uint64(block.timestamp));

        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, NEVER_MATURES);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockAlreadyExists.selector, lockId));
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 1, NEVER_MATURES);
    }

    function test_OnlyControllerCanMutateLocks() public {
        _deposit(safeA, 100e6);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, safeA));
        vm.prank(safeA);
        vault.lockStake(safeA, keccak256("unauthorized"), 1e6, NEVER_MATURES);
    }

    function test_MissingLockRevertsEveryMutation() public {
        bytes32 missingLockId = keccak256("missing");

        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.increaseLock(missingLockId, 1);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.resizeLock(missingLockId, 1, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.unlockStake(missingLockId);

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](0);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockNotFound.selector, missingLockId));
        vm.prank(controller);
        vault.resolveLock(missingLockId, claims);
    }

    function test_IncreaseLockIsAdditiveAndRejectsMaturedLocks() public {
        _deposit(safeA, 500e6);
        bytes32 extensionLockId = keccak256("extension");
        vm.prank(controller);
        vault.lockStake(safeA, extensionLockId, 100e6, NEVER_MATURES);

        vm.prank(controller);
        vault.increaseLock(extensionLockId, 125e6);
        (, uint256 amount,) = vault.locks(extensionLockId);
        assertEq(amount, 225e6);
        assertEq(vault.lockedStake(safeA), 225e6);
        assertEq(vault.freeStake(safeA), 275e6);

        bytes32 finiteLockId = keccak256("finite");
        uint64 maturesAt = uint64(block.timestamp + 1 days);
        vm.prank(controller);
        vault.lockStake(safeA, finiteLockId, 10e6, maturesAt);
        vm.warp(maturesAt);

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.LockAlreadyMatured.selector, finiteLockId, maturesAt, maturesAt)
        );
        vm.prank(controller);
        vault.increaseLock(finiteLockId, 1e6);
    }

    function test_ResizeLockOnlyDecreasesAndSetsFiniteMaturity() public {
        _deposit(safeA, 500e6);
        bytes32 lockId = keccak256("chargeback-resize");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 400e6, NEVER_MATURES);

        uint64 coverageDeadline = uint64(block.timestamp + 30 days);
        vm.prank(controller);
        vault.resizeLock(lockId, 250e6, coverageDeadline);

        (, uint256 amount, uint64 maturesAt) = vault.locks(lockId);
        assertEq(amount, 250e6);
        assertEq(maturesAt, coverageDeadline);
        assertEq(vault.lockedStake(safeA), 250e6);
        assertEq(vault.freeStake(safeA), 250e6);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidLockAmount.selector, 251e6, 250e6));
        vm.prank(controller);
        vault.resizeLock(lockId, 251e6, coverageDeadline);
    }

    function test_ResizeRejectsPastNewMaturityAndMaturedLock() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("mature-resize");
        uint64 maturesAt = uint64(block.timestamp + 1 days);
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 100e6, maturesAt);

        vm.expectRevert(
            abi.encodeWithSelector(
                StakeVault.InvalidMaturity.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        vm.prank(controller);
        vault.resizeLock(lockId, 50e6, uint64(block.timestamp));

        vm.warp(maturesAt);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockAlreadyMatured.selector, lockId, maturesAt, maturesAt));
        vm.prank(controller);
        vault.resizeLock(lockId, 50e6, uint64(block.timestamp + 1 days));
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

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](3);
        claims[0] = IStakeVault.Claim({beneficiary: lp, amount: 30e6});
        claims[1] = IStakeVault.Claim({beneficiary: feeRecipient, amount: 10e6});
        claims[2] = IStakeVault.Claim({beneficiary: feeRecipient, amount: 5e6});

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

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](2);
        claims[0] = IStakeVault.Claim({beneficiary: lp, amount: 50e6});
        claims[1] = IStakeVault.Claim({beneficiary: feeRecipient, amount: 31e6});
        vm.expectRevert(abi.encodeWithSelector(StakeVault.ClaimsExceedLock.selector, 80e6, 81e6));
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

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: address(0), amount: 1});
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidClaim.selector, address(0), 1));
        vm.prank(controller);
        vault.resolveLock(lockId, claims);

        claims[0] = IStakeVault.Claim({beneficiary: lp, amount: 0});
        vm.expectRevert(abi.encodeWithSelector(StakeVault.InvalidClaim.selector, lp, 0));
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

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: lp, amount: 80e6});
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

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientUnaccountedTokens.selector, 0, 100e6));
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

        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vm.prank(controller);
        vault.fundLock(address(0), lockId, 1, NEVER_MATURES);

        vm.expectRevert(StakeVault.ZeroLockId.selector);
        vm.prank(controller);
        vault.fundLock(taker, bytes32(0), 1, NEVER_MATURES);

        vm.expectRevert(StakeVault.ZeroAmount.selector);
        vm.prank(controller);
        vault.fundLock(taker, lockId, 0, NEVER_MATURES);

        vm.expectRevert(
            abi.encodeWithSelector(
                StakeVault.InvalidMaturity.selector, uint64(block.timestamp), uint64(block.timestamp)
            )
        );
        vm.prank(controller);
        vault.fundLock(taker, lockId, 1, uint64(block.timestamp));

        vm.prank(controller);
        vault.fundLock(taker, lockId, 100e6, NEVER_MATURES);
        vm.expectRevert(abi.encodeWithSelector(StakeVault.LockAlreadyExists.selector, lockId));
        vm.prank(controller);
        vault.fundLock(taker, lockId, 1, NEVER_MATURES);
    }

    function test_MaturityIsRecordedButResolutionRemainsControllerDriven() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("maturity");
        uint64 maturesAt = uint64(block.timestamp + 30 days);
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 100e6, maturesAt);

        assertFalse(vault.isLockMature(lockId));
        vm.warp(maturesAt);
        assertTrue(vault.isLockMature(lockId));

        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, safeA));
        vm.prank(safeA);
        vault.unlockStake(lockId);

        vm.prank(controller);
        vault.unlockStake(lockId);
        assertEq(vault.freeStake(safeA), 100e6);
    }

    function test_ControllerHandoverImmediatelyTransfersAuthorityOverExistingLocks() public {
        _deposit(safeA, 100e6);
        bytes32 lockId = keccak256("handover");
        vm.prank(controller);
        vault.lockStake(safeA, lockId, 100e6, NEVER_MATURES);

        vault.proposeController(nextController);
        uint64 validAt = vault.pendingControllerValidAt();

        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.ControllerProposalNotReady.selector, validAt, uint64(block.timestamp))
        );
        vm.prank(nextController);
        vault.acceptController();

        vm.warp(validAt);
        vm.prank(nextController);
        vault.acceptController();
        assertEq(vault.controller(), nextController);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.UnauthorizedController.selector, controller));
        vm.prank(controller);
        vault.unlockStake(lockId);

        vm.prank(nextController);
        vault.unlockStake(lockId);
        assertEq(vault.freeStake(safeA), 100e6);
    }

    function test_ControllerProposalCanBeCancelled() public {
        vault.proposeController(nextController);
        vault.cancelControllerProposal();

        assertEq(vault.pendingController(), address(0));
        assertEq(vault.pendingControllerValidAt(), 0);
        vm.expectRevert(StakeVault.NoPendingController.selector);
        vm.prank(nextController);
        vault.acceptController();
    }

    function test_ControllerGovernanceRejectsUnauthorizedAndMissingActions() public {
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(attacker);
        vault.proposeController(nextController);

        vm.expectRevert(StakeVault.NoPendingController.selector);
        vault.cancelControllerProposal();

        vault.proposeController(nextController);
        vm.expectRevert(
            abi.encodeWithSelector(StakeVault.UnauthorizedPendingController.selector, attacker, nextController)
        );
        vm.prank(attacker);
        vault.acceptController();
    }

    function test_ReproposalReplacesPendingControllerAndRestartsDelay() public {
        vault.proposeController(nextController);
        uint64 firstValidAt = vault.pendingControllerValidAt();
        vm.warp(block.timestamp + 1 hours);

        vault.proposeController(attacker);
        uint64 replacementValidAt = vault.pendingControllerValidAt();
        assertEq(vault.pendingController(), attacker);
        assertGt(replacementValidAt, firstValidAt);

        vm.warp(replacementValidAt);
        vm.prank(attacker);
        vault.acceptController();
        assertEq(vault.controller(), attacker);
    }

    function test_WithdrawCannotConsumeLockedStake() public {
        _deposit(safeA, 100e6);
        vm.prank(controller);
        vault.lockStake(safeA, keccak256("locked-withdrawal"), 80e6, NEVER_MATURES);

        vm.expectRevert(abi.encodeWithSelector(StakeVault.InsufficientFreeStake.selector, safeA, 20e6, 21e6));
        vm.prank(safeA);
        vault.withdrawStake(21e6);

        vm.prank(safeA);
        vault.withdrawStake(20e6);
        assertEq(vault.stakeBalance(safeA), 80e6);
        assertEq(vault.lockedStake(safeA), 80e6);
    }

    function _deposit(address _stakeOwner, uint256 _amount) internal {
        vm.prank(_stakeOwner);
        vault.depositStake(_amount);
    }
}
