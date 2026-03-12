// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { NullifierRegistry } from "../../contracts/registries/NullifierRegistry.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { SimpleAttestationVerifier } from "../../contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import { UnifiedPaymentVerifier } from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";

contract BaseUnifiedPaymentVerifierTest is Test {
    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");

    address internal owner;
    address internal attacker;
    address internal escrow;
    address internal witnessOne;
    address internal witnessTwo;

    NullifierRegistry internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifier internal verifier;

    function setUp() public {
        owner = makeAddr("owner");
        attacker = makeAddr("attacker");
        escrow = makeAddr("escrow");
        witnessOne = makeAddr("witnessOne");
        witnessTwo = makeAddr("witnessTwo");

        vm.startPrank(owner);
        nullifierRegistry = new NullifierRegistry();
        attestationVerifier = new SimpleAttestationVerifier(witnessOne);
        orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(escrow);
        verifier = new UnifiedPaymentVerifier(
            orchestratorRegistry,
            nullifierRegistry,
            attestationVerifier
        );
        vm.stopPrank();
    }

    function test_constructorSetsExpectedDependenciesAndOwner() public view {
        assertEq(address(verifier.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
        assertEq(address(verifier.attestationVerifier()), address(attestationVerifier));
        assertEq(verifier.owner(), owner);
    }

    function test_setAttestationVerifierUpdatesVerifierAndEmitsEvent() public {
        vm.prank(owner);
        SimpleAttestationVerifier newVerifier = new SimpleAttestationVerifier(witnessTwo);

        vm.expectEmit(true, true, false, true, address(verifier));
        emit AttestationVerifierUpdated(address(attestationVerifier), address(newVerifier));

        vm.prank(owner);
        verifier.setAttestationVerifier(address(newVerifier));

        assertEq(address(verifier.attestationVerifier()), address(newVerifier));
    }

    function test_setAttestationVerifierRevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert("UPV: Invalid attestation verifier");
        verifier.setAttestationVerifier(address(0));
    }

    function test_setAttestationVerifierRevertsWhenVerifierMatchesCurrent() public {
        vm.prank(owner);
        vm.expectRevert("UPV: Same verifier");
        verifier.setAttestationVerifier(address(attestationVerifier));
    }

    function test_setAttestationVerifierRevertsWhenCallerIsNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setAttestationVerifier(address(makeAddr("newVerifier")));
    }

    function test_addPaymentMethodStoresMethodAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodAdded(VENMO);

        vm.prank(owner);
        verifier.addPaymentMethod(VENMO);

        assertTrue(verifier.isPaymentMethod(VENMO));
        _assertContains(verifier.getPaymentMethods(), VENMO);
    }

    function test_addPaymentMethodRevertsWhenMethodAlreadyExists() public {
        vm.startPrank(owner);
        verifier.addPaymentMethod(VENMO);
        vm.expectRevert("UPV: Payment method already exists");
        verifier.addPaymentMethod(VENMO);
        vm.stopPrank();
    }

    function test_addPaymentMethodRevertsWhenCallerIsNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.addPaymentMethod(VENMO);
    }

    function test_removePaymentMethodClearsMethodAndEmitsEvent() public {
        vm.prank(owner);
        verifier.addPaymentMethod(VENMO);

        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodRemoved(VENMO);

        vm.prank(owner);
        verifier.removePaymentMethod(VENMO);

        assertFalse(verifier.isPaymentMethod(VENMO));
        _assertNotContains(verifier.getPaymentMethods(), VENMO);
    }

    function test_removePaymentMethodRevertsWhenMethodDoesNotExist() public {
        vm.prank(owner);
        verifier.addPaymentMethod(VENMO);

        vm.prank(owner);
        vm.expectRevert("UPV: Payment method does not exist");
        verifier.removePaymentMethod(PAYPAL);
    }

    function test_removePaymentMethodRevertsWhenCallerIsNotOwner() public {
        vm.prank(owner);
        verifier.addPaymentMethod(VENMO);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.removePaymentMethod(VENMO);
    }

    function test_getPaymentMethodsReturnsAllConfiguredMethods() public {
        vm.startPrank(owner);
        verifier.addPaymentMethod(VENMO);
        verifier.addPaymentMethod(PAYPAL);
        vm.stopPrank();

        bytes32[] memory paymentMethods = verifier.getPaymentMethods();

        assertEq(paymentMethods.length, 2);
        _assertContains(paymentMethods, VENMO);
        _assertContains(paymentMethods, PAYPAL);
    }

    function test_isPaymentMethodReturnsTrueForConfiguredMethod() public {
        vm.prank(owner);
        verifier.addPaymentMethod(VENMO);

        assertTrue(verifier.isPaymentMethod(VENMO));
    }

    function _assertContains(bytes32[] memory values, bytes32 expected) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == expected) {
                return;
            }
        }

        revert("missing expected bytes32");
    }

    function _assertNotContains(bytes32[] memory values, bytes32 disallowed) internal pure {
        for (uint256 index = 0; index < values.length; index++) {
            assertTrue(values[index] != disallowed, "found disallowed bytes32");
        }
    }
}
