// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IAddressGroupRegistry} from "contracts/interfaces/IAddressGroupRegistry.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract AddressGroupRegistrySeedingTest is Test {
    event GroupCreated(uint256 indexed groupId, address indexed owner, string name);
    event MemberAdded(uint256 indexed groupId, address indexed member);

    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        dave = makeAddr("dave");
    }

    function test_ConstructorSeedsGroupsMembersAndEventsInOrder() public {
        IAddressGroupRegistry.GroupSeed[] memory seeds = new IAddressGroupRegistry.GroupSeed[](3);
        address[] memory firstMembers = new address[](3);
        firstMembers[0] = bob;
        firstMembers[1] = bob;
        firstMembers[2] = carol;
        seeds[0] = IAddressGroupRegistry.GroupSeed("first", alice, true, firstMembers);
        seeds[1] = IAddressGroupRegistry.GroupSeed("second", bob, false, new address[](0));
        seeds[2] = IAddressGroupRegistry.GroupSeed("third", carol, true, _members(dave));

        address expectedRegistry = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit GroupCreated(1, alice, "first");
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit MemberAdded(1, bob);
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit MemberAdded(1, carol);
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit GroupCreated(2, bob, "second");
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit GroupCreated(3, carol, "third");
        vm.expectEmit(true, true, true, true, expectedRegistry);
        emit MemberAdded(3, dave);
        AddressGroupRegistry registry = new AddressGroupRegistry(seeds);

        assertEq(registry.groupCount(), 3);
        (address firstOwner,,, bool firstIsPublic, bool firstExists) = registry.getGroup(1);
        (address secondOwner,,, bool secondIsPublic, bool secondExists) = registry.getGroup(2);
        (address thirdOwner,,, bool thirdIsPublic, bool thirdExists) = registry.getGroup(3);
        assertEq(firstOwner, alice);
        assertTrue(firstIsPublic);
        assertTrue(firstExists);
        assertEq(secondOwner, bob);
        assertFalse(secondIsPublic);
        assertTrue(secondExists);
        assertEq(thirdOwner, carol);
        assertTrue(thirdIsPublic);
        assertTrue(thirdExists);
        assertTrue(registry.isMember(1, bob));
        assertTrue(registry.isMember(1, carol));
        assertTrue(registry.isMember(3, dave));
    }

    function test_EmptySeedsDeploysEmptyRegistry() public {
        AddressGroupRegistry registry =
            new AddressGroupRegistry(new IAddressGroupRegistry.GroupSeed[](0));
        assertEq(registry.groupCount(), 0);
    }

    function test_ZeroOwnerSeedReverts() public {
        IAddressGroupRegistry.GroupSeed[] memory seeds = new IAddressGroupRegistry.GroupSeed[](1);
        seeds[0] = IAddressGroupRegistry.GroupSeed("invalid", address(0), false, new address[](0));
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        new AddressGroupRegistry(seeds);
    }

    function test_ZeroAddressSeedMemberReverts() public {
        IAddressGroupRegistry.GroupSeed[] memory seeds = new IAddressGroupRegistry.GroupSeed[](1);
        seeds[0] = IAddressGroupRegistry.GroupSeed("invalid", alice, false, _members(address(0)));
        vm.expectRevert(AddressGroupRegistry.ZeroAddress.selector);
        new AddressGroupRegistry(seeds);
    }

    function test_PostSeedRegistryBehavesNormallyAndContinuesIds() public {
        IAddressGroupRegistry.GroupSeed[] memory seeds = new IAddressGroupRegistry.GroupSeed[](1);
        seeds[0] = IAddressGroupRegistry.GroupSeed("seeded", alice, false, new address[](0));
        AddressGroupRegistry registry = new AddressGroupRegistry(seeds);

        vm.prank(bob);
        uint256 createdGroupId = registry.createGroup("created");
        assertEq(createdGroupId, 2);

        vm.startPrank(alice);
        registry.addMembers(1, _members(carol));
        registry.setGroupVisibility(1, true);
        vm.stopPrank();
        vm.prank(dave);
        registry.joinGroup(1);
        assertTrue(registry.isMember(1, carol));
        assertTrue(registry.isMember(1, dave));
    }

    function _members(address member) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = member;
    }
}
