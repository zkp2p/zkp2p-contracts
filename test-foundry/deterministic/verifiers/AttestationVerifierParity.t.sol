// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";

abstract contract AttestationVerifierParityBase is Test {
    uint256 internal constant WITNESS_A_KEY = 0xA11CE;
    uint256 internal constant WITNESS_B_KEY = 0xB0B;
    uint256 internal constant WITNESS_C_KEY = 0xCA11;
    uint256 internal constant OTHER_KEY = 0xBAD;

    address internal witnessA;
    address internal witnessB;
    address internal witnessC;
    address internal other;
    address internal nonOwner;
    bytes32 internal messageHash;
    bytes32 internal digest;

    function setUp() public virtual {
        witnessA = vm.addr(WITNESS_A_KEY);
        witnessB = vm.addr(WITNESS_B_KEY);
        witnessC = vm.addr(WITNESS_C_KEY);
        other = vm.addr(OTHER_KEY);
        nonOwner = makeAddr("nonOwner");
        messageHash = keccak256("Test attestation message");
        digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
    }

    function _signature(uint256 privateKey, bytes32 signedDigest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, signedDigest);
        return abi.encodePacked(r, s, v);
    }

    function _oneSignature(uint256 privateKey) internal view returns (bytes[] memory signatures) {
        signatures = new bytes[](1);
        signatures[0] = _signature(privateKey, digest);
    }

    function _witnesses(address a) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = a;
    }

    function _witnesses(address a, address b) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = a;
        values[1] = b;
    }

    function _witnesses(address a, address b, address c) internal pure returns (address[] memory values) {
        values = new address[](3);
        values[0] = a;
        values[1] = b;
        values[2] = c;
    }
}

contract SimpleAttestationVerifierParityTest is AttestationVerifierParityBase {
    event WitnessUpdated(address indexed oldWitness, address indexed newWitness);

    SimpleAttestationVerifier internal verifier;

    function setUp() public override {
        super.setUp();
        verifier = new SimpleAttestationVerifier(witnessA);
    }

    function test_ConstructorSetsWitnessOwnerAndThreshold() public view {
        assertEq(verifier.witness(), witnessA);
        assertEq(verifier.owner(), address(this));
        assertEq(verifier.MIN_WITNESS_SIGNATURES(), 1);
    }

    function test_ConstructorAllowsZeroWitness() public {
        SimpleAttestationVerifier zeroWitnessVerifier = new SimpleAttestationVerifier(address(0));
        assertEq(zeroWitnessVerifier.witness(), address(0));
    }

    function test_SetWitnessUpdatesStateAndEmits() public {
        vm.expectEmit(true, true, false, true, address(verifier));
        emit WitnessUpdated(witnessA, witnessB);
        verifier.setWitness(witnessB);
        assertEq(verifier.witness(), witnessB);
    }

    function test_SetWitnessRejectsZeroAndNonOwner() public {
        vm.expectRevert(bytes("SimpleAttestationVerifier: Zero address"));
        verifier.setWitness(address(0));
        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setWitness(witnessB);
    }

    function test_VerifyReturnsTrueForWitnessSignature() public {
        assertTrue(verifier.verify(digest, _oneSignature(WITNESS_A_KEY), abi.encode(witnessA)));
    }

    function test_VerifyRejectsNonWitnessSignature() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        verifier.verify(digest, _oneSignature(OTHER_KEY), abi.encode(witnessA));
    }

    function test_VerifyRejectsWitnessSignatureForWrongDigest() public {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signature(WITNESS_A_KEY, keccak256("wrong digest"));
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        verifier.verify(digest, signatures, abi.encode(witnessA));
    }

    function test_VerifyRejectsMalformedAndEmptySignature() public {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = hex"1234";
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        verifier.verify(digest, signatures, "");

        signatures[0] = "";
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        verifier.verify(digest, signatures, "");
    }

    function test_VerifyRejectsMissingSignaturesBeforeWitnessMatching() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold exceeds signatures"));
        verifier.verify(digest, new bytes[](0), "");
    }

    function test_VerifyAcceptsFirstValidSignatureAmongAdditionalSignatures() public {
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _signature(WITNESS_A_KEY, digest);
        signatures[1] = _signature(OTHER_KEY, digest);
        assertTrue(verifier.verify(digest, signatures, ""));
    }
}

