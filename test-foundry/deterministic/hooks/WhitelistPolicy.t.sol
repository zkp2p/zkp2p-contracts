// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";

contract WhitelistPolicyTest is Test {
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant ZELLE = keccak256("zelle");

    bytes32 internal PEERS;
    bytes32 internal PEER_PLUSES;
    bytes32 internal PEER_MERCHANTS;

    address internal maker;
    address internal otherMaker;
    address internal taker;
    address internal otherTaker;

    AddressGroupRegistry internal registry;
    WhitelistPolicy internal policy;

    event EnabledUpdated(address indexed maker, bytes32 indexed paymentMethod, bool enabled);
    event AddressWhitelisted(address indexed maker, address indexed taker);
    event AddressRemovedFromWhitelist(address indexed maker, address indexed taker);
    event AllowedGroupAdded(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);
    event AllowedGroupRemoved(address indexed maker, bytes32 indexed paymentMethod, bytes32 indexed groupId);

    function setUp() public {
        maker = makeAddr("maker");
        otherMaker = makeAddr("otherMaker");
        taker = makeAddr("taker");
        otherTaker = makeAddr("otherTaker");
        registry = new AddressGroupRegistry();
        PEERS = registry.createGroup("Peers");
        PEER_PLUSES = registry.createGroup("Peer Pluses");
        PEER_MERCHANTS = registry.createGroup("Peer Merchants");
        policy = new WhitelistPolicy(registry);
    }

    function test_ConstructorRejectsZeroAndCodelessRegistry() public {
        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        new WhitelistPolicy(AddressGroupRegistry(address(0)));

        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.InvalidGroupRegistry.selector, maker));
        new WhitelistPolicy(AddressGroupRegistry(maker));
    }

    function test_SetEnabledIsScopedToMakerAndPaymentMethod() public {
        vm.expectEmit(true, true, false, true, address(policy));
        emit EnabledUpdated(maker, VENMO, true);
        vm.prank(maker);
        policy.setEnabled(VENMO, true);

        assertTrue(policy.enabled(maker, VENMO));
        assertFalse(policy.enabled(maker, ZELLE));
        assertFalse(policy.enabled(otherMaker, VENMO));

        vm.prank(maker);
        policy.setEnabled(VENMO, false);
        assertFalse(policy.enabled(maker, VENMO));
    }

    function test_AddWhitelistedAddressesIsIdempotentAndEnumerableByGetter() public {
        address[] memory takers = _addresses(taker, otherTaker);

        vm.expectEmit(true, true, false, true, address(policy));
        emit AddressWhitelisted(maker, taker);
        vm.expectEmit(true, true, false, true, address(policy));
        emit AddressWhitelisted(maker, otherTaker);
        vm.prank(maker);
        policy.addWhitelistedAddresses(takers);

        assertTrue(policy.isWhitelisted(maker, taker));
        assertTrue(policy.isWhitelisted(maker, otherTaker));
        assertFalse(policy.isWhitelisted(otherMaker, taker));

        vm.recordLogs();
        vm.prank(maker);
        policy.addWhitelistedAddresses(takers);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_AddWhitelistedAddressesRejectsEmptyArrayAndZeroAddress() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.addWhitelistedAddresses(new address[](0));

        vm.expectRevert(WhitelistPolicy.ZeroAddress.selector);
        vm.prank(maker);
        policy.addWhitelistedAddresses(_addresses(taker, address(0)));

        assertFalse(policy.isWhitelisted(maker, taker));
    }

    function test_RemoveWhitelistedAddressesIsIdempotent() public {
        vm.prank(maker);
        policy.addWhitelistedAddresses(_addresses(taker, otherTaker));

        vm.expectEmit(true, true, false, true, address(policy));
        emit AddressRemovedFromWhitelist(maker, taker);
        vm.prank(maker);
        policy.removeWhitelistedAddresses(_addresses(taker));

        assertFalse(policy.isWhitelisted(maker, taker));
        assertTrue(policy.isWhitelisted(maker, otherTaker));

        vm.recordLogs();
        vm.prank(maker);
        policy.removeWhitelistedAddresses(_addresses(taker));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_RemoveWhitelistedAddressesRejectsEmptyArray() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.removeWhitelistedAddresses(new address[](0));
    }

    function test_AddAllowedGroupsSupportsViewsAndDeduplicates() public {
        bytes32[] memory groups = _groupIds(PEERS, PEER_PLUSES);

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(maker, VENMO, PEERS);
        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupAdded(maker, VENMO, PEER_PLUSES);
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, groups);

        assertEq(policy.getAllowedGroups(maker, VENMO), groups);
        assertEq(policy.getAllowedGroups(maker, ZELLE).length, 0);
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEER_PLUSES));
        assertFalse(policy.isGroupAllowed(maker, ZELLE, PEERS));
        assertFalse(policy.isGroupAllowed(otherMaker, VENMO, PEERS));

        vm.recordLogs();
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, groups);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(policy.getAllowedGroups(maker, VENMO).length, 2);
    }

    function test_AddAllowedGroupsRejectsEmptyAndUnknownGroups() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, new bytes32[](0));

        bytes32 unknownGroup = bytes32(uint256(999));
        vm.expectRevert(abi.encodeWithSelector(WhitelistPolicy.GroupDoesNotExist.selector, unknownGroup));
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(unknownGroup));

        assertEq(policy.getAllowedGroups(maker, VENMO).length, 0);
    }

    function test_AddAllowedGroupsRejectsEleventhUniqueGroup() public {
        bytes32[] memory firstTen = new bytes32[](10);
        for (uint256 i = 0; i < firstTen.length; ++i) {
            firstTen[i] = registry.createGroup("Curated Group");
        }

        vm.prank(maker);
        policy.addAllowedGroups(VENMO, firstTen);
        assertEq(policy.getAllowedGroups(maker, VENMO).length, policy.MAX_GROUPS_PER_PAYMENT_METHOD());

        bytes32 eleventh = registry.createGroup("Eleventh Group");
        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistPolicy.TooManyGroups.selector,
                policy.MAX_GROUPS_PER_PAYMENT_METHOD() + 1,
                policy.MAX_GROUPS_PER_PAYMENT_METHOD()
            )
        );
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(eleventh));

        vm.prank(maker);
        policy.addAllowedGroups(ZELLE, _groupIds(eleventh));
        assertTrue(policy.isGroupAllowed(maker, ZELLE, eleventh));
    }

    function test_RemoveAllowedGroupsUsesSwapAndPopAndIsIdempotent() public {
        vm.prank(maker);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS, PEER_PLUSES, PEER_MERCHANTS));

        vm.expectEmit(true, true, true, true, address(policy));
        emit AllowedGroupRemoved(maker, VENMO, PEERS);
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, _groupIds(PEERS));

        bytes32[] memory remaining = policy.getAllowedGroups(maker, VENMO);
        assertEq(remaining.length, 2);
        assertEq(remaining[0], PEER_MERCHANTS);
        assertEq(remaining[1], PEER_PLUSES);
        assertFalse(policy.isGroupAllowed(maker, VENMO, PEERS));
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEER_PLUSES));
        assertTrue(policy.isGroupAllowed(maker, VENMO, PEER_MERCHANTS));

        vm.recordLogs();
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, _groupIds(PEERS));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_RemoveAllowedGroupsRejectsEmptyArray() public {
        vm.expectRevert(WhitelistPolicy.EmptyArray.selector);
        vm.prank(maker);
        policy.removeAllowedGroups(VENMO, new bytes32[](0));
    }

    function test_IsTakerAllowedReturnsTrueWhenPolicyDisabled() public view {
        assertTrue(policy.isTakerAllowed(maker, VENMO, taker));
    }

    function test_DirectWhitelistIsMakerWideAcrossEnabledPaymentMethods() public {
        vm.startPrank(maker);
        policy.setEnabled(VENMO, true);
        policy.setEnabled(ZELLE, true);
        policy.addWhitelistedAddresses(_addresses(taker));
        vm.stopPrank();

        assertTrue(policy.isTakerAllowed(maker, VENMO, taker));
        assertTrue(policy.isTakerAllowed(maker, ZELLE, taker));
    }

    function test_GroupAdmissionIsScopedToPaymentMethod() public {
        vm.startPrank(maker);
        policy.setEnabled(VENMO, true);
        policy.setEnabled(ZELLE, true);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));
        vm.stopPrank();
        registry.addMembers(PEERS, _addresses(taker));

        assertTrue(policy.isTakerAllowed(maker, VENMO, taker));
        assertFalse(policy.isTakerAllowed(maker, ZELLE, taker));
    }

    function test_IsTakerAllowedReturnsFalseForEnabledEmptyPolicy() public {
        vm.prank(maker);
        policy.setEnabled(VENMO, true);

        assertFalse(policy.isTakerAllowed(maker, VENMO, taker));
        assertTrue(policy.isTakerAllowed(maker, ZELLE, taker));
    }

    function test_IsTakerAllowedReturnsFalseForNonMember() public {
        vm.startPrank(maker);
        policy.setEnabled(VENMO, true);
        policy.addAllowedGroups(VENMO, _groupIds(PEERS));
        vm.stopPrank();

        assertFalse(policy.isTakerAllowed(maker, VENMO, taker));
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

    function _groupIds(bytes32 _first, bytes32 _second, bytes32 _third)
        internal
        pure
        returns (bytes32[] memory groupIds)
    {
        groupIds = new bytes32[](3);
        groupIds[0] = _first;
        groupIds[1] = _second;
        groupIds[2] = _third;
    }

    function _addresses(address _first) internal pure returns (address[] memory addresses) {
        addresses = new address[](1);
        addresses[0] = _first;
    }

    function _addresses(address _first, address _second) internal pure returns (address[] memory addresses) {
        addresses = new address[](2);
        addresses[0] = _first;
        addresses[1] = _second;
    }
}
