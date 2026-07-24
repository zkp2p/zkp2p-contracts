// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {MakerGroupPolicy} from "contracts/risk/MakerGroupPolicy.sol";

contract MakerGroupPolicyTest is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant PEERS = keccak256("peers");
    bytes32 internal constant PEER_PLUSES = keccak256("peer-pluses");
    bytes32 internal constant PEER_MERCHANTS = keccak256("peer-merchants");

    address internal maker;
    address internal otherMaker;
    address internal curator;

    AddressGroupRegistry internal registry;
    MakerGroupPolicy internal policy;

    event GroupsEnabledUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event AllowedGroupAdded(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);
    event AllowedGroupRemoved(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);

    function setUp() public {
        maker = makeAddr("maker");
        otherMaker = makeAddr("otherMaker");
        curator = makeAddr("curator");

        registry = new AddressGroupRegistry(address(this));
        registry.registerGroup(PEERS, "Peers", curator);
        registry.registerGroup(PEER_PLUSES, "Peer Pluses", curator);
        registry.registerGroup(PEER_MERCHANTS, "Peer Merchants", curator);
        policy = new MakerGroupPolicy(registry);
    }

    function test_ConstructorRejectsZeroAndCodelessRegistry() public {
        vm.expectRevert(MakerGroupPolicy.ZeroAddress.selector);
        new MakerGroupPolicy(AddressGroupRegistry(address(0)));

        vm.expectRevert(abi.encodeWithSelector(MakerGroupPolicy.InvalidGroupRegistry.selector, maker));
        new MakerGroupPolicy(AddressGroupRegistry(maker));
    }

    function test_MakerTogglesEnforcementPerPaymentMethod() public {
        vm.expectEmit(true, true, false, true, address(policy));
        emit GroupsEnabledUpdated(maker, VENMO, true);
        vm.prank(maker);
        policy.setGroupsEnabled(VENMO, true);

        assertTrue(policy.groupsEnabled(maker, VENMO));
        assertFalse(policy.groupsEnabled(maker, PAYPAL));
        assertFalse(policy.groupsEnabled(otherMaker, VENMO));

        vm.prank(maker);
        policy.setGroupsEnabled(VENMO, false);
        assertFalse(policy.groupsEnabled(maker, VENMO));
    }

    function test_EnabledEmptyPolicyIsPersistedForFailClosedEvaluation() public {
        vm.prank(maker);
        policy.setGroupsEnabled(VENMO, true);

        assertTrue(policy.groupsEnabled(maker, VENMO));
        assertEq(policy.getAllowedGroups(maker, VENMO).length, 0);
    }

    function test_MakerAddsAndRemovesGroupsWithEnumerableViews() public {
        bytes32[] memory groups = _groupIds(PEERS, PEER_PLUSES);

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(maker, VENMO, PEERS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(maker, VENMO, PEER_PLUSES);
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, groups);

        assertTrue(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEER_PLUSES));
        assertEq(policy.getAllowedGroups(maker, VENMO), groups);

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupRemoved(maker, VENMO, PEERS);
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, _groupIds(PEERS));

        bytes32[] memory remaining = policy.getAllowedGroups(maker, VENMO);
        assertEq(remaining.length, 1);
        assertEq(remaining[0], PEER_PLUSES);
        assertFalse(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEER_PLUSES));
    }

    function test_MakerNamespacesAndPaymentMethodsAreIsolated() public {
        vm.startPrank(maker);
        policy.setGroupsEnabled(VENMO, true);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));
        policy.addAllowedGroups(PAYPAL, _groupIds(PEER_PLUSES));
        vm.stopPrank();

        vm.startPrank(otherMaker);
        policy.setGroupsEnabled(PAYPAL, true);
        policy.addAllowedGroups(PAYPAL, _groupIds(PEER_MERCHANTS));
        vm.stopPrank();

        assertTrue(policy.groupsEnabled(maker, VENMO));
        assertFalse(policy.groupsEnabled(maker, PAYPAL));
        assertFalse(policy.groupsEnabled(otherMaker, VENMO));
        assertTrue(policy.groupsEnabled(otherMaker, PAYPAL));

        assertTrue(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertFalse(policy.isGroupAllowed(maker, PAYPAL, PEERS));
        assertTrue(policy.isGroupAllowed(maker, PAYPAL, PEER_PLUSES));
        assertFalse(policy.isGroupAllowed(otherMaker, PAYPAL, PEER_PLUSES));
        assertTrue(policy.isGroupAllowed(otherMaker, PAYPAL, PEER_MERCHANTS));
    }

    function test_DuplicateAddAndMissingRemoveAreIdempotent() public {
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));

        vm.recordLogs();
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(policy.getAllowedGroups(maker, VENMO).length, 1);

        vm.recordLogs();
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, _groupIds(PEER_PLUSES));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(policy.getAllowedGroups(maker, VENMO).length, 1);
    }

    function test_AddRejectsUnknownOrInactiveGroupAtomically() public {
        bytes32 unknownGroup = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(MakerGroupPolicy.GroupDoesNotExist.selector, unknownGroup));
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(unknownGroup));

        registry.setGroupActive(PEER_PLUSES, false);
        vm.expectRevert(abi.encodeWithSelector(MakerGroupPolicy.GroupNotActive.selector, PEER_PLUSES));
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS, PEER_PLUSES));

        assertEq(policy.getAllowedGroups(maker, VENMO).length, 0);
    }

    function test_ExistingPolicySurvivesRegistryDeactivation() public {
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));

        registry.setGroupActive(PEERS, false);
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertEq(policy.getAllowedGroups(maker, VENMO).length, 1);

        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, _groupIds(PEERS));
        assertFalse(policy.isGroupAllowed(maker, VENMO, PEERS));
    }

    function test_MaximumGroupCountBoundsAdmissionIteration() public {
        bytes32[] memory firstTen = new bytes32[](10);
        for (uint256 i = 0; i < firstTen.length; i++) {
            bytes32 groupId = keccak256(abi.encode("group", i));
            registry.registerGroup(groupId, "Curated Group", curator);
            firstTen[i] = groupId;
        }

        vm.prank(maker);
        policy.addAllowedGroups(VENMO, firstTen);
        assertEq(policy.getAllowedGroups(maker, VENMO).length, policy.MAX_GROUPS_PER_PAYMENT_METHOD());

        bytes32 eleventh = keccak256("eleventh");
        registry.registerGroup(eleventh, "Eleventh Group", curator);
        vm.expectRevert(
            abi.encodeWithSelector(
                MakerGroupPolicy.TooManyGroups.selector,
                policy.MAX_GROUPS_PER_PAYMENT_METHOD() + 1,
                policy.MAX_GROUPS_PER_PAYMENT_METHOD()
            )
        );
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(eleventh));
    }

    function test_ValidatesPaymentMethodAndBatchSize() public {
        vm.expectRevert(MakerGroupPolicy.ZeroPaymentMethod.selector);
        vm.prank(maker);
        policy.setGroupsEnabled(bytes32(0), true);

        vm.expectRevert(MakerGroupPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, new bytes32[](0));

        vm.expectRevert(MakerGroupPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, new bytes32[](0));

        bytes32[] memory oversized = new bytes32[](11);
        vm.expectRevert(abi.encodeWithSelector(MakerGroupPolicy.TooManyGroups.selector, 11, 10));
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, oversized);
    }

    function _groupIds(bytes32 _first) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](1);
        groupIds[0] = _first;
    }

    function _groupIds(bytes32 _first, bytes32 _second) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](2);
        groupIds[0] = _first;
        groupIds[1] = _second;
    }
}
