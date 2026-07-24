// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract AddressGroupRegistryTest is Test {
    bytes32 internal constant PEERS = keccak256("peers");
    bytes32 internal constant PEER_PLUSES = keccak256("peer-pluses");

    address internal curator;
    address internal replacementCurator;
    address internal member;
    address internal other;

    AddressGroupRegistry internal registry;

    event GroupRegistered(bytes32 indexed groupId, string name, address indexed curator);
    event GroupNameUpdated(bytes32 indexed groupId, string name);
    event GroupCuratorUpdated(bytes32 indexed groupId, address indexed previousCurator, address indexed newCurator);
    event GroupActiveUpdated(bytes32 indexed groupId, bool active);
    event MemberAdded(bytes32 indexed groupId, address indexed member);
    event MemberRemoved(bytes32 indexed groupId, address indexed member);

    function setUp() public {
        curator = makeAddr("curator");
        replacementCurator = makeAddr("replacementCurator");
        member = makeAddr("member");
        other = makeAddr("other");

        registry = new AddressGroupRegistry(address(this));
        registry.registerGroup(PEERS, "Peers", curator);
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        new AddressGroupRegistry(address(0));
    }

    function test_GovernanceRegistersStableDiscoverableGroup() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit GroupRegistered(PEER_PLUSES, "Peer Pluses", replacementCurator);
        registry.registerGroup(PEER_PLUSES, "Peer Pluses", replacementCurator);

        assertEq(registry.groupCount(), 2);
        assertEq(registry.groupIdAt(0), PEERS);
        assertEq(registry.groupIdAt(1), PEER_PLUSES);
        assertTrue(registry.groupExists(PEER_PLUSES));
        assertTrue(registry.isGroupActive(PEER_PLUSES));

        IAddressGroupRegistry.Group memory group = registry.getGroup(PEER_PLUSES);
        assertEq(group.name, "Peer Pluses");
        assertEq(group.curator, replacementCurator);
        assertTrue(group.active);
        assertTrue(group.exists);
    }

    function test_RegisterValidatesStableIdMetadataAndCurator() public {
        vm.expectRevert(AddressGroupRegistry.ZeroGroupId.selector);
        registry.registerGroup(bytes32(0), "Invalid", curator);

        vm.expectRevert(AddressGroupRegistry.EmptyGroupName.selector);
        registry.registerGroup(PEER_PLUSES, "", curator);

        string memory longName = "This group name is intentionally longer than the protocol maximum of sixty-four bytes";
        vm.expectRevert(
            abi.encodeWithSelector(
                AddressGroupRegistry.GroupNameTooLong.selector, bytes(longName).length, registry.MAX_GROUP_NAME_LENGTH()
            )
        );
        registry.registerGroup(PEER_PLUSES, longName, curator);

        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        registry.registerGroup(PEER_PLUSES, "Peer Pluses", address(0));

        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupAlreadyExists.selector, PEERS));
        registry.registerGroup(PEERS, "Duplicate", curator);
    }

    function test_OnlyGovernanceManagesMetadataCuratorAndActiveState() public {
        vm.startPrank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.registerGroup(PEER_PLUSES, "Peer Pluses", other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.setGroupName(PEERS, "Renamed");
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.setGroupCurator(PEERS, other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.setGroupActive(PEERS, false);
        vm.stopPrank();
    }

    function test_GovernanceUpdatesMetadataCuratorAndActiveState() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit GroupNameUpdated(PEERS, "Verified Peers");
        registry.setGroupName(PEERS, "Verified Peers");

        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupCuratorUpdated(PEERS, curator, replacementCurator);
        registry.setGroupCurator(PEERS, replacementCurator);

        vm.expectEmit(true, false, false, true, address(registry));
        emit GroupActiveUpdated(PEERS, false);
        registry.setGroupActive(PEERS, false);

        IAddressGroupRegistry.Group memory group = registry.getGroup(PEERS);
        assertEq(group.name, "Verified Peers");
        assertEq(group.curator, replacementCurator);
        assertFalse(group.active);

        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupAlreadyInState.selector, PEERS, false));
        registry.setGroupActive(PEERS, false);
    }

    function test_OnlyAssignedCuratorManagesMembership() public {
        address[] memory members = _addresses(member);

        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedCurator.selector, other, curator));
        vm.prank(other);
        registry.addMembers(PEERS, members);

        vm.expectRevert(
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedCurator.selector, address(this), curator)
        );
        registry.addMembers(PEERS, members);

        vm.expectEmit(true, true, false, true, address(registry));
        emit MemberAdded(PEERS, member);
        vm.prank(curator);
        registry.addMembers(PEERS, members);
        assertTrue(registry.isMember(PEERS, member));

        vm.expectEmit(true, true, false, true, address(registry));
        emit MemberRemoved(PEERS, member);
        vm.prank(curator);
        registry.removeMembers(PEERS, members);
        assertFalse(registry.isMember(PEERS, member));
    }

    function test_CuratorReplacementTakesEffectImmediately() public {
        registry.setGroupCurator(PEERS, replacementCurator);
        address[] memory members = _addresses(member);

        vm.expectRevert(
            abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedCurator.selector, curator, replacementCurator)
        );
        vm.prank(curator);
        registry.addMembers(PEERS, members);

        vm.prank(replacementCurator);
        registry.addMembers(PEERS, members);
        assertTrue(registry.isMember(PEERS, member));
    }

    function test_MembershipWritesAreIdempotentAndBatchAtomic() public {
        address[] memory duplicateMembers = new address[](2);
        duplicateMembers[0] = member;
        duplicateMembers[1] = member;
        vm.prank(curator);
        registry.addMembers(PEERS, duplicateMembers);
        assertTrue(registry.isMember(PEERS, member));

        vm.recordLogs();
        vm.prank(curator);
        registry.addMembers(PEERS, _addresses(member));
        assertEq(vm.getRecordedLogs().length, 0);

        address[] memory invalidMembers = new address[](2);
        invalidMembers[0] = other;
        invalidMembers[1] = address(0);
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        vm.prank(curator);
        registry.addMembers(PEERS, invalidMembers);
        assertFalse(registry.isMember(PEERS, other));
    }

    function test_EmptyMembershipBatchAndUnknownGroupRevert() public {
        vm.expectRevert(AddressGroupRegistry.EmptyArray.selector);
        vm.prank(curator);
        registry.addMembers(PEERS, new address[](0));

        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.GroupDoesNotExist.selector, PEER_PLUSES));
        vm.prank(curator);
        registry.addMembers(PEER_PLUSES, _addresses(member));
    }

    function test_InactiveGroupFailsClosedWithoutDeletingMembership() public {
        vm.prank(curator);
        registry.addMembers(PEERS, _addresses(member));
        assertTrue(registry.isMember(PEERS, member));

        registry.setGroupActive(PEERS, false);
        assertFalse(registry.isMember(PEERS, member));

        registry.setGroupActive(PEERS, true);
        assertTrue(registry.isMember(PEERS, member));
    }

    function test_UnknownGroupViewsFailClosed() public view {
        assertFalse(registry.groupExists(PEER_PLUSES));
        assertFalse(registry.isGroupActive(PEER_PLUSES));
        assertFalse(registry.isMember(PEER_PLUSES, member));

        IAddressGroupRegistry.Group memory group = registry.getGroup(PEER_PLUSES);
        assertFalse(group.exists);
        assertEq(group.curator, address(0));
    }

    function _addresses(address _member) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = _member;
    }
}
