// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract AddressGroupRegistryTest is Test {
    event GroupCreated(bytes32 indexed groupId, address indexed curator, string name);
    event GroupCuratorTransferStarted(bytes32 indexed groupId, address indexed curator, address indexed pendingCurator);
    event GroupCuratorTransferCancelled(bytes32 indexed groupId, address indexed cancelledPendingCurator);
    event GroupCuratorTransferred(bytes32 indexed groupId, address indexed previousCurator, address indexed newCurator);
    event MemberAdded(bytes32 indexed groupId, address indexed member);
    event MemberRemoved(bytes32 indexed groupId, address indexed member);
    event GroupVisibilityChanged(bytes32 indexed groupId, bool isPublic);

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

    function _createGroup(address curator) internal returns (bytes32 groupId) {
        vm.prank(curator);
        groupId = registry.createGroup("test-group");
    }

    /* ============ createGroup ============ */

    function test_CreateGroupDerivesIdsFromCuratorAndGlobalCounter() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCreated(keccak256(abi.encode(alice, uint256(0))), alice, "test-group");
        bytes32 first = _createGroup(alice);
        bytes32 second = _createGroup(bob);
        assertEq(first, keccak256(abi.encode(alice, uint256(0))));
        assertEq(second, keccak256(abi.encode(bob, uint256(1))));
        assertEq(registry.groupCount(), 2);
    }

    function test_CreateGroupSetsCallerAsCurator() public {
        bytes32 groupId = _createGroup(alice);
        (address curator, address pendingCurator, address resolver, bool isPublic, bool exists) =
            registry.getGroup(groupId);
        assertEq(curator, alice);
        assertEq(pendingCurator, address(0));
        assertEq(resolver, address(0));
        assertFalse(isPublic);
        assertTrue(exists);
    }

    function test_GroupZeroDoesNotExist() public view {
        assertFalse(registry.groupExists(bytes32(0)));
        (,,,, bool exists) = registry.getGroup(bytes32(0));
        assertFalse(exists);
    }

    function test_UnknownGroupDoesNotExist() public view {
        assertFalse(registry.groupExists(bytes32(uint256(42))));
    }

    /* ============ curator transfer lifecycle ============ */

    function test_CuratorStartsTransferAndEmits() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCuratorTransferStarted(groupId, alice, bob);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        (address curator, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(curator, alice);
        assertEq(pendingCurator, bob);
    }

    function test_NewTransferReplacesPendingCurator() public {
        bytes32 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, carol);
        (, address pendingCurator,,,) = registry.getGroup(groupId);
        assertEq(pendingCurator, carol);
    }

    function test_TransferToZeroReverts() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, address(0));
    }

    function test_NonCuratorCannotStartTransfer() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.transferGroupCurator(groupId, bob);
    }

    function test_TransferOnNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, bytes32(uint256(7))));
        vm.prank(alice);
        registry.transferGroupCurator(bytes32(uint256(7)), bob);
    }

    function test_CuratorCancelsPendingTransferAndEmits() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.NoPendingTransfer.selector, groupId));
        vm.prank(alice);
        registry.cancelGroupCuratorTransfer(groupId);
    }

    function test_PendingCuratorAcceptsAndEmits() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = bytes32(uint256(42));
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, groupId));
        registry.acceptGroupCurator(groupId);
    }

    function test_NonPendingCuratorCannotAccept() public {
        bytes32 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedPendingCurator.selector, carol, bob));
        vm.prank(carol);
        registry.acceptGroupCurator(groupId);
    }

    function test_PendingCuratorHasNoAdminRightsBeforeAcceptance() public {
        bytes32 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.transferGroupCurator(groupId, bob);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
    }

    function test_PreviousCuratorHasNoAdminRightsAfterTransfer() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        vm.recordLogs();
        vm.prank(alice);
        registry.addMembers(groupId, _members(bob));
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_CuratorRemovesMemberAndEmits() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
        vm.recordLogs();
        vm.prank(alice);
        registry.removeMembers(groupId, _members(bob));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_EmptyMemberBatchReverts() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.EmptyArray.selector);
        vm.prank(alice);
        registry.addMembers(groupId, new address[](0));
        vm.expectRevert(AddressGroupRegistry.EmptyArray.selector);
        vm.prank(alice);
        registry.removeMembers(groupId, new address[](0));
    }

    function test_ZeroMemberReverts() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.addMembers(groupId, _members(address(0)));
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(alice);
        registry.removeMembers(groupId, _members(address(0)));
    }

    function test_NonCuratorCannotMutateMembers() public {
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.addMembers(groupId, _members(carol));
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.removeMembers(groupId, _members(carol));
    }

    function test_IsMemberOnNonexistentGroupReturnsFalse() public view {
        assertFalse(registry.isMember(bytes32(uint256(99)), bob));
    }

    /* ============ batch atomicity and mixed batches ============ */

    function test_ZeroInBatchRevertsWholeTransaction() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);

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
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupCurator.selector, bob, alice));
        vm.prank(bob);
        registry.setGroupVisibility(groupId, true);
    }

    function test_SetVisibilityOnNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, bytes32(uint256(7))));
        registry.setGroupVisibility(bytes32(uint256(7)), true);
    }

    /* ============ public self-service membership ============ */

    function test_PublicGroupMemberJoinsAndRejoinIsSilent() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupNotPublic.selector, groupId));
        vm.prank(bob);
        registry.joinGroup(groupId);
    }

    function test_JoinNonexistentGroupReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, bytes32(uint256(7))));
        vm.prank(bob);
        registry.joinGroup(bytes32(uint256(7)));
    }

    function test_PublicGroupMemberLeavesAndRepeatedLeaveIsSilent() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, bytes32(uint256(7))));
        vm.prank(bob);
        registry.leaveGroup(bytes32(uint256(7)));
    }

    function test_VisibilityTransitionsPreserveMembersAndEnableJoining() public {
        bytes32 groupId = _createGroup(alice);
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
        bytes32 groupId = _createGroup(alice);
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
