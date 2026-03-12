// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";

contract NullifierRegistryTest is Test {
    event NullifierAdded(bytes32 nullifier, address indexed writer);
    event WriterAdded(address writer);
    event WriterRemoved(address writer);

    NullifierRegistry internal registry;

    address internal owner;
    address internal writer;
    address internal attacker;

    bytes32 internal constant NULLIFIER = bytes32("nullifier");

    function setUp() public {
        owner = makeAddr("owner");
        writer = makeAddr("writer");
        attacker = makeAddr("attacker");

        vm.prank(owner);
        registry = new NullifierRegistry();
    }

    function test_constructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_addNullifierStoresValueAndEmitsEvent() public {
        vm.prank(owner);
        registry.addWritePermission(writer);

        vm.expectEmit(false, true, false, true, address(registry));
        emit NullifierAdded(NULLIFIER, writer);

        vm.prank(writer);
        registry.addNullifier(NULLIFIER);

        assertTrue(registry.isNullified(NULLIFIER));
    }

    function test_addNullifierRevertsWhenNullifierAlreadyExists() public {
        vm.startPrank(owner);
        registry.addWritePermission(writer);
        vm.stopPrank();

        vm.startPrank(writer);
        registry.addNullifier(NULLIFIER);
        vm.expectRevert("Nullifier already exists");
        registry.addNullifier(NULLIFIER);
        vm.stopPrank();
    }

    function test_addNullifierRevertsWhenCallerIsNotWriter() public {
        vm.prank(attacker);
        vm.expectRevert("Only addresses with write permissions can call");
        registry.addNullifier(NULLIFIER);
    }

    function test_addWritePermissionStoresWriterAndEmitsEvent() public {
        assertFalse(registry.isWriter(writer));
        assertEq(registry.getWriters().length, 0);

        vm.expectEmit(false, false, false, true, address(registry));
        emit WriterAdded(writer);

        vm.prank(owner);
        registry.addWritePermission(writer);

        assertTrue(registry.isWriter(writer));
        _assertContains(registry.getWriters(), writer);
    }

    function test_addWritePermissionRevertsWhenWriterAlreadyExists() public {
        vm.startPrank(owner);
        registry.addWritePermission(writer);
        vm.expectRevert("Address is already a writer");
        registry.addWritePermission(writer);
        vm.stopPrank();
    }

    function test_addWritePermissionRevertsWhenCallerIsNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addWritePermission(writer);
    }

    function test_removeWritePermissionClearsWriterAndEmitsEvent() public {
        vm.prank(owner);
        registry.addWritePermission(writer);

        assertTrue(registry.isWriter(writer));
        _assertContains(registry.getWriters(), writer);

        vm.expectEmit(false, false, false, true, address(registry));
        emit WriterRemoved(writer);

        vm.prank(owner);
        registry.removeWritePermission(writer);

        assertFalse(registry.isWriter(writer));
        _assertNotContains(registry.getWriters(), writer);
    }

    function test_removeWritePermissionRevertsWhenWriterMissing() public {
        vm.prank(owner);
        vm.expectRevert("Address is not a writer");
        registry.removeWritePermission(writer);
    }

    function test_removeWritePermissionRevertsWhenCallerIsNotOwner() public {
        vm.prank(owner);
        registry.addWritePermission(writer);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removeWritePermission(writer);
    }

    function _assertContains(address[] memory values, address needle) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == needle) {
                return;
            }
        }

        revert("missing expected address");
    }

    function _assertNotContains(address[] memory values, address needle) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == needle) {
                revert("unexpected address present");
            }
        }
    }
}
