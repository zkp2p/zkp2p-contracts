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

    /* ============ resolveAttestors ============ */

    function test_resolveAttestors_emptyDataReturnsProtocolSet() public {
        (address[] memory attestors, uint256 threshold) = verifier.resolveAttestors("");

        assertEq(attestors.length, 2);
        assertEq(attestors[0], witnessA);
        assertEq(attestors[1], witnessB);
        assertEq(threshold, 1);
    }

    function test_resolveAttestors_untaggedDataReturnsProtocolSet() public {
        // Legacy deposit data format: bare abi-encoded address array
        bytes memory legacyData = abi.encode(_singleWitness(witnessC));

        (address[] memory attestors, uint256 threshold) = verifier.resolveAttestors(legacyData);

        assertEq(attestors.length, 2);
        assertEq(attestors[0], witnessA);
        assertEq(attestors[1], witnessB);
        assertEq(threshold, 1);
    }

    function test_resolveAttestors_taggedDataReturnsOverrideSet() public {
        address customAttestor = makeAddr("customAttestor");
        bytes memory overrideData = _encodeOverride(_singleWitness(customAttestor), 1);

        (address[] memory attestors, uint256 threshold) = verifier.resolveAttestors(overrideData);

        assertEq(attestors.length, 1);
        assertEq(attestors[0], customAttestor);
        assertEq(threshold, 1);
    }

    function test_resolveAttestors_revertsOnEmptyOverrideAttestors() public {
        bytes memory overrideData = _encodeOverride(new address[](0), 1);

        vm.expectRevert("MAV: empty override attestors");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsWhenOverrideExceedsMaxAttestors() public {
        uint256 attestorCount = verifier.MAX_OVERRIDE_ATTESTORS() + 1;
        address[] memory attestors = new address[](attestorCount);
        for (uint256 i = 0; i < attestorCount; i++) {
            attestors[i] = vm.addr(i + 1);
        }
        bytes memory overrideData = _encodeOverride(attestors, 1);

        vm.expectRevert("MAV: too many override attestors");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsOnZeroOverrideThreshold() public {
        bytes memory overrideData = _encodeOverride(_singleWitness(witnessC), 0);

        vm.expectRevert("MAV: override threshold must be > 0");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsWhenOverrideThresholdExceedsCount() public {
        bytes memory overrideData = _encodeOverride(_singleWitness(witnessC), 2);

        vm.expectRevert("MAV: override threshold exceeds count");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsOnZeroOverrideAttestor() public {
        address[] memory attestors = new address[](2);
        attestors[0] = witnessC;
        attestors[1] = address(0);
        bytes memory overrideData = _encodeOverride(attestors, 1);

        vm.expectRevert("MAV: zero override attestor");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsOnDuplicateOverrideAttestor() public {
        address[] memory attestors = new address[](2);
        attestors[0] = witnessC;
        attestors[1] = witnessC;
        bytes memory overrideData = _encodeOverride(attestors, 1);

        vm.expectRevert("MAV: duplicate override attestor");
        verifier.resolveAttestors(overrideData);
    }

    function test_resolveAttestors_revertsOnTaggedButMalformedData() public {
        bytes memory malformedData = abi.encodePacked(verifier.ATTESTOR_OVERRIDE_TAG());

        vm.expectRevert();
        verifier.resolveAttestors(malformedData);
    }

    /* ============ verify with override ============ */

    function test_verify_overrideAcceptsCustomAttestorSignature() public {
        (address customAttestor, uint256 customAttestorKey) = makeAddrAndKey("customAttestor");
        bytes32 digest = keccak256("attestation digest");

        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signDigest(customAttestorKey, digest);

        bool isValid = verifier.verify(digest, signatures, _encodeOverride(_singleWitness(customAttestor), 1));

        assertTrue(isValid);
    }

    function test_verify_overrideRejectsProtocolWitnessSignature() public {
        (address protocolWitness, uint256 protocolWitnessKey) = makeAddrAndKey("protocolWitness");
        address customAttestor = makeAddr("customAttestor");

        MultiAttestationVerifier signingVerifier = _deployVerifier(_singleWitness(protocolWitness), 1);

        bytes32 digest = keccak256("attestation digest");
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signDigest(protocolWitnessKey, digest);
        bytes memory overrideData = _encodeOverride(_singleWitness(customAttestor), 1);

        // Sanity: the protocol witness signature verifies without an override
        assertTrue(signingVerifier.verify(digest, signatures, ""));

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        signingVerifier.verify(digest, signatures, overrideData);
    }

    function _encodeOverride(
        address[] memory attestors,
        uint256 threshold
    ) internal view returns (bytes memory overrideData) {
        overrideData = abi.encode(verifier.ATTESTOR_OVERRIDE_TAG(), attestors, threshold);
    }

    function _signDigest(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
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
