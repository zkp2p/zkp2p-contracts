// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {AddressGroupRegistryGasHarness} from "contracts/mocks/AddressGroupRegistryGasHarness.sol";
import {WhitelistResolverMock} from "contracts/mocks/WhitelistResolverMock.sol";

contract AddressGroupRegistryResolverTest is Test {
    event ResolverSet(uint256 indexed groupId, address indexed oldResolver, address indexed newResolver);

    AddressGroupRegistry internal registry;
    WhitelistResolverMock internal resolver;
    address internal alice;
    address internal bob;
    uint256 internal groupId;

    function setUp() public {
        registry = new AddressGroupRegistry();
        resolver = new WhitelistResolverMock();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        vm.prank(alice);
        groupId = registry.createGroup("resolver-group");
    }

    function _setResolver(address newResolver) internal {
        vm.prank(alice);
        registry.setResolver(groupId, newResolver);
    }

    /* ============ setResolver ============ */

    function test_OwnerSetsResolverAndEmitsOldAndNew() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ResolverSet(groupId, address(0), address(resolver));
        _setResolver(address(resolver));
        (,, address stored,,) = registry.getGroup(groupId);
        assertEq(stored, address(resolver));
    }

    function test_ZeroClearsResolver() public {
        _setResolver(address(resolver));
        vm.expectEmit(true, true, true, true, address(registry));
        emit ResolverSet(groupId, address(resolver), address(0));
        _setResolver(address(0));
        (,, address stored,,) = registry.getGroup(groupId);
        assertEq(stored, address(0));
    }

    function test_EoaResolverReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.ResolverNotContract.selector, bob));
        _setResolver(bob);
    }

    function test_NonOwnerCannotSetResolver() public {
        vm.expectRevert(abi.encodeWithSelector(AddressGroupRegistry.UnauthorizedGroupOwner.selector, bob, alice));
        vm.prank(bob);
        registry.setResolver(groupId, address(resolver));
    }

    /* ============ effective membership ============ */

    function test_ResolverMembershipGrantsAccess() public {
        _setResolver(address(resolver));
        resolver.setMemberOf(groupId, bob, true);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_CuratedMembershipWorksAlongsideResolver() public {
        _setResolver(address(resolver));
        address[] memory batch = new address[](1);
        batch[0] = bob;
        vm.prank(alice);
        registry.addMembers(groupId, batch);
        // curated hit short-circuits before the resolver
        vm.expectCall(address(resolver), abi.encodeCall(resolver.isMember, (groupId, bob)), 0);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_NoResolverNoCuratedMeansFalse() public view {
        assertFalse(registry.isMember(groupId, bob));
    }

    function test_LeaveClearsCuratedMembershipButResolverStillGrants() public {
        _setResolver(address(resolver));
        resolver.setMemberOf(groupId, bob, true);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);
        vm.prank(bob);
        registry.joinGroup(groupId);

        vm.prank(bob);
        registry.leaveGroup(groupId);

        assertFalse(registry.members(groupId, bob));
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_ResolverOnlyMemberLeaveIsSilentNoOp() public {
        _setResolver(address(resolver));
        resolver.setMemberOf(groupId, bob, true);
        vm.prank(alice);
        registry.setGroupVisibility(groupId, true);

        vm.recordLogs();
        vm.prank(bob);
        registry.leaveGroup(groupId);

        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(registry.isMember(groupId, bob));
    }

    /* ============ fail-closed matrix ============ */

    function _assertFailClosed(WhitelistResolverMock.Mode mode) internal {
        _setResolver(address(resolver));
        resolver.setMode(mode);
        assertFalse(registry.isMember(groupId, bob));
    }

    function test_ResolverReturnTrueGrants() public {
        _setResolver(address(resolver));
        resolver.setMode(WhitelistResolverMock.Mode.ReturnTrue);
        assertTrue(registry.isMember(groupId, bob));
    }

    function test_ResolverReturnFalseDenies() public {
        _assertFailClosed(WhitelistResolverMock.Mode.ReturnFalse);
    }

    function test_ResolverWordTwoDenies() public {
        _assertFailClosed(WhitelistResolverMock.Mode.ReturnTwo);
    }

    function test_ResolverWordMaxDenies() public {
        _assertFailClosed(WhitelistResolverMock.Mode.ReturnMax);
    }

    function test_ResolverShortReturndataDenies() public {
        _assertFailClosed(WhitelistResolverMock.Mode.ReturnShort);
    }

    function test_ResolverRevertDenies() public {
        _assertFailClosed(WhitelistResolverMock.Mode.Revert);
    }

    function test_ResolverGasBurnDeniesAndDoesNotRevertCaller() public {
        _assertFailClosed(WhitelistResolverMock.Mode.BurnGas);
    }

    function test_ResolverDestroyedAfterSetDenies() public {
        _setResolver(address(resolver));
        // simulate code disappearing after setResolver's code check
        vm.etch(address(resolver), "");
        assertFalse(registry.isMember(groupId, bob));
    }

    function test_OversizedPayloadUnderStipendDenies() public {
        _setResolver(address(resolver));
        resolver.setMode(WhitelistResolverMock.Mode.PayloadReturnNotOne);
        resolver.setPayloadSize(96_000); // empirically constructible within the 50k stipend
        assertFalse(registry.isMember(groupId, bob));
    }

    function test_OversizedRevertUnderStipendDenies() public {
        _setResolver(address(resolver));
        resolver.setMode(WhitelistResolverMock.Mode.PayloadRevert);
        resolver.setPayloadSize(96_000);
        assertFalse(registry.isMember(groupId, bob));
    }

    function test_OversizedPayloadWithWordOneGrants() public {
        // trailing bytes beyond the first word are intentionally ignored
        _setResolver(address(resolver));
        resolver.setMode(WhitelistResolverMock.Mode.PayloadReturnTrue);
        resolver.setPayloadSize(96_000);
        assertTrue(registry.isMember(groupId, bob));
    }

    /* ============ harness-level bounded-copy proof (exceeds stipend by construction) ============ */

    function test_HarnessOneMegabyteReturndataCopiesOnlyBoundedResult() public {
        AddressGroupRegistryGasHarness harness = new AddressGroupRegistryGasHarness();
        vm.prank(alice);
        uint256 harnessGroup = harness.createGroup("harness");
        vm.prank(alice);
        harness.setResolver(harnessGroup, address(resolver));
        harness.setResolverGasLimit(30_000_000);
        resolver.setMode(WhitelistResolverMock.Mode.PayloadReturnTrue);
        resolver.setPayloadSize(1_048_576); // 1 MB — only constructible with the raised harness limit
        // Bounded copy: the call succeeds, evaluates the first word only, and does not revert
        // or balloon caller memory despite 1 MB of returndata.
        assertTrue(harness.isMember(harnessGroup, bob));

        resolver.setMode(WhitelistResolverMock.Mode.PayloadReturnNotOne);
        assertFalse(harness.isMember(harnessGroup, bob));

        resolver.setMode(WhitelistResolverMock.Mode.PayloadRevert);
        assertFalse(harness.isMember(harnessGroup, bob));
    }
}
