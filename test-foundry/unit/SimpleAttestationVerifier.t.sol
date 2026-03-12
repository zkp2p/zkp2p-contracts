// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { SimpleAttestationVerifier } from "../../contracts/unifiedVerifier/SimpleAttestationVerifier.sol";

contract SimpleAttestationVerifierTest is Test {
    event WitnessUpdated(address indexed oldWitness, address indexed newWitness);

    uint256 internal constant OWNER_KEY = 0x0A11CE;
    uint256 internal constant NON_OWNER_KEY = 0xB0B;
    uint256 internal constant WITNESS_KEY = 0xCAFE01;
    uint256 internal constant OTHER_ACCOUNT_KEY = 0xCAFE02;

    address internal owner;
    address internal nonOwner;
    address internal witness;
    address internal otherAccount;

    SimpleAttestationVerifier internal verifier;

    bytes32 internal messageHash;
    bytes32 internal subjectDigest;
    bytes internal subjectData;

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        nonOwner = vm.addr(NON_OWNER_KEY);
        witness = vm.addr(WITNESS_KEY);
        otherAccount = vm.addr(OTHER_ACCOUNT_KEY);

        vm.prank(owner);
        verifier = new SimpleAttestationVerifier(witness);

        messageHash = keccak256(bytes("Test attestation message"));
        subjectDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        subjectData = abi.encode(witness);
    }

    function test_constructorDeploysWithExpectedInitialState() public view {
        assertEq(verifier.witness(), witness);
        assertEq(verifier.owner(), owner);
        assertEq(verifier.MIN_WITNESS_SIGNATURES(), 1);
    }

    function test_constructorAllowsZeroWitnessAddress() public {
        vm.prank(owner);
        SimpleAttestationVerifier zeroWitnessVerifier = new SimpleAttestationVerifier(address(0));

        assertEq(zeroWitnessVerifier.witness(), address(0));
        assertEq(zeroWitnessVerifier.owner(), owner);
    }

    function test_setWitnessUpdatesWitnessAndEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(verifier));
        emit WitnessUpdated(witness, otherAccount);

        vm.prank(owner);
        verifier.setWitness(otherAccount);

        assertEq(verifier.witness(), otherAccount);
    }

    function test_setWitnessRevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert("SimpleAttestationVerifier: Zero address");
        verifier.setWitness(address(0));
    }

    function test_setWitnessRevertsWhenCallerIsNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setWitness(otherAccount);
    }

    function test_verifyReturnsTrueWithValidWitnessSignature() public view {
        bytes[] memory signatures = _bytesArray(_sign(WITNESS_KEY, subjectDigest));

        bool result = verifier.verify(subjectDigest, signatures, subjectData);

        assertTrue(result);
    }

    function test_verifyRevertsWhenSignedByNonWitness() public {
        bytes[] memory signatures = _bytesArray(_sign(OTHER_ACCOUNT_KEY, subjectDigest));

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        verifier.verify(subjectDigest, signatures, subjectData);
    }

    function test_verifyRevertsWhenWitnessSignsWrongMessage() public {
        bytes32 wrongMessageHash = keccak256(bytes("Wrong message"));
        bytes32 wrongDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", wrongMessageHash));
        bytes[] memory signatures = _bytesArray(_sign(WITNESS_KEY, wrongDigest));

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        verifier.verify(subjectDigest, signatures, subjectData);
    }

    function test_verifyRevertsWhenSignatureIsMalformed() public {
        bytes[] memory signatures = _bytesArray(hex"1234");

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        verifier.verify(subjectDigest, signatures, subjectData);
    }

    function test_verifyRevertsWhenSignatureIsEmptyBytes() public {
        bytes[] memory signatures = _bytesArray(hex"");

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        verifier.verify(subjectDigest, signatures, subjectData);
    }

    function test_verifyRevertsWhenNoSignaturesProvided() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        verifier.verify(subjectDigest, new bytes[](0), subjectData);
    }

    function test_verifySucceedsWhenMultipleSignaturesIncludeWitness() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS_KEY, subjectDigest),
            _sign(OTHER_ACCOUNT_KEY, subjectDigest)
        );

        bool result = verifier.verify(subjectDigest, signatures, subjectData);

        assertTrue(result);
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _bytesArray(bytes memory value0) internal pure returns (bytes[] memory values) {
        values = new bytes[](1);
        values[0] = value0;
    }

    function _bytesArray(bytes memory value0, bytes memory value1) internal pure returns (bytes[] memory values) {
        values = new bytes[](2);
        values[0] = value0;
        values[1] = value1;
    }
}
