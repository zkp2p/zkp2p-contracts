// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";

/// @dev Properties cover arbitrary registry keys and the one-to-one payment/intent replay boundary.
contract RegistryNullifierFuzzTest is Test {
    PaymentVerifierRegistry internal paymentRegistry;
    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal nullifierRegistry;

    function setUp() public {
        paymentRegistry = new PaymentVerifierRegistry();
        legacyRegistry = new NullifierRegistry();
        nullifierRegistry = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        nullifierRegistry.addWritePermission(address(this));
    }

    /// Risk: arbitrary method/currency keys can leave stale enumerable or membership state after removal.
    function testFuzz_PaymentMethodRemovalClearsEveryRegistrySurface(
        bytes32 method,
        bytes32 firstCurrency,
        bytes32 secondCurrency,
        address verifier
    ) public {
        vm.assume(firstCurrency != bytes32(0) && secondCurrency != bytes32(0) && firstCurrency != secondCurrency);
        vm.assume(verifier != address(0));
        bytes32[] memory currencies = new bytes32[](2);
        currencies[0] = firstCurrency;
        currencies[1] = secondCurrency;
        paymentRegistry.addPaymentMethod(method, verifier, currencies);
        assertTrue(paymentRegistry.isPaymentMethod(method));
        assertEq(paymentRegistry.getVerifier(method), verifier);
        assertTrue(paymentRegistry.isCurrency(method, firstCurrency));
        assertTrue(paymentRegistry.isCurrency(method, secondCurrency));

        paymentRegistry.removePaymentMethod(method);
        assertFalse(paymentRegistry.isPaymentMethod(method));
        assertEq(paymentRegistry.getVerifier(method), address(0));
        assertFalse(paymentRegistry.isCurrency(method, firstCurrency));
        assertFalse(paymentRegistry.isCurrency(method, secondCurrency));
        assertEq(paymentRegistry.getCurrencies(method).length, 0);
        assertEq(paymentRegistry.getPaymentMethods().length, 0);
    }

    /// Risk: the same payment or the same intent can be rebound under a different identifier.
    function testFuzz_NullifierBindingIsBidirectionallyUnique(
        bytes32 nullifier,
        bytes32 intentHash,
        bytes32 otherNullifier,
        bytes32 otherIntent
    ) public {
        vm.assume(nullifier != bytes32(0) && intentHash != bytes32(0));
        vm.assume(otherNullifier != bytes32(0) && otherNullifier != nullifier);
        vm.assume(otherIntent != bytes32(0) && otherIntent != intentHash);
        nullifierRegistry.addNullifier(nullifier, intentHash);
        assertTrue(nullifierRegistry.isNullified(nullifier));
        assertEq(nullifierRegistry.intentHashByNullifier(nullifier), intentHash);
        assertEq(nullifierRegistry.nullifierByIntentHash(intentHash), nullifier);

        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.NullifierAlreadyExists.selector, nullifier));
        nullifierRegistry.addNullifier(nullifier, otherIntent);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.IntentAlreadyBound.selector, intentHash, nullifier));
        nullifierRegistry.addNullifier(otherNullifier, intentHash);
    }

    /// Risk: V2 can accidentally accept a payment already consumed before the one-way cutover.
    function testFuzz_LegacyNullifierRemainsAuthoritative(bytes32 nullifier, bytes32 intentHash) public {
        vm.assume(nullifier != bytes32(0) && intentHash != bytes32(0));
        legacyRegistry.addWritePermission(address(this));
        legacyRegistry.addNullifier(nullifier);
        assertTrue(nullifierRegistry.isNullified(nullifier));
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.NullifierAlreadyExists.selector, nullifier));
        nullifierRegistry.addNullifier(nullifier, intentHash);
    }

    /// Risk: untrusted callers can mutate payment routing or replay protection despite owner/writer boundaries.
    function testFuzz_UnauthorizedActorsCannotMutateRegistries(address attacker, bytes32 method, bytes32 nullifier)
        public
    {
        vm.assume(attacker != address(0) && attacker != address(this));
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = keccak256("USD");
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(attacker);
        paymentRegistry.addPaymentMethod(method, attacker, currencies);

        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.UnauthorizedWriter.selector, attacker));
        vm.prank(attacker);
        nullifierRegistry.addNullifier(nullifier, keccak256("intent"));
    }
}
