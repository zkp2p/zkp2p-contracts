// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { MultiAttestationVerifier } from "../../contracts/unifiedVerifier/MultiAttestationVerifier.sol";

contract MultiAttestationVerifierUnit is Test {
    MultiAttestationVerifier public verifier;

    address public owner;
    address public nonOwner;
    address public witnessA;
    address public witnessB;
    address public witnessC;

    function setUp() public {
        owner = makeAddr("owner");
        nonOwner = makeAddr("nonOwner");
        witnessA = makeAddr("witnessA");
        witnessB = makeAddr("witnessB");
        witnessC = makeAddr("witnessC");

        verifier = _deployVerifier(_twoWitnesses(), 1);
    }

    function test_constructor_revertsOnZeroWitness() public {
        address[] memory initialWitnesses = new address[](2);
        initialWitnesses[0] = witnessA;
        initialWitnesses[1] = address(0);

        vm.prank(owner);
        vm.expectRevert("MAV: zero witness");
        new MultiAttestationVerifier(initialWitnesses, 1);
    }

    function test_constructor_revertsOnDuplicateWitness() public {
        address[] memory initialWitnesses = new address[](2);
        initialWitnesses[0] = witnessA;
        initialWitnesses[1] = witnessA;

        vm.prank(owner);
        vm.expectRevert("MAV: duplicate witness");
        new MultiAttestationVerifier(initialWitnesses, 2);
    }

    function test_constructor_revertsOnZeroThreshold() public {
        vm.prank(owner);
        vm.expectRevert("MAV: threshold must be > 0");
        new MultiAttestationVerifier(_singleWitness(witnessA), 0);
    }

    function test_constructor_revertsWhenThresholdExceedsWitnessCount() public {
        vm.prank(owner);
        vm.expectRevert("MAV: threshold exceeds count");
        new MultiAttestationVerifier(_singleWitness(witnessA), 2);
    }

    function test_addWitness_revertsWhenCallerNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.addWitness(witnessC);
    }

    function test_addWitness_revertsOnZeroWitness() public {
        vm.prank(owner);
        vm.expectRevert("MAV: zero witness");
        verifier.addWitness(address(0));
    }

    function test_addWitness_revertsOnDuplicateWitness() public {
        vm.prank(owner);
        vm.expectRevert("MAV: already a witness");
        verifier.addWitness(witnessA);
    }

    function test_removeWitness_revertsWhenCallerNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.removeWitness(witnessB);
    }

    function test_removeWitness_revertsWhenWitnessDoesNotExist() public {
        vm.prank(owner);
        vm.expectRevert("MAV: not a witness");
        verifier.removeWitness(witnessC);
    }

    function test_removeWitness_revertsWhenRemovalFallsBelowThreshold() public {
        MultiAttestationVerifier singleWitnessVerifier = _deployVerifier(_singleWitness(witnessA), 1);

        vm.prank(owner);
        vm.expectRevert("MAV: below threshold");
        singleWitnessVerifier.removeWitness(witnessA);
    }

    function test_setRequiredSignatures_revertsWhenCallerNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setRequiredSignatures(2);
    }

    function test_setRequiredSignatures_revertsOnZeroThreshold() public {
        vm.prank(owner);
        vm.expectRevert("MAV: threshold must be > 0");
        verifier.setRequiredSignatures(0);
    }

    function test_setRequiredSignatures_revertsWhenThresholdExceedsWitnessCount() public {
        vm.prank(owner);
        vm.expectRevert("MAV: exceeds witness count");
        verifier.setRequiredSignatures(3);
    }

    function _deployVerifier(
        address[] memory initialWitnesses,
        uint256 initialThreshold
    ) internal returns (MultiAttestationVerifier deployedVerifier) {
        vm.prank(owner);
        deployedVerifier = new MultiAttestationVerifier(initialWitnesses, initialThreshold);
    }

    function _singleWitness(address witnessAddress) internal pure returns (address[] memory initialWitnesses) {
        initialWitnesses = new address[](1);
        initialWitnesses[0] = witnessAddress;
    }

    function _twoWitnesses() internal view returns (address[] memory initialWitnesses) {
        initialWitnesses = new address[](2);
        initialWitnesses[0] = witnessA;
        initialWitnesses[1] = witnessB;
    }
}
