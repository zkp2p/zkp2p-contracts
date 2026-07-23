// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract AddressGroupRegistryTest is Test {
    event GroupCreated(uint256 indexed groupId, address indexed owner, string name);
    event GroupOwnershipTransferStarted(uint256 indexed groupId, address indexed owner, address indexed pendingOwner);
    event GroupOwnershipTransferCancelled(uint256 indexed groupId, address indexed cancelledPendingOwner);
    event GroupOwnershipTransferred(uint256 indexed groupId, address indexed previousOwner, address indexed newOwner);
    event MemberAdded(uint256 indexed groupId, address indexed member);
    event MemberRemoved(uint256 indexed groupId, address indexed member);
    event GroupVisibilityChanged(uint256 indexed groupId, bool isPublic);

    AddressGroupRegistry internal registry;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public {
        registry = new AddressGroupRegistry(new IAddressGroupRegistry.GroupSeed[](0));
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
    }

    function _members(address first) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = first;
    }

    function _members(address first, address second) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = first;
        values[1] = second;
    }

    function _createGroup(address owner) internal returns (uint256 groupId) {
        vm.prank(owner);
        groupId = registry.createGroup("test-group");
    }

    /* ============ createGroup ============ */

    function test_CreateGroupAssignsSequentialIdsFromOne() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCreated(1, alice, "test-group");
        uint256 first = _createGroup(alice);
        uint256 second = _createGroup(bob);
        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(registry.groupCount(), 2);
    }

    function test_CreateGroupSetsCallerAsOwner() public {
        uint256 groupId = _createGroup(alice);
        (address owner, address pendingOwner, address resolver, bool isPublic, bool exists) =
            registry.getGroup(groupId);
        assertEq(owner, alice);
        assertEq(pendingOwner, address(0));
        assertEq(resolver, address(0));
        assertFalse(isPublic);
        assertTrue(exists);
    }

    function test_GroupZeroDoesNotExist() public view {
        assertFalse(registry.groupExists(0));
        (,,,, bool exists) = registry.getGroup(0);
        assertFalse(exists);
    }

    function test_UnknownGroupDoesNotExist() public view {
        assertFalse(registry.groupExists(42));
    }

    /* ============ ownership lifecycle ============ */

    function test_OwnerStartsTransferAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupOwnershipTransferStarted(groupId, alice, bob);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        (address owner, address pendingOwner,,,) = registry.getGroup(groupId);
        assertEq(owner, alice);
        assertEq(pendingOwner, bob);
    }

    function test_NewTransferReplacesPendingOwner() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, carol);
        (, address pendingOwner,,,) = registry.getGroup(groupId);
        assertEq(pendingOwner, carol);
    }

    function test_TransferToZeroReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, address(0));
    }

    function test_NonOwnerCannotStartTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.transferGroupOwnership(groupId, bob);
    }

    function test_TransferOnNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, 7));
        vm.prank(alice);
        registry.transferGroupOwnership(7, bob);
    }

    function test_OwnerCancelsPendingTransferAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupOwnershipTransferCancelled(groupId, bob);
        vm.prank(alice);
        registry.cancelGroupOwnershipTransfer(groupId);
        (, address pendingOwner,,,) = registry.getGroup(groupId);
        assertEq(pendingOwner, address(0));
    }

    function test_CancelWithoutPendingTransferReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.NoPendingTransfer.selector, groupId));
        vm.prank(alice);
        registry.cancelGroupOwnershipTransfer(groupId);
    }

    function test_PendingOwnerAcceptsAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupOwnershipTransferred(groupId, alice, bob);
        vm.prank(bob);
        registry.acceptGroupOwnership(groupId);
        (address owner, address pendingOwner,,,) = registry.getGroup(groupId);
        assertEq(owner, bob);
        assertEq(pendingOwner, address(0));
    }

    function test_CannotAcceptOwnershipOfNonexistentGroup() public {
        uint256 groupId = 42;
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, groupId));
        registry.acceptGroupOwnership(groupId);
    }

    function test_NonPendingOwnerCannotAccept() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedPendingOwner.selector, carol, bob));
        vm.prank(carol);
        registry.acceptGroupOwnership(groupId);
    }

    function test_PendingOwnerHasNoAdminRightsBeforeAcceptance() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
    }

    function test_PreviousOwnerHasNoAdminRightsAfterTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.prank(bob);
        registry.acceptGroupOwnership(groupId);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, alice, bob));
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
    }

    /* ============ member batches ============ */

    function test_OwnerAddsMembersAndEmitsPerMember() public {
        uint256 groupId = _createGroup(alice);
        vm.expectEmit(true, true, true, true, address(registry));
        emit MemberAdded(groupId, bob);
        vm.expectEmit(true, true, true, true, address(registry));
        emit MemberAdded(groupId, carol);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob, carol));
        assertTrue(registry.isMember(groupId, bob));
        assertTrue(registry.isMember(groupId, carol));
        assertFalse(registry.isMember(groupId, alice));
    }

    function test_AddExistingMemberIsNoOpWithoutEvent() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        vm.recordLogs();
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_OwnerRemovesMemberAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob, carol));
        vm.expectEmit(true, true, true, true, address(registry));
        emit MemberRemoved(groupId, bob);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(bob));
        assertFalse(registry.isMember(groupId, bob));
        assertTrue(registry.isMember(groupId, carol));
    }

    function test_RemoveAbsentMemberIsNoOpWithoutEvent() public {
        uint256 groupId = _createGroup(alice);
        vm.recordLogs();
        vm.prank(alice);
        registry.removeMembers(groupId, _members(bob));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_EmptyMemberBatchReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.EmptyArray.selector);
        vm.prank(alice);
        registry.addMembers(groupId, new address[](0));
        vm.expectRevert(AddressGroupRegistry.EmptyArray.selector);
        vm.prank(alice);
        registry.removeMembers(groupId, new address[](0));
    }

    function test_ZeroMemberReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.addMembers(groupId, _members(address(0)));
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(address(0)));
    }

    function test_NonOwnerCannotMutateMembers() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.removeMembers(groupId, _members(carol));
    }

    function test_IsMemberOnNonexistentGroupReturnsFalse() public view {
        assertFalse(registry.isMember(99, bob));
    }

    /* ============ batch atomicity and mixed batches ============ */

    function test_ZeroInBatchRevertsWholeTransaction() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob, address(0)));
        assertFalse(registry.isMember(groupId, bob)); // earlier element rolled back

        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(bob, address(0)));
        assertTrue(registry.isMember(groupId, bob)); // removal rolled back
    }

    function test_MixedBatchEmitsOnlyForStateChanges() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        vm.recordLogs();
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob, carol)); // bob existing, carol new
        assertEq(vm.getRecordedLogs().length, 1); // only carol's MemberAdded
        assertTrue(registry.isMember(groupId, carol));
    }

    /* ============ full admin-surface auth after ownership changes ============ */

    function test_PreviousOwnerCannotSetResolverOrRemoveMembersOrTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);
        vm.prank(bob);
        registry.acceptGroupOwnership(groupId);

        bytes memory expected =
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, alice, bob);
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(carol));
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.setResolver(groupId, address(registry)); // any contract address suffices for the auth check
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, alice);
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.cancelGroupOwnershipTransfer(groupId);
    }

    function test_PendingOwnerCannotRemoveMembersOrSetResolver() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
        vm.prank(alice);
        registry.transferGroupOwnership(groupId, bob);

        bytes memory expected =
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice);
        vm.expectRevert(expected);
        vm.prank(bob);
        registry.removeMembers(groupId, _members(carol));
        vm.expectRevert(expected);
        vm.prank(bob);
        registry.setResolver(groupId, address(registry));
    }

    /* ============ visibility ============ */

    function test_OwnerTogglesVisibilityAndEmitsEveryTime() public {
        uint256 groupId = _createGroup(alice);

        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupVisibilityChanged(groupId, true);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);
        (,,, bool isPublic,) = registry.getGroup(groupId);
        assertTrue(isPublic);

        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupVisibilityChanged(groupId, false);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, false);
        (,,, isPublic,) = registry.getGroup(groupId);
        assertFalse(isPublic);

        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupVisibilityChanged(groupId, false);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, false);
    }

    function test_NonOwnerCannotSetVisibility() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.setGroupVisibility(groupId, true);
    }

    function test_SetVisibilityOnNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, 7));
        registry.setGroupVisibility(7, true);
    }

    /* ============ public self-service membership ============ */

    function test_PublicGroupMemberJoinsAndRejoinIsSilent() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);

        vm.expectEmit(true, true, true, true, address(registry));
        emit MemberAdded(groupId, bob);
        vm.prank(bob);
        registry.joinGroup(groupId);
        assertTrue(registry.isMember(groupId, bob));

        vm.recordLogs();
        vm.prank(bob);
        registry.joinGroup(groupId);
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_CuratedMemberJoiningPublicGroupIsSilent() public {
        uint256 groupId = _createGroup(alice);
        vm.startPrank(alice);
        registry.addMembers(groupId, _members(bob));
        registry.setGroupVisibility(groupId, true);
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(bob);
        registry.joinGroup(groupId);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_JoinPrivateGroupReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupNotPublic.selector, groupId));
        vm.prank(bob);
        registry.joinGroup(groupId);
    }

    function test_JoinNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, 7));
        vm.prank(bob);
        registry.joinGroup(7);
    }

    function test_PublicGroupMemberLeavesAndRepeatedLeaveIsSilent() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);
        vm.prank(bob);
        registry.joinGroup(groupId);

        vm.expectEmit(true, true, true, true, address(registry));
        emit MemberRemoved(groupId, bob);
        vm.prank(bob);
        registry.leaveGroup(groupId);
        assertFalse(registry.isMember(groupId, bob));

        vm.recordLogs();
        vm.prank(bob);
        registry.leaveGroup(groupId);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_LeavePrivateGroupRevertsAndKeepsMembership() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);
        vm.prank(bob);
        registry.joinGroup(groupId);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, false);

        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupNotPublic.selector, groupId));
        vm.prank(bob);
        registry.leaveGroup(groupId);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_LeaveNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, 7));
        vm.prank(bob);
        registry.leaveGroup(7);
    }

    function test_VisibilityTransitionsPreserveMembersAndEnableJoining() public {
        uint256 groupId = _createGroup(alice);
        vm.startPrank(alice);
        registry.addMembers(groupId, _members(bob));
        registry.setGroupVisibility(groupId, true);
        registry.setGroupVisibility(groupId, false);
        vm.stopPrank();
        assertTrue(registry.isMember(groupId, bob));

        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);
        vm.prank(carol);
        registry.joinGroup(groupId);
        assertTrue(registry.isMember(groupId, carol));
    }

    function test_OwnerCurationAndSelfServiceComposeOnPublicGroup() public {
        uint256 groupId = _createGroup(alice);
        vm.startPrank(alice);
        registry.setGroupVisibility(groupId, true);
        registry.addMembers(groupId, _members(bob));
        registry.removeMembers(groupId, _members(bob));
        vm.stopPrank();
        assertFalse(registry.isMember(groupId, bob));

        vm.prank(bob);
        registry.joinGroup(groupId);
        assertTrue(registry.isMember(groupId, bob));

        vm.prank(bob);
        registry.leaveGroup(groupId);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        assertTrue(registry.isMember(groupId, bob));
    }
}
