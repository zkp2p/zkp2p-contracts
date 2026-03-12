// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { RelayerRegistry } from "../../contracts/registries/RelayerRegistry.sol";

contract RelayerRegistryTest is Test {
    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);

    RelayerRegistry internal registry;

    address internal owner;
    address internal relayer;
    address internal attacker;

    function setUp() public {
        owner = makeAddr("owner");
        relayer = makeAddr("relayer");
        attacker = makeAddr("attacker");

        vm.prank(owner);
        registry = new RelayerRegistry();
    }

    function test_constructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_addRelayerStoresRelayerAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit RelayerAdded(relayer);

        vm.prank(owner);
        registry.addRelayer(relayer);

        assertTrue(registry.isWhitelistedRelayer(relayer));
        _assertContains(registry.getWhitelistedRelayers(), relayer);
    }

    function test_addRelayerRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        vm.expectRevert("Relayer cannot be zero address");
        registry.addRelayer(address(0));

        vm.startPrank(owner);
        registry.addRelayer(relayer);
        vm.expectRevert("Relayer already whitelisted");
        registry.addRelayer(relayer);
        vm.stopPrank();

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addRelayer(relayer);
    }

    function test_removeRelayerClearsRelayerAndEmitsEvent() public {
        vm.prank(owner);
        registry.addRelayer(relayer);

        vm.expectEmit(true, false, false, true, address(registry));
        emit RelayerRemoved(relayer);

        vm.prank(owner);
        registry.removeRelayer(relayer);

        assertFalse(registry.isWhitelistedRelayer(relayer));
        _assertNotContains(registry.getWhitelistedRelayers(), relayer);
    }

    function test_removeRelayerRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        registry.addRelayer(relayer);

        vm.prank(owner);
        vm.expectRevert("Relayer not whitelisted");
        registry.removeRelayer(attacker);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removeRelayer(relayer);
    }

    function test_isWhitelistedRelayerReflectsRelayerState() public {
        vm.prank(owner);
        registry.addRelayer(relayer);

        assertTrue(registry.isWhitelistedRelayer(relayer));
        assertFalse(registry.isWhitelistedRelayer(attacker));
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
