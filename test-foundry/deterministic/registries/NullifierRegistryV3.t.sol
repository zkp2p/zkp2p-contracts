// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {INullifierRegistryV3} from "contracts/interfaces/INullifierRegistryV3.sol";

contract NullifierRegistryV3Test is Test {
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);

    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant OTHER_INTENT = keccak256("other-intent");

    address internal first;
    address internal second;
    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal predecessor;
    NullifierRegistryV3 internal registry;

    function setUp() public {
        first = makeAddr("first");
        second = makeAddr("second");
        legacyRegistry = new NullifierRegistry();
        predecessor = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        registry = new NullifierRegistryV3(predecessor);
        legacyRegistry.addWritePermission(address(this));
        predecessor.addWritePermission(address(this));
    }

    function test_ConstructorRequiresDeployedPredecessor() public {
        vm.expectRevert(INullifierRegistryV3.ZeroAddress.selector);
        new NullifierRegistryV3(INullifierRegistryV2(address(0)));
        vm.expectRevert(INullifierRegistryV3.ZeroAddress.selector);
        new NullifierRegistryV3(INullifierRegistryV2(first));
        assertEq(address(registry.predecessor()), address(predecessor));
    }

    function test_PredecessorBindingAndLegacyNullifierRemainAuthoritative() public {
        bytes32 legacyNullifier = keccak256("legacy-payment");
        bytes32 predecessorNullifier = keccak256("predecessor-payment");
        legacyRegistry.addNullifier(legacyNullifier);
        predecessor.addNullifier(predecessorNullifier, INTENT);

        assertTrue(registry.isNullified(legacyNullifier));
        assertEq(registry.intentHashByNullifier(legacyNullifier), bytes32(0));
        assertTrue(registry.isNullified(predecessorNullifier));
        assertEq(registry.intentHashByNullifier(predecessorNullifier), INTENT);

        registry.addWritePermission(first);
        vm.startPrank(first);
        vm.expectRevert(
            abi.encodeWithSelector(INullifierRegistryV3.NullifierAlreadyExists.selector, legacyNullifier)
        );
        registry.addNullifier(legacyNullifier, OTHER_INTENT);
        vm.expectRevert(
            abi.encodeWithSelector(INullifierRegistryV3.NullifierAlreadyExists.selector, predecessorNullifier)
        );
        registry.addNullifier(predecessorNullifier, OTHER_INTENT);
        vm.stopPrank();
    }

    function test_OneIntentHoldsManyNullifiersAndEachBindingIsImmutable() public {
        bytes32 primary = keccak256("primary");
        bytes32 shared = keccak256("shared");
        registry.addWritePermission(first);

        vm.startPrank(first);
        vm.expectEmit(true, true, true, true, address(registry));
        emit NullifierAdded(primary, INTENT, first);
        registry.addNullifier(primary, INTENT);
        vm.expectEmit(true, true, true, true, address(registry));
        emit NullifierAdded(shared, INTENT, first);
        registry.addNullifier(shared, INTENT);

        assertEq(registry.intentHashByNullifier(primary), INTENT);
        assertEq(registry.intentHashByNullifier(shared), INTENT);
        assertTrue(registry.isNullified(primary));
        assertTrue(registry.isNullified(shared));

        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.NullifierAlreadyExists.selector, shared));
        registry.addNullifier(shared, OTHER_INTENT);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.NullifierAlreadyExists.selector, primary));
        registry.addNullifier(primary, INTENT);
        vm.stopPrank();

        assertEq(registry.intentHashByNullifier(shared), INTENT);
    }

    /// @dev The cutover invariant in practice: the predecessor never learns about a V3 write.
    function test_PredecessorCannotObserveNewWrites() public {
        bytes32 nullifier = keccak256("new-payment");
        registry.addWritePermission(first);
        vm.prank(first);
        registry.addNullifier(nullifier, INTENT);

        assertFalse(predecessor.isNullified(nullifier));
        assertEq(predecessor.intentHashByNullifier(nullifier), bytes32(0));
    }

    function test_RejectsZeroValuesAndUnauthorizedWrites() public {
        bytes32 nullifier = keccak256("payment");
        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.UnauthorizedWriter.selector, second));
        registry.addNullifier(nullifier, INTENT);

        registry.addWritePermission(first);
        vm.startPrank(first);
        vm.expectRevert(INullifierRegistryV3.ZeroNullifier.selector);
        registry.addNullifier(bytes32(0), INTENT);
        vm.expectRevert(INullifierRegistryV3.ZeroIntentHash.selector);
        registry.addNullifier(nullifier, bytes32(0));
        vm.stopPrank();

        assertFalse(registry.isNullified(nullifier));
    }

    function test_WriterSetIsOwnerGovernedExplicitEnumerableAndEmits() public {
        vm.prank(second);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.addWritePermission(first);
        vm.expectRevert(INullifierRegistryV3.ZeroAddress.selector);
        registry.addWritePermission(address(0));

        vm.expectEmit(true, false, false, true, address(registry));
        emit WriterAdded(first);
        registry.addWritePermission(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.WriterAlreadyAuthorized.selector, first));
        registry.addWritePermission(first);
        registry.addWritePermission(second);

        address[] memory writers = registry.getWriters();
        assertEq(writers.length, 2);
        assertEq(writers[0], first);
        assertEq(writers[1], second);

        vm.prank(second);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        registry.removeWritePermission(first);

        vm.expectEmit(true, false, false, true, address(registry));
        emit WriterRemoved(first);
        registry.removeWritePermission(first);
        assertFalse(registry.isWriter(first));
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.WriterNotAuthorized.selector, first));
        registry.removeWritePermission(first);

        writers = registry.getWriters();
        assertEq(writers.length, 1);
        assertEq(writers[0], second);

        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV3.UnauthorizedWriter.selector, first));
        registry.addNullifier(keccak256("payment"), INTENT);
    }
}
