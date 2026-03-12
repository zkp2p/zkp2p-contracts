// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { ThresholdSigVerifierUtilsMock } from "../../contracts/mocks/ThresholdSigVerifierUtilsMock.sol";

contract ThresholdSigVerifierUtilsTest is Test {
    ThresholdSigVerifierUtilsMock internal thresholdVerifier;

    uint256 internal constant WITNESS1_KEY = 0xA11CE01;
    uint256 internal constant WITNESS2_KEY = 0xA11CE02;
    uint256 internal constant WITNESS3_KEY = 0xA11CE03;
    uint256 internal constant WITNESS4_KEY = 0xA11CE04;
    uint256 internal constant WITNESS5_KEY = 0xA11CE05;
    uint256 internal constant WITNESS6_KEY = 0xA11CE06;
    uint256 internal constant WITNESS7_KEY = 0xA11CE07;
    uint256 internal constant WITNESS8_KEY = 0xA11CE08;
    uint256 internal constant WITNESS9_KEY = 0xA11CE09;
    uint256 internal constant WITNESS10_KEY = 0xA11CE10;
    uint256 internal constant NON_WITNESS_KEY = 0xBADBAD01;

    address internal witness1;
    address internal witness2;
    address internal witness3;
    address internal witness4;
    address internal witness5;
    address internal witness6;
    address internal witness7;
    address internal witness8;
    address internal witness9;
    address internal witness10;
    address internal nonWitness;

    bytes32 internal messageHash;
    bytes32 internal ethSignedMessageHash;

    function setUp() public {
        thresholdVerifier = new ThresholdSigVerifierUtilsMock();

        witness1 = vm.addr(WITNESS1_KEY);
        witness2 = vm.addr(WITNESS2_KEY);
        witness3 = vm.addr(WITNESS3_KEY);
        witness4 = vm.addr(WITNESS4_KEY);
        witness5 = vm.addr(WITNESS5_KEY);
        witness6 = vm.addr(WITNESS6_KEY);
        witness7 = vm.addr(WITNESS7_KEY);
        witness8 = vm.addr(WITNESS8_KEY);
        witness9 = vm.addr(WITNESS9_KEY);
        witness10 = vm.addr(WITNESS10_KEY);
        nonWitness = vm.addr(NON_WITNESS_KEY);

        messageHash = keccak256(bytes("Test message for signature verification"));
        ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
    }

    function test_verifyWitnessSignaturesSingleWitnessThresholdOne() public view {
        bytes[] memory signatures = _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash));
        address[] memory witnesses = _addressArray(witness1);

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            witnesses,
            1
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesMultipleWitnessesMeetingExactThreshold() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash)
        );
        address[] memory witnesses = _addressArray(witness1, witness2, witness3);

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            witnesses,
            3
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesWithMoreSignaturesThanThreshold() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash),
            _sign(WITNESS4_KEY, ethSignedMessageHash)
        );
        address[] memory witnesses = _addressArray(witness1, witness2, witness3, witness4);

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            witnesses,
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesWithOrderedSignatures() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2, witness3),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesWithReverseOrderedSignatures() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS3_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS1_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2, witness3),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesWithRandomOrderedSignatures() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash),
            _sign(WITNESS1_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2, witness3),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesRevertsWhenThresholdIsZero() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold must be > 0");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash)),
            _addressArray(witness1),
            0
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenThresholdExceedsSignatures() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash)),
            _addressArray(witness1, witness2),
            2
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenThresholdExceedsWitnesses() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds witnesses");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash), _sign(WITNESS2_KEY, ethSignedMessageHash)),
            _addressArray(witness1),
            2
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenNotEnoughValidWitnesses() public {
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash), _sign(NON_WITNESS_KEY, ethSignedMessageHash)),
            _addressArray(witness1, witness2),
            2
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenSomeValidExistButBelowThreshold() public {
        bytes32 wrongMessageHash = keccak256(bytes("Different message"));
        bytes32 wrongEthSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", wrongMessageHash)
        );

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(
                _sign(WITNESS1_KEY, ethSignedMessageHash),
                _sign(NON_WITNESS_KEY, ethSignedMessageHash),
                _sign(WITNESS2_KEY, ethSignedMessageHash),
                _sign(WITNESS3_KEY, wrongEthSignedMessageHash)
            ),
            _addressArray(witness1, witness2, witness3, witness4),
            3
        );
    }

    function test_verifyWitnessSignaturesExactFailureScenarioPassesWithThreeValid() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash),
            _sign(NON_WITNESS_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2, witness3, witness4),
            3
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesRevertsOnInvalidSignature() public {
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(NON_WITNESS_KEY, ethSignedMessageHash)),
            _addressArray(witness1),
            1
        );
    }

    function test_verifyWitnessSignaturesCountsUniqueWitnessesOnly() public {
        bytes memory duplicateSignature = _sign(WITNESS1_KEY, ethSignedMessageHash);

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(duplicateSignature, duplicateSignature),
            _addressArray(witness1, witness2),
            2
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenSignatureArrayIsEmpty() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            new bytes[](0),
            _addressArray(witness1),
            1
        );
    }

    function test_verifyWitnessSignaturesRevertsWhenWitnessArrayIsEmpty() public {
        vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds witnesses");
        thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash)),
            new address[](0),
            1
        );
    }

    function test_verifyWitnessSignaturesHandlesMaximumThresholdOfTenWitnesses() public view {
        uint256[] memory keys = new uint256[](10);
        keys[0] = WITNESS1_KEY;
        keys[1] = WITNESS2_KEY;
        keys[2] = WITNESS3_KEY;
        keys[3] = WITNESS4_KEY;
        keys[4] = WITNESS5_KEY;
        keys[5] = WITNESS6_KEY;
        keys[6] = WITNESS7_KEY;
        keys[7] = WITNESS8_KEY;
        keys[8] = WITNESS9_KEY;
        keys[9] = WITNESS10_KEY;

        address[] memory witnesses = new address[](10);
        bytes[] memory signatures = new bytes[](10);
        for (uint256 index = 0; index < keys.length; index++) {
            witnesses[index] = vm.addr(keys[index]);
            signatures[index] = _sign(keys[index], ethSignedMessageHash);
        }

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            witnesses,
            10
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesIgnoresNonWitnessSignaturesWhenThresholdMet() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(NON_WITNESS_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesHandlesDuplicateWitnessesInWitnessArray() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness1, witness2),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesHandlesEarlyThresholdSatisfaction() public view {
        bytes[] memory signatures = _bytesArray(
            _sign(WITNESS1_KEY, ethSignedMessageHash),
            _sign(WITNESS2_KEY, ethSignedMessageHash),
            _sign(WITNESS3_KEY, ethSignedMessageHash),
            _sign(WITNESS4_KEY, ethSignedMessageHash),
            _sign(WITNESS5_KEY, ethSignedMessageHash)
        );

        bool result = thresholdVerifier.verifyWitnessSignatures(
            ethSignedMessageHash,
            signatures,
            _addressArray(witness1, witness2, witness3, witness4, witness5),
            2
        );

        assertTrue(result);
    }

    function test_verifyWitnessSignaturesRevertsOnMalformedShortSignature() public {
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            messageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash), hex"1234"),
            _addressArray(witness1, witness2),
            2
        );
    }

    function test_verifyWitnessSignaturesRevertsOnEmptySignatureBytes() public {
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        thresholdVerifier.verifyWitnessSignatures(
            messageHash,
            _bytesArray(_sign(WITNESS1_KEY, ethSignedMessageHash), hex""),
            _addressArray(witness1, witness2),
            2
        );
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

    function _bytesArray(bytes memory value0, bytes memory value1, bytes memory value2)
        internal
        pure
        returns (bytes[] memory values)
    {
        values = new bytes[](3);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
    }

    function _bytesArray(bytes memory value0, bytes memory value1, bytes memory value2, bytes memory value3)
        internal
        pure
        returns (bytes[] memory values)
    {
        values = new bytes[](4);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
        values[3] = value3;
    }

    function _bytesArray(
        bytes memory value0,
        bytes memory value1,
        bytes memory value2,
        bytes memory value3,
        bytes memory value4
    ) internal pure returns (bytes[] memory values) {
        values = new bytes[](5);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
        values[3] = value3;
        values[4] = value4;
    }

    function _addressArray(address value0) internal pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = value0;
    }

    function _addressArray(address value0, address value1) internal pure returns (address[] memory values) {
        values = new address[](2);
        values[0] = value0;
        values[1] = value1;
    }

    function _addressArray(address value0, address value1, address value2)
        internal
        pure
        returns (address[] memory values)
    {
        values = new address[](3);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
    }

    function _addressArray(address value0, address value1, address value2, address value3)
        internal
        pure
        returns (address[] memory values)
    {
        values = new address[](4);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
        values[3] = value3;
    }

    function _addressArray(address value0, address value1, address value2, address value3, address value4)
        internal
        pure
        returns (address[] memory values)
    {
        values = new address[](5);
        values[0] = value0;
        values[1] = value1;
        values[2] = value2;
        values[3] = value3;
        values[4] = value4;
    }
}
