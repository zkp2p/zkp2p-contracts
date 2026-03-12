// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { PostIntentHookRegistry } from "../../contracts/registries/PostIntentHookRegistry.sol";

contract PostIntentHookRegistryTest is Test {
    event PostIntentHookAdded(address indexed hook);
    event PostIntentHookRemoved(address indexed hook);

    PostIntentHookRegistry internal registry;

    address internal owner;
    address internal hook;
    address internal attacker;

    function setUp() public {
        owner = makeAddr("owner");
        hook = makeAddr("hook");
        attacker = makeAddr("attacker");

        vm.prank(owner);
        registry = new PostIntentHookRegistry();
    }

    function test_constructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_addPostIntentHookStoresHookAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit PostIntentHookAdded(hook);

        vm.prank(owner);
        registry.addPostIntentHook(hook);

        assertTrue(registry.whitelistedHooks(hook));
        _assertContains(registry.getWhitelistedHooks(), hook);
    }

    function test_addPostIntentHookRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        vm.expectRevert("Hook cannot be zero address");
        registry.addPostIntentHook(address(0));

        vm.startPrank(owner);
        registry.addPostIntentHook(hook);
        vm.expectRevert("Hook already whitelisted");
        registry.addPostIntentHook(hook);
        vm.stopPrank();

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addPostIntentHook(hook);
    }

    function test_removePostIntentHookClearsHookAndEmitsEvent() public {
        vm.prank(owner);
        registry.addPostIntentHook(hook);

        vm.expectEmit(true, false, false, true, address(registry));
        emit PostIntentHookRemoved(hook);

        vm.prank(owner);
        registry.removePostIntentHook(hook);

        assertFalse(registry.whitelistedHooks(hook));
        _assertNotContains(registry.getWhitelistedHooks(), hook);
    }

    function test_removePostIntentHookRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        registry.addPostIntentHook(hook);

        vm.prank(owner);
        vm.expectRevert("Hook not whitelisted");
        registry.removePostIntentHook(attacker);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removePostIntentHook(hook);
    }

    function test_isWhitelistedHookReflectsHookState() public {
        vm.prank(owner);
        registry.addPostIntentHook(hook);

        assertTrue(registry.isWhitelistedHook(hook));
        assertFalse(registry.isWhitelistedHook(attacker));
    }

    function test_getWhitelistedHooksReturnsAllHooks() public {
        vm.startPrank(owner);
        registry.addPostIntentHook(hook);
        registry.addPostIntentHook(owner);
        vm.stopPrank();

        address[] memory hooks = registry.getWhitelistedHooks();
        assertEq(hooks.length, 2);
        _assertContains(hooks, hook);
        _assertContains(hooks, owner);
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
