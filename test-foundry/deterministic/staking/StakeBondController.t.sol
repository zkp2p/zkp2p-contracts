// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {StakeBondController} from "contracts/StakeBondController.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {IStakeBondController} from "contracts/interfaces/IStakeBondController.sol";
import {IStakeVaultV2} from "contracts/interfaces/IStakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract StakeBondControllerTest is Test {
    event BondPosted(address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, uint256 amount);
    event BondExitRequested(
        address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, uint64 exitableAt
    );
    event BondExited(address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId);
    event BondSlashed(
        address indexed stakeOwner, bytes32 indexed subject, bytes32 indexed bondId, address beneficiary, uint256 amount
    );

    uint256 internal constant BOND = 500e6;
    uint256 internal constant WALLET = 1_500e6;
    uint256 internal constant OTHER_STAKE = 300e6;
    uint64 internal constant EXIT_DELAY = 30 days;
    bytes32 internal constant SUBJECT = keccak256("merchant-a");
    bytes32 internal constant OTHER_SUBJECT = keccak256("merchant-b");

    address internal governance;
    address internal merchant;
    address internal attacker;
    address internal treasury;
    address internal disputeController;

    USDCMock internal token;
    StakeVaultV2 internal vault;
    StakeBondController internal bonds;

    function setUp() public {
        governance = makeAddr("governance");
        merchant = makeAddr("merchant");
        attacker = makeAddr("attacker");
        treasury = makeAddr("treasury");
        disputeController = makeAddr("disputeController");
        vm.etch(disputeController, hex"00");

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        vault = new StakeVaultV2(address(this), token);
        bonds = new StakeBondController(governance, vault, BOND, EXIT_DELAY);
        vault.setController(address(bonds), true);
        vault.setController(disputeController, true);

        _fundWallet(merchant);
        _fundWallet(attacker);
        // Dispute stake the merchant already holds; a bond must never touch it.
        vm.startPrank(merchant);
        token.approve(address(vault), OTHER_STAKE);
        vault.depositStake(OTHER_STAKE);
        vm.stopPrank();
    }

    /* ============ Constructor ============ */

    function test_ConstructorRejectsInvalidConfiguration() public {
        vm.expectRevert(IStakeBondController.ZeroAddress.selector);
        new StakeBondController(address(0), vault, BOND, EXIT_DELAY);

        vm.expectRevert(IStakeBondController.ZeroAddress.selector);
        new StakeBondController(governance, IStakeVaultV2(address(0)), BOND, EXIT_DELAY);

        vm.expectRevert(IStakeBondController.ZeroAmount.selector);
        new StakeBondController(governance, vault, 0, EXIT_DELAY);

        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.InvalidExitDelay.selector, uint64(0)));
        new StakeBondController(governance, vault, BOND, 0);

        uint64 tooLong = 365 days + 1;
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.InvalidExitDelay.selector, tooLong));
        new StakeBondController(governance, vault, BOND, tooLong);
    }

    function test_ConstructorStoresConfiguration() public view {
        assertEq(address(bonds.stakeVault()), address(vault));
        assertEq(address(bonds.stakeToken()), address(token));
        assertEq(bonds.bondAmount(), BOND);
        assertEq(bonds.exitDelay(), EXIT_DELAY);
        assertEq(bonds.owner(), governance);
    }

    /* ============ Post ============ */

    function test_PostBondMovesTheBondFromTheWalletIntoALock() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.expectEmit(true, true, true, true, address(bonds));
        emit BondPosted(merchant, SUBJECT, id, BOND);
        vm.prank(merchant);
        bonds.postBond(SUBJECT);

        (address lockOwner, uint256 lockAmount, uint64 maturesAt) = vault.locks(id);
        assertEq(lockOwner, merchant);
        assertEq(lockAmount, BOND);
        assertEq(maturesAt, type(uint64).max);
        assertEq(vault.lockController(id), address(bonds));
        assertEq(token.balanceOf(merchant), WALLET - OTHER_STAKE - BOND);
        assertEq(vault.stakeBalance(merchant), OTHER_STAKE + BOND);
        assertEq(vault.freeStake(merchant), OTHER_STAKE);
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());

        IStakeBondController.Bond memory bond = bonds.getBond(merchant, SUBJECT);
        assertTrue(bond.posted);
        assertEq(bond.exitableAt, 0);
    }

    function test_PostBondRevertsWithoutAllowance() public {
        vm.prank(merchant);
        token.approve(address(bonds), BOND - 1);

        vm.prank(merchant);
        vm.expectRevert("ERC20: insufficient allowance");
        bonds.postBond(SUBJECT);
    }

    function test_PostBondRevertsWithoutWalletBalance() public {
        address thin = makeAddr("thin");
        token.transfer(thin, BOND - 1);
        vm.startPrank(thin);
        token.approve(address(bonds), BOND);
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        bonds.postBond(SUBJECT);
        vm.stopPrank();
    }

    function test_PostBondNeverAdoptsOtherUnaccountedTokens() public {
        token.transfer(address(vault), 7e6);

        vm.prank(merchant);
        bonds.postBond(SUBJECT);

        assertEq(vault.unaccountedBalance(), 7e6);
        assertEq(vault.stakeBalance(merchant), OTHER_STAKE + BOND);
    }

    function test_PostBondRevertsForASubjectAlreadyBondedAndKeepsTheTokens() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        token.approve(address(bonds), 2 * BOND);
        bonds.postBond(SUBJECT);
        uint256 walletAfterFirst = token.balanceOf(merchant);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockAlreadyExists.selector, id));
        bonds.postBond(SUBJECT);
        vm.stopPrank();

        assertEq(token.balanceOf(merchant), walletAfterFirst);
        assertEq(vault.stakeBalance(merchant), OTHER_STAKE + BOND);
    }

    function test_EachSubjectNeedsItsOwnBond() public {
        vm.startPrank(merchant);
        token.approve(address(bonds), 2 * BOND);
        bonds.postBond(SUBJECT);
        bonds.postBond(OTHER_SUBJECT);
        vm.stopPrank();

        assertEq(vault.lockedStake(merchant), 2 * BOND);
        assertEq(vault.freeStake(merchant), OTHER_STAKE);
    }

    function test_AnotherOwnersBondOnTheSameSubjectIsSeparate() public {
        vm.prank(attacker);
        bonds.postBond(SUBJECT);

        assertFalse(bonds.getBond(merchant, SUBJECT).posted);
        vm.prank(merchant);
        bonds.postBond(SUBJECT);
        assertTrue(bonds.getBond(merchant, SUBJECT).posted);
        assertTrue(bonds.bondId(merchant, SUBJECT) != bonds.bondId(attacker, SUBJECT));
    }

    function test_PostBondRevertsWhileControllerIsNotAuthorized() public {
        vault.setController(address(bonds), false);

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.UnauthorizedController.selector, address(bonds)));
        bonds.postBond(SUBJECT);
        assertEq(token.balanceOf(merchant), WALLET - OTHER_STAKE);
    }

    /* ============ Reservation ============ */

    function test_BondCannotBeWithdrawn() public {
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVaultV2.InsufficientFreeStake.selector, merchant, OTHER_STAKE, OTHER_STAKE + 1)
        );
        vault.withdrawStake(OTHER_STAKE + 1);
        vault.withdrawStake(OTHER_STAKE);
        vm.stopPrank();

        assertEq(vault.stakeBalance(merchant), BOND);
        assertEq(vault.freeStake(merchant), 0);
    }

    function test_BondCannotBackAnotherControllersLock() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);

        vm.prank(disputeController);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVaultV2.InsufficientFreeStake.selector, merchant, OTHER_STAKE, OTHER_STAKE + 1)
        );
        vault.lockStake(merchant, keccak256("intent"), OTHER_STAKE + 1, uint64(block.timestamp + 1 days));
    }

    function test_AnotherControllerCannotReleaseOrResolveABond() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        bytes memory refusal = abi.encodeWithSelector(
            IStakeVaultV2.UnauthorizedLockController.selector, id, disputeController, address(bonds)
        );

        vm.startPrank(disputeController);
        vm.expectRevert(refusal);
        vault.unlockStake(id);
        vm.expectRevert(refusal);
        vault.payOutLock(id);
        vm.expectRevert(refusal);
        vault.resolveLock(id, new IStakeVaultV2.Claim[](0));
        vm.stopPrank();
    }

    /* ============ Exit ============ */

    function test_RequestExitStartsTheNotice() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);
        uint64 noticeEnd = uint64(block.timestamp) + EXIT_DELAY;

        vm.expectEmit(true, true, true, true, address(bonds));
        emit BondExitRequested(merchant, SUBJECT, bonds.bondId(merchant, SUBJECT), noticeEnd);
        vm.prank(merchant);
        bonds.requestExit(SUBJECT);

        IStakeBondController.Bond memory bond = bonds.getBond(merchant, SUBJECT);
        assertTrue(bond.posted);
        assertEq(bond.exitableAt, noticeEnd);
    }

    function test_RequestExitRevertsWithoutABond() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.BondNotFound.selector, id));
        bonds.requestExit(SUBJECT);
    }

    function test_RequestExitRevertsWhenAlreadyRequested() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        uint64 noticeEnd = uint64(block.timestamp) + EXIT_DELAY;
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.ExitAlreadyRequested.selector, id, noticeEnd));
        bonds.requestExit(SUBJECT);
        vm.stopPrank();
    }

    function test_OnlyTheOwnerCanStartOrFinishItsExit() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);
        bytes32 attackerId = bonds.bondId(attacker, SUBJECT);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.BondNotFound.selector, attackerId));
        bonds.requestExit(SUBJECT);

        vm.prank(merchant);
        bonds.requestExit(SUBJECT);
        vm.warp(block.timestamp + EXIT_DELAY);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.ExitNotRequested.selector, attackerId));
        bonds.exit(SUBJECT);
        assertTrue(bonds.getBond(merchant, SUBJECT).posted);
    }

    function test_ExitRevertsWithoutNotice() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.ExitNotRequested.selector, id));
        bonds.exit(SUBJECT);
        vm.stopPrank();
    }

    function test_ExitRevertsBeforeTheNoticeEnds() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        uint64 noticeEnd = uint64(block.timestamp) + EXIT_DELAY;
        vm.warp(noticeEnd - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeBondController.ExitNotReady.selector, id, noticeEnd, noticeEnd - 1)
        );
        bonds.exit(SUBJECT);
        vm.stopPrank();
    }

    function test_ExitPaysTheBondBackToTheWallet() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        vm.warp(block.timestamp + EXIT_DELAY);

        vm.expectEmit(true, true, true, true, address(bonds));
        emit BondExited(merchant, SUBJECT, id);
        bonds.exit(SUBJECT);
        vm.stopPrank();

        IStakeBondController.Bond memory bond = bonds.getBond(merchant, SUBJECT);
        assertFalse(bond.posted);
        assertEq(bond.exitableAt, 0);
        assertEq(vault.lockController(id), address(0));
        assertEq(token.balanceOf(merchant), WALLET - OTHER_STAKE);
        assertEq(vault.stakeBalance(merchant), OTHER_STAKE);
        assertEq(vault.freeStake(merchant), OTHER_STAKE);
    }

    function test_OwnerCanPostAgainAfterExit() public {
        vm.startPrank(merchant);
        token.approve(address(bonds), 2 * BOND);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        vm.warp(block.timestamp + EXIT_DELAY);
        bonds.exit(SUBJECT);
        bonds.postBond(SUBJECT);
        vm.stopPrank();

        IStakeBondController.Bond memory bond = bonds.getBond(merchant, SUBJECT);
        assertTrue(bond.posted);
        assertEq(bond.exitableAt, 0);
    }

    /* ============ Slash ============ */

    function test_SlashTurnsTheBondIntoABeneficiaryClaim() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);
        bytes32 id = bonds.bondId(merchant, SUBJECT);

        vm.expectEmit(true, true, true, true, address(bonds));
        emit BondSlashed(merchant, SUBJECT, id, treasury, BOND);
        vm.prank(governance);
        bonds.slash(merchant, SUBJECT, treasury);

        assertEq(vault.stakeBalance(merchant), OTHER_STAKE);
        assertEq(vault.freeStake(merchant), OTHER_STAKE);
        assertEq(vault.claimable(treasury), BOND);
        assertFalse(bonds.getBond(merchant, SUBJECT).posted);

        vm.prank(treasury);
        vault.claim();
        assertEq(token.balanceOf(treasury), BOND);
    }

    function test_SlashDuringTheExitNoticeClearsIt() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        vm.stopPrank();
        vm.warp(block.timestamp + EXIT_DELAY - 1);

        vm.prank(governance);
        bonds.slash(merchant, SUBJECT, treasury);

        IStakeBondController.Bond memory bond = bonds.getBond(merchant, SUBJECT);
        assertFalse(bond.posted);
        assertEq(bond.exitableAt, 0);

        vm.warp(block.timestamp + 1);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(IStakeBondController.ExitNotRequested.selector, id));
        bonds.exit(SUBJECT);
    }

    function test_SlashRevertsAfterExit() public {
        bytes32 id = bonds.bondId(merchant, SUBJECT);
        vm.startPrank(merchant);
        bonds.postBond(SUBJECT);
        bonds.requestExit(SUBJECT);
        vm.warp(block.timestamp + EXIT_DELAY);
        bonds.exit(SUBJECT);
        vm.stopPrank();

        vm.prank(governance);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.LockNotFound.selector, id));
        bonds.slash(merchant, SUBJECT, treasury);
    }

    function test_SlashRevertsForAZeroBeneficiary() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);

        vm.prank(governance);
        vm.expectRevert(abi.encodeWithSelector(IStakeVaultV2.InvalidClaim.selector, address(0), BOND));
        bonds.slash(merchant, SUBJECT, address(0));
    }

    function test_OnlyGovernanceCanSlash() public {
        vm.prank(merchant);
        bonds.postBond(SUBJECT);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        bonds.slash(merchant, SUBJECT, attacker);
    }

    function test_RenounceOwnershipIsDisabled() public {
        vm.prank(governance);
        vm.expectRevert(IStakeBondController.OwnershipRenunciationDisabled.selector);
        bonds.renounceOwnership();
    }

    /* ============ Helpers ============ */

    function _fundWallet(address _owner) internal {
        token.transfer(_owner, WALLET);
        vm.prank(_owner);
        token.approve(address(bonds), BOND);
    }
}
