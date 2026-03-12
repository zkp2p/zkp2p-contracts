// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { EscrowRegistry } from "../../contracts/registries/EscrowRegistry.sol";

contract EscrowRegistryTest is Test {
    event EscrowAdded(address indexed escrow);
    event EscrowRemoved(address indexed escrow);
    event AcceptAllEscrowsUpdated(bool acceptAll);

    EscrowRegistry internal registry;

    address internal owner;
    address internal escrow;
    address internal attacker;

    function setUp() public {
        owner = makeAddr("owner");
        escrow = makeAddr("escrow");
        attacker = makeAddr("attacker");

        vm.prank(owner);
        registry = new EscrowRegistry();
    }

    function test_constructorSetsOwnerAndAcceptAllDefault() public view {
        assertEq(registry.owner(), owner);
        assertFalse(registry.acceptAllEscrows());
    }

    function test_addEscrowStoresWhitelistEntryAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit EscrowAdded(escrow);

        vm.prank(owner);
        registry.addEscrow(escrow);

        assertTrue(registry.isWhitelistedEscrow(escrow));
        _assertContains(registry.getWhitelistedEscrows(), escrow);
    }

    function test_addEscrowRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        vm.expectRevert("Escrow cannot be zero address");
        registry.addEscrow(address(0));

        vm.startPrank(owner);
        registry.addEscrow(escrow);
        vm.expectRevert("Escrow already whitelisted");
        registry.addEscrow(escrow);
        vm.stopPrank();

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.addEscrow(attacker);
    }

    function test_removeEscrowClearsWhitelistEntryAndEmitsEvent() public {
        vm.prank(owner);
        registry.addEscrow(escrow);

        vm.expectEmit(true, false, false, true, address(registry));
        emit EscrowRemoved(escrow);

        vm.prank(owner);
        registry.removeEscrow(escrow);

        assertFalse(registry.isWhitelistedEscrow(escrow));
        _assertNotContains(registry.getWhitelistedEscrows(), escrow);
    }

    function test_removeEscrowRevertsOnInvalidInputsOrCaller() public {
        vm.prank(owner);
        registry.addEscrow(escrow);

        vm.prank(owner);
        vm.expectRevert("Escrow not whitelisted");
        registry.removeEscrow(attacker);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.removeEscrow(escrow);
    }

    function test_setAcceptAllEscrowsUpdatesFlagAndEmitsEvent() public {
        vm.expectEmit(false, false, false, true, address(registry));
        emit AcceptAllEscrowsUpdated(true);

        vm.prank(owner);
        registry.setAcceptAllEscrows(true);

        assertTrue(registry.acceptAllEscrows());
        assertTrue(registry.isAcceptingAllEscrows());

        vm.expectEmit(false, false, false, true, address(registry));
        emit AcceptAllEscrowsUpdated(false);

        vm.prank(owner);
        registry.setAcceptAllEscrows(false);

        assertFalse(registry.acceptAllEscrows());
        assertFalse(registry.isAcceptingAllEscrows());
    }

    function test_setAcceptAllEscrowsRevertsWhenCallerIsNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        registry.setAcceptAllEscrows(true);
    }

    function test_isWhitelistedEscrowReflectsWhitelistState() public {
        vm.prank(owner);
        registry.addEscrow(escrow);

        assertTrue(registry.isWhitelistedEscrow(escrow));
        assertFalse(registry.isWhitelistedEscrow(attacker));
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
