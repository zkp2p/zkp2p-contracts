// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";

contract BaseUnifiedVerifierTest is Test {
    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");

    address internal attacker;
    address internal orchestrator;
    address internal witness;
    NullifierRegistry internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifier internal verifier;

    function setUp() public {
        attacker = makeAddr("attacker");
        orchestrator = makeAddr("orchestrator");
        witness = makeAddr("witness");
        nullifierRegistry = new NullifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(orchestrator);
        attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifier(orchestratorRegistry, nullifierRegistry, attestationVerifier);
    }

    function test_ConstructorSetsRegistriesAttestationVerifierAndOwner() public view {
        assertEq(address(verifier.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
        assertEq(address(verifier.attestationVerifier()), address(attestationVerifier));
        assertEq(verifier.owner(), address(this));
        assertEq(verifier.getPaymentMethods().length, 0);
    }

    function test_SetAttestationVerifierUpdatesStateAndEmits() public {
        SimpleAttestationVerifier replacement = new SimpleAttestationVerifier(witness);
        vm.expectEmit(true, true, false, true, address(verifier));
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_SetAttestationVerifierRejectsZeroSameAndNonOwner() public {
        vm.expectRevert(bytes("UPV: Invalid attestation verifier"));
        verifier.setAttestationVerifier(address(0));
        vm.expectRevert(bytes("UPV: Same verifier"));
        verifier.setAttestationVerifier(address(attestationVerifier));

        SimpleAttestationVerifier replacement = new SimpleAttestationVerifier(witness);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setAttestationVerifier(address(replacement));
    }

    function test_AddPaymentMethodUpdatesArrayMappingAndEmits() public {
        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodAdded(VENMO);
        verifier.addPaymentMethod(VENMO);
        assertTrue(verifier.isPaymentMethod(VENMO));
        bytes32[] memory methods = verifier.getPaymentMethods();
        assertEq(methods.length, 1);
        assertEq(methods[0], VENMO);
    }

    function test_AddPaymentMethodRejectsDuplicateAndNonOwner() public {
        verifier.addPaymentMethod(VENMO);
        vm.expectRevert(bytes("UPV: Payment method already exists"));
        verifier.addPaymentMethod(VENMO);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.addPaymentMethod(PAYPAL);
    }

    function test_RemovePaymentMethodUpdatesArrayMappingAndEmits() public {
        verifier.addPaymentMethod(VENMO);
        verifier.addPaymentMethod(PAYPAL);
        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodRemoved(VENMO);
        verifier.removePaymentMethod(VENMO);
        assertFalse(verifier.isPaymentMethod(VENMO));
        assertTrue(verifier.isPaymentMethod(PAYPAL));
        bytes32[] memory methods = verifier.getPaymentMethods();
        assertEq(methods.length, 1);
        assertEq(methods[0], PAYPAL);
    }

    function test_RemovePaymentMethodRejectsMissingAndNonOwner() public {
        verifier.addPaymentMethod(VENMO);
        vm.expectRevert(bytes("UPV: Payment method does not exist"));
        verifier.removePaymentMethod(PAYPAL);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.removePaymentMethod(VENMO);
    }

    function test_ViewFunctionsReturnAllConfiguredMethodsAndMembership() public {
        verifier.addPaymentMethod(VENMO);
        verifier.addPaymentMethod(PAYPAL);
        bytes32[] memory methods = verifier.getPaymentMethods();
        assertEq(methods.length, 2);
        assertEq(methods[0], VENMO);
        assertEq(methods[1], PAYPAL);
        assertTrue(verifier.isPaymentMethod(VENMO));
        assertTrue(verifier.isPaymentMethod(PAYPAL));
    }
}