contract MultiAttestationVerifierParityTest is AttestationVerifierParityBase {
    event WitnessAdded(address indexed witness);
    event WitnessRemoved(address indexed witness);
    event RequiredSignaturesUpdated(uint256 oldThreshold, uint256 newThreshold);

    MultiAttestationVerifier internal verifier;

    function setUp() public override {
        super.setUp();
        verifier = new MultiAttestationVerifier(_witnesses(witnessA), 1);
    }

    function _verify(MultiAttestationVerifier target, bytes[] memory signatures) internal view returns (bool) {
        return target.verify(digest, signatures, "");
    }

    function test_VerifySingleWitnessThresholdOne() public {
        assertTrue(_verify(verifier, _oneSignature(WITNESS_A_KEY)));
    }

    function test_VerifyEitherAuthorizedWitnessAtThresholdOne() public {
        MultiAttestationVerifier twoWitnesses = new MultiAttestationVerifier(_witnesses(witnessA, witnessB), 1);
        assertTrue(_verify(twoWitnesses, _oneSignature(WITNESS_A_KEY)));
        assertTrue(_verify(twoWitnesses, _oneSignature(WITNESS_B_KEY)));
    }

    function test_VerifyRejectsNonWitnessAtThresholdOne() public {
        MultiAttestationVerifier twoWitnesses = new MultiAttestationVerifier(_witnesses(witnessA, witnessB), 1);
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        _verify(twoWitnesses, _oneSignature(OTHER_KEY));
    }

    function test_VerifyDuplicateSignerCountsOnceButMeetsThresholdOne() public {
        MultiAttestationVerifier twoWitnesses = new MultiAttestationVerifier(_witnesses(witnessA, witnessB), 1);
        bytes memory signature = _signature(WITNESS_A_KEY, digest);
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = signature;
        signatures[1] = signature;
        assertTrue(_verify(twoWitnesses, signatures));
    }

    function test_VerifyTwoDistinctWitnessesMeetThresholdTwo() public {
        MultiAttestationVerifier twoWitnesses = new MultiAttestationVerifier(_witnesses(witnessA, witnessB), 2);
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _signature(WITNESS_A_KEY, digest);
        signatures[1] = _signature(WITNESS_B_KEY, digest);
        assertTrue(_verify(twoWitnesses, signatures));
    }

    function test_VerifyDuplicateSignerDoesNotMeetThresholdTwoOrThree() public {
        MultiAttestationVerifier twoWitnesses = new MultiAttestationVerifier(_witnesses(witnessA, witnessB), 2);
        bytes memory signature = _signature(WITNESS_A_KEY, digest);
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = signature;
        signatures[1] = signature;
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        _verify(twoWitnesses, signatures);

        MultiAttestationVerifier threeWitnesses =
            new MultiAttestationVerifier(_witnesses(witnessA, witnessB, witnessC), 3);
        signatures = new bytes[](3);
        signatures[0] = signature;
        signatures[1] = signature;
        signatures[2] = signature;
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
        _verify(threeWitnesses, signatures);
    }

    function test_ConstructorRejectsZeroDuplicateAndInvalidThresholds() public {
        vm.expectRevert(bytes("MAV: zero witness"));
        new MultiAttestationVerifier(_witnesses(witnessA, address(0)), 1);
        vm.expectRevert(bytes("MAV: duplicate witness"));
        new MultiAttestationVerifier(_witnesses(witnessA, witnessA), 2);
        vm.expectRevert(bytes("MAV: threshold must be > 0"));
        new MultiAttestationVerifier(_witnesses(witnessA), 0);
        vm.expectRevert(bytes("MAV: threshold exceeds count"));
        new MultiAttestationVerifier(_witnesses(witnessA), 2);
    }

    function test_AddWitnessUpdatesSetCountAndEmits() public {
        vm.expectEmit(true, false, false, true, address(verifier));
        emit WitnessAdded(witnessB);
        verifier.addWitness(witnessB);
        assertEq(verifier.witnessCount(), 2);
        assertTrue(verifier.isWitness(witnessB));
    }

    function test_AddWitnessRejectsNonOwnerZeroAndExistingWitness() public {
        vm.prank(nonOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.addWitness(witnessB);
        vm.expectRevert(bytes("MAV: zero witness"));
        verifier.addWitness(address(0));
        vm.expectRevert(bytes("MAV: already a witness"));
        verifier.addWitness(witnessA);
    }

    function test_RemoveWitnessUpdatesSetCountAndEmits() public {
        verifier.addWitness(witnessB);
        vm.expectEmit(true, false, false, true, address(verifier));
        emit WitnessRemoved(witnessB);
        verifier.removeWitness(witnessB);
        assertEq(verifier.witnessCount(), 1);
        assertFalse(verifier.isWitness(witnessB));
    }

    function test_RemoveWitnessRejectsBelowThresholdAndMissingWitness() public {
        vm.expectRevert(bytes("MAV: below threshold"));
        verifier.removeWitness(witnessA);
        assertTrue(verifier.isWitness(witnessA));

        vm.expectRevert(bytes("MAV: not a witness"));
        verifier.removeWitness(witnessC);
    }

    function test_SetRequiredSignaturesUpdatesThresholdAndEmits() public {
        verifier.addWitness(witnessB);
        vm.expectEmit(false, false, false, true, address(verifier));
        emit RequiredSignaturesUpdated(1, 2);
        verifier.setRequiredSignatures(2);
        assertEq(verifier.requiredSignatures(), 2);
    }

    function test_SetRequiredSignaturesRejectsZeroAndAboveWitnessCount() public {
        verifier.addWitness(witnessB);
        vm.expectRevert(bytes("MAV: threshold must be > 0"));
        verifier.setRequiredSignatures(0);
        vm.expectRevert(bytes("MAV: exceeds witness count"));
        verifier.setRequiredSignatures(3);
    }

    function test_ViewHelpersTrackCurrentWitnessMembership() public {
        verifier.addWitness(witnessB);
        verifier.addWitness(witnessC);
        verifier.removeWitness(witnessA);
        address[] memory current = verifier.witnesses();
        assertEq(current.length, 2);
        assertTrue(verifier.isWitness(witnessB));
        assertTrue(verifier.isWitness(witnessC));
        assertFalse(verifier.isWitness(witnessA));
        assertFalse(verifier.isWitness(other));
    }
}
