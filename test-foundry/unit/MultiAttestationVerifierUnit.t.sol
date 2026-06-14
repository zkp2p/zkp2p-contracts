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

    function test_resolveAttestors_emptyDataReturnsWitnessSet() public view {
        (address[] memory attestors, uint256 threshold) = verifier.resolveAttestors("");

        assertEq(attestors.length, 2);
        assertEq(attestors[0], witnessA);
        assertEq(attestors[1], witnessB);
        assertEq(threshold, 1);
    }

    function test_resolveAttestors_revertsOnNonEmptyUntaggedData() public {
        // Legacy non-empty deposit data format: bare abi-encoded address array
        bytes memory legacyData = abi.encode(_singleWitness(witnessC));

        vm.expectRevert("MAV: invalid deposit attestors tag");
        verifier.resolveAttestors(legacyData);
    }

    function test_resolveAttestors_revertsOnShortNonEmptyData() public {
        vm.expectRevert("MAV: invalid deposit attestors tag");
        verifier.resolveAttestors(hex"1234");
    }

    function test_resolveAttestors_taggedDataReturnsWitnessesPlusDepositSet() public {
        address customAttestor = makeAddr("customAttestor");
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(customAttestor), 1);

        (address[] memory attestors, uint256 threshold) = verifier.resolveAttestors(depositAttestorsData);

        assertEq(attestors.length, 3);
        assertEq(attestors[0], witnessA);
        assertEq(attestors[1], witnessB);
        assertEq(attestors[2], customAttestor);
        assertEq(threshold, 1);
    }

    function test_resolveAttestors_revertsOnEmptyDepositAttestors() public {
        bytes memory depositAttestorsData = _encodeDepositAttestors(new address[](0), 1);

        vm.expectRevert("MAV: empty deposit attestors");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsWhenDepositDataExceedsMaxAttestors() public {
        uint256 attestorCount = verifier.MAX_DEPOSIT_ATTESTORS() + 1;
        address[] memory attestors = new address[](attestorCount);
        for (uint256 i = 0; i < attestorCount; i++) {
            attestors[i] = vm.addr(i + 1);
        }
        bytes memory depositAttestorsData = _encodeDepositAttestors(attestors, 1);

        vm.expectRevert("MAV: too many deposit attestors");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsOnZeroDepositThreshold() public {
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(witnessC), 0);

        vm.expectRevert("MAV: deposit threshold must be > 0");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsWhenDepositThresholdExceedsCount() public {
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(witnessC), 4);

        vm.expectRevert("MAV: deposit threshold exceeds count");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsWhenDepositThresholdBelowDefault() public {
        MultiAttestationVerifier thresholdTwoVerifier = _deployVerifier(_twoWitnesses(), 2);
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(witnessC), 1);

        vm.expectRevert("MAV: deposit threshold below default");
        thresholdTwoVerifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsOnZeroDepositAttestor() public {
        address[] memory attestors = new address[](2);
        attestors[0] = witnessC;
        attestors[1] = address(0);
        bytes memory depositAttestorsData = _encodeDepositAttestors(attestors, 1);

        vm.expectRevert("MAV: zero deposit attestor");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsOnDuplicateDepositAttestor() public {
        address[] memory attestors = new address[](2);
        attestors[0] = witnessC;
        attestors[1] = witnessC;
        bytes memory depositAttestorsData = _encodeDepositAttestors(attestors, 1);

        vm.expectRevert("MAV: duplicate deposit attestor");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsWhenDepositAttestorDuplicatesWitness() public {
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(witnessA), 1);

        vm.expectRevert("MAV: duplicate deposit attestor");
        verifier.resolveAttestors(depositAttestorsData);
    }

    function test_resolveAttestors_revertsOnTaggedButMalformedData() public {
        bytes memory malformedData = abi.encodePacked(verifier.DEPOSIT_ATTESTORS_TAG());

        vm.expectRevert();
        verifier.resolveAttestors(malformedData);
    }

    /* ============ verify with deposit attestors ============ */

    function test_verify_depositAttestorsAcceptCustomAttestorSignature() public {
        (address customAttestor, uint256 customAttestorKey) = makeAddrAndKey("customAttestor");
        bytes32 digest = keccak256("attestation digest");

        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signDigest(customAttestorKey, digest);

        bool isValid = verifier.verify(digest, signatures, _encodeDepositAttestors(_singleAttestor(customAttestor), 1));

        assertTrue(isValid);
    }

    function test_verify_depositAttestorsAcceptWitnessAndCustomAttestorSignature() public {
        (address witness, uint256 witnessKey) = makeAddrAndKey("witness");
        (address customAttestor, uint256 customAttestorKey) = makeAddrAndKey("customAttestor");

        MultiAttestationVerifier signingVerifier = _deployVerifier(_singleWitness(witness), 1);

        bytes32 digest = keccak256("attestation digest");
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _signDigest(witnessKey, digest);
        signatures[1] = _signDigest(customAttestorKey, digest);

        bool isValid = signingVerifier.verify(
            digest,
            signatures,
            _encodeDepositAttestors(_singleAttestor(customAttestor), 2)
        );

        assertTrue(isValid);
    }

    function test_verify_depositAttestorsAcceptWitnessSignature() public {
        (address witness, uint256 witnessKey) = makeAddrAndKey("witness");
        address customAttestor = makeAddr("customAttestor");

        MultiAttestationVerifier signingVerifier = _deployVerifier(_singleWitness(witness), 1);

        bytes32 digest = keccak256("attestation digest");
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signDigest(witnessKey, digest);
        bytes memory depositAttestorsData = _encodeDepositAttestors(_singleAttestor(customAttestor), 1);

        // Sanity: the witness signature verifies without deposit attestors
        assertTrue(signingVerifier.verify(digest, signatures, ""));

        assertTrue(signingVerifier.verify(digest, signatures, depositAttestorsData));
    }

    function _encodeDepositAttestors(
        address[] memory attestors,
        uint256 threshold
    ) internal view returns (bytes memory depositAttestorsData) {
        depositAttestorsData = abi.encode(verifier.DEPOSIT_ATTESTORS_TAG(), attestors, threshold);
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

    function _singleAttestor(address attestor) internal pure returns (address[] memory attestors) {
        attestors = new address[](1);
        attestors[0] = attestor;
    }

    function _twoWitnesses() internal view returns (address[] memory initialWitnesses) {
        initialWitnesses = new address[](2);
        initialWitnesses[0] = witnessA;
        initialWitnesses[1] = witnessB;
    }
}
