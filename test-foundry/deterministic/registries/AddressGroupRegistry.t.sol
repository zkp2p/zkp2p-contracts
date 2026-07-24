// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract AddressGroupRegistryTest is Test {
    event GroupCreated(uint256 indexed groupId, address indexed curator, string name);
    event GroupCuratorTransferStarted(uint256 indexed groupId, address indexed curator, address indexed pendingCurator);
    event GroupCuratorTransferCancelled(uint256 indexed groupId, address indexed cancelledPendingCurator);
    event GroupCuratorTransferred(uint256 indexed groupId, address indexed previousCurator, address indexed newCurator);
    event MemberAdded(uint256 indexed groupId, address indexed member);
    event MemberRemoved(uint256 indexed groupId, address indexed member);
    event GroupVisibilityChanged(uint256 indexed groupId, bool isPublic);

    AddressGroupRegistry internal registry;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public {
        registry = new AddressGroupRegistry();
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

    function _createGroup(address curator) internal returns (uint256 groupId) {
        vm.prank(curator);
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

    function test_CreateGroupSetsCallerAsCurator() public {
        uint256 groupId = _createGroup(alice);
        (address curator, address pendingCurator, address resolver, bool isPublic, bool exists) =
            registry.getGroup(groupId);
        assertEq(curator, alice);
        assertEq(pendingCurator, address(0));
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

    /* ============ curator transfer lifecycle ============ */

    function test_CuratorStartsTransferAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCuratorTransferStarted(groupId, alice, bob);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        (address curator, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(curator, alice);
        assertEq(pendingCurator, bob);
    }

    function test_NewTransferReplacesPendingCurator() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, carol);
        (, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(pendingCurator, carol);
    }

    function test_TransferToZeroReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, address(0));
    }

    function test_NonCuratorCannotStartTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.transferGroupCurator(groupId, bob);
    }

    function test_TransferOnNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, 7));
        vm.prank(alice);
        registry.transferGroupCurator(7, bob);
    }

    function test_CuratorCancelsPendingTransferAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCuratorTransferCancelled(groupId, bob);
        vm.prank(alice);
        registry.cancelGroupCuratorTransfer(groupId);
        (, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(pendingCurator, address(0));
    }

    function test_CancelWithoutPendingTransferReverts() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.NoPendingTransfer.selector, groupId));
        vm.prank(alice);
        registry.cancelGroupCuratorTransfer(groupId);
    }

    function test_PendingCuratorAcceptsAndEmits() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCuratorTransferred(groupId, alice, bob);
        vm.prank(bob);
        registry.acceptGroupCurator(groupId);
        (address curator, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(curator, bob);
        assertEq(pendingCurator, address(0));
    }

    function test_CannotAcceptCuratorTransferOfNonexistentGroup() public {
        uint256 groupId = 42;
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, groupId));
        registry.acceptGroupCurator(groupId);
    }

    function test_NonPendingCuratorCannotAccept() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedPendingCurator.selector, carol, bob));
        vm.prank(carol);
        registry.acceptGroupCurator(groupId);
    }

    function test_PendingCuratorHasNoAdminRightsBeforeAcceptance() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
    }

    function test_PreviousCuratorHasNoAdminRightsAfterTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.prank(bob);
        registry.acceptGroupCurator(groupId);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, alice, bob));
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
    }

    /* ============ member batches ============ */

    function test_CuratorAddsMembersAndEmitsPerMember() public {
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

    function test_CuratorRemovesMemberAndEmits() public {
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

    function test_NonCuratorCannotMutateMembers() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
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

    /* ============ full admin-surface auth after curator changes ============ */

    function test_PreviousCuratorCannotSetResolverOrRemoveMembersOrTransfer() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.prank(bob);
        registry.acceptGroupCurator(groupId);

        bytes memory expected =
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, alice, bob);
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(carol));
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.setResolver(groupId, address(registry)); // any contract address suffices for the auth check
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, alice);
        vm.expectRevert(expected);
        vm.prank(alice);
        registry.cancelGroupCuratorTransfer(groupId);
    }

    function test_PendingCuratorCannotRemoveMembersOrSetResolver() public {
        uint256 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(carol));
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);

        bytes memory expected =
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice);
        vm.expectRevert(expected);
        vm.prank(bob);
        registry.removeMembers(groupId, _members(carol));
        vm.expectRevert(expected);
        vm.prank(bob);
        registry.setResolver(groupId, address(registry));
    }

    /* ============ visibility ============ */

    function test_CuratorTogglesVisibilityAndEmitsEveryTime() public {
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

    function test_NonCuratorCannotSetVisibility() public {
        uint256 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
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

    function test_CuratorCurationAndSelfServiceComposeOnPublicGroup() public {
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
