// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {EscrowDepositorMock} from "../../mocks/EscrowDepositorMock.sol";
import {WhitelistPolicyV2} from "contracts/hooks/WhitelistPolicyV2.sol";
import {IWhitelistPolicyV2} from "contracts/interfaces/IWhitelistPolicyV2.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract WhitelistPolicyV2Test is Test {
    uint256 internal constant DEPOSIT_ONE = 1;
    uint256 internal constant DEPOSIT_TWO = 2;
    uint256 internal constant UNKNOWN_DEPOSIT = 99;

    bytes32 internal GROUP;
    bytes32 internal OTHER_GROUP;

    address internal maker;
    address internal member;
    address internal direct;
    address internal stranger;

    AddressGroupRegistry internal registry;
    EscrowDepositorMock internal escrow;
    EscrowDepositorMock internal otherEscrow;
    WhitelistPolicyV2 internal policy;

    event EnabledUpdated(address indexed escrow, uint256 indexed depositId, bool enabled);
    event GroupUpdated(address indexed escrow, uint256 indexed depositId, bytes32 indexed groupId, bool allowed);
    event TakerUpdated(address indexed escrow, uint256 indexed depositId, address indexed taker, bool allowed);

    function setUp() public {
        maker = makeAddr("maker");
        member = makeAddr("member");
        direct = makeAddr("direct");
        stranger = makeAddr("stranger");

        registry = new AddressGroupRegistry();
        GROUP = registry.createGroup("Group");
        OTHER_GROUP = registry.createGroup("Other group");
        registry.addMembers(GROUP, _addresses(member));
        registry.addMembers(OTHER_GROUP, _addresses(member));

        escrow = new EscrowDepositorMock();
        otherEscrow = new EscrowDepositorMock();
        escrow.setDepositor(DEPOSIT_ONE, maker);
        escrow.setDepositor(DEPOSIT_TWO, maker);
        otherEscrow.setDepositor(DEPOSIT_ONE, maker);

        policy = new WhitelistPolicyV2(registry);

        vm.startPrank(maker);
        policy.setGroups(address(escrow), DEPOSIT_ONE, _groupIds(GROUP), true);
        policy.setTakers(address(escrow), DEPOSIT_ONE, _addresses(direct), true);
        vm.stopPrank();
    }

    /* ============ Depositor Functions ============ */

    function test_SettersStoreAndEmitTheWrittenValues() public {
        vm.startPrank(maker);

        vm.expectEmit(true, true, false, true, address(policy));
        emit EnabledUpdated(address(escrow), DEPOSIT_TWO, true);
        policy.setEnabled(address(escrow), DEPOSIT_TWO, true);

        vm.expectEmit(true, true, true, true, address(policy));
        emit GroupUpdated(address(escrow), DEPOSIT_TWO, OTHER_GROUP, true);
        policy.setGroups(address(escrow), DEPOSIT_TWO, _groupIds(OTHER_GROUP), true);

        vm.expectEmit(true, true, true, true, address(policy));
        emit TakerUpdated(address(escrow), DEPOSIT_TWO, stranger, true);
        policy.setTakers(address(escrow), DEPOSIT_TWO, _addresses(stranger), true);

        vm.stopPrank();

        assertTrue(policy.enabled(address(escrow), DEPOSIT_TWO));
        assertTrue(policy.allowedGroups(address(escrow), DEPOSIT_TWO, OTHER_GROUP));
        assertTrue(policy.allowedTakers(address(escrow), DEPOSIT_TWO, stranger));
    }

    function test_SettersRejectAnyoneButTheDepositor() public {
        vm.startPrank(stranger);

        vm.expectRevert(abi.encodeWithSelector(IWhitelistPolicyV2.NotDepositor.selector, address(escrow), DEPOSIT_ONE, stranger));
        policy.setEnabled(address(escrow), DEPOSIT_ONE, true);

        vm.expectRevert(abi.encodeWithSelector(IWhitelistPolicyV2.NotDepositor.selector, address(escrow), DEPOSIT_ONE, stranger));
        policy.setGroups(address(escrow), DEPOSIT_ONE, _groupIds(OTHER_GROUP), true);

        vm.expectRevert(abi.encodeWithSelector(IWhitelistPolicyV2.NotDepositor.selector, address(escrow), DEPOSIT_ONE, stranger));
        policy.setTakers(address(escrow), DEPOSIT_ONE, _addresses(stranger), true);

        vm.stopPrank();
    }

    function test_SettersRejectAnUnknownDeposit() public {
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(IWhitelistPolicyV2.NotDepositor.selector, address(escrow), UNKNOWN_DEPOSIT, maker));
        policy.setEnabled(address(escrow), UNKNOWN_DEPOSIT, true);
    }

    /* ============ isWhitelisted ============ */

    function test_DirectTakersAreWhitelistedWithoutAGroup() public view {
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, direct, bytes32(0)));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, stranger, bytes32(0)));
        // A member is whitelisted only through the group it names.
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, bytes32(0)));
    }

    function test_MembersAreWhitelistedThroughAnAllowedGroupTheyName() public {
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, GROUP));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, OTHER_GROUP));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, stranger, GROUP));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, direct, GROUP));

        bytes32 unknownGroup = keccak256("unknown group");
        vm.prank(maker);
        policy.setGroups(address(escrow), DEPOSIT_ONE, _groupIds(unknownGroup), true);
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, unknownGroup));
    }

    function test_IsWhitelistedDoesNotDependOnEnabled() public {
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, true);

        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, direct, bytes32(0)));
        assertTrue(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, GROUP));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, stranger, bytes32(0)));
    }

    function test_RemovedGroupsAndTakersAreNoLongerWhitelisted() public {
        vm.startPrank(maker);
        policy.setGroups(address(escrow), DEPOSIT_ONE, _groupIds(GROUP), false);
        policy.setTakers(address(escrow), DEPOSIT_ONE, _addresses(direct), false);
        vm.stopPrank();

        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, GROUP));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, direct, bytes32(0)));
    }

    function test_RemovingAMemberFromTheGroupRevokesIt() public {
        registry.removeMembers(GROUP, _addresses(member));

        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_ONE, member, GROUP));
    }

    function test_ConfigIsScopedToTheEscrowAndDeposit() public {
        vm.prank(maker);
        policy.setEnabled(address(escrow), DEPOSIT_ONE, true);

        assertFalse(policy.enabled(address(escrow), DEPOSIT_TWO));
        assertFalse(policy.enabled(address(otherEscrow), DEPOSIT_ONE));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_TWO, direct, bytes32(0)));
        assertFalse(policy.isWhitelisted(address(escrow), DEPOSIT_TWO, member, GROUP));
        assertFalse(policy.isWhitelisted(address(otherEscrow), DEPOSIT_ONE, direct, bytes32(0)));
        assertFalse(policy.isWhitelisted(address(otherEscrow), DEPOSIT_ONE, member, GROUP));
    }

    /* ============ Helpers ============ */

    function _groupIds(bytes32 _groupId) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](1);
        groupIds[0] = _groupId;
    }

    function _addresses(address _account) internal pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = _account;
    }
}
