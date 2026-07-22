// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ThresholdSigVerifierUtilsMock} from "contracts/mocks/ThresholdSigVerifierUtilsMock.sol";

contract ThresholdSignatureTest is Test {
    string internal constant THRESHOLD_ERROR = "ThresholdSigVerifierUtils: Not enough valid witness signatures";

    ThresholdSigVerifierUtilsMock internal verifier;
    bytes32 internal messageHash;
    bytes32 internal digest;

    function setUp() public {
        verifier = new ThresholdSigVerifierUtilsMock();
        messageHash = keccak256("Test message for signature verification");
        digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
    }

    function _key(uint256 index) internal pure returns (uint256) {
        return 10_000 + index;
    }

    function _sign(uint256 index, bytes32 signedDigest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key(index), signedDigest);
        return abi.encodePacked(r, s, v);
    }

    function _witness(uint256 index) internal pure returns (address) {
        return vm.addr(_key(index));
    }

    function _signatures(uint256 count) internal view returns (bytes[] memory signatures) {
        signatures = new bytes[](count);
        for (uint256 index = 0; index < count; index++) {
            signatures[index] = _sign(index, digest);
        }
    }

    function _witnesses(uint256 count) internal pure returns (address[] memory witnesses) {
        witnesses = new address[](count);
        for (uint256 index = 0; index < count; index++) {
            witnesses[index] = _witness(index);
        }
    }

    function _verify(bytes[] memory signatures, address[] memory witnesses, uint256 threshold)
        internal
        view
        returns (bool)
    {
        return verifier.verifyWitnessSignatures(digest, signatures, witnesses, threshold);
    }

    function test_SingleWitnessMeetsThresholdOne() public view {
        assertTrue(_verify(_signatures(1), _witnesses(1), 1));
    }

    function test_MultipleWitnessesMeetExactThreshold() public view {
        assertTrue(_verify(_signatures(3), _witnesses(3), 3));
    }

    function test_ExcessSignaturesAreAcceptedAfterThreshold() public view {
        assertTrue(_verify(_signatures(4), _witnesses(4), 2));
    }

    function test_SignatureOrderDoesNotAffectThreshold() public view {
        bytes[] memory signatures = _signatures(3);
        address[] memory witnesses = _witnesses(3);
        assertTrue(_verify(signatures, witnesses, 2));

        (signatures[0], signatures[2]) = (signatures[2], signatures[0]);
        assertTrue(_verify(signatures, witnesses, 2));

        (signatures[0], signatures[1]) = (signatures[1], signatures[0]);
        assertTrue(_verify(signatures, witnesses, 2));
    }

    function test_RejectsZeroThreshold() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold must be > 0"));
        _verify(_signatures(1), _witnesses(1), 0);
    }

    function test_RejectsThresholdAboveSignatureCount() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold exceeds signatures"));
        _verify(_signatures(1), _witnesses(2), 2);
    }

    function test_RejectsThresholdAboveWitnessCount() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold exceeds witnesses"));
        _verify(_signatures(2), _witnesses(1), 2);
    }

    function test_RejectsMixedSignaturesBelowThreshold() public {
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _sign(0, digest);
        signatures[1] = _sign(9, digest);
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(signatures, _witnesses(2), 2);
    }

    function test_ExactFailureScenarioDistinguishesTwoFromThreeValidSigners() public {
        address[] memory witnesses = _witnesses(4);
        bytes[] memory threeValid = new bytes[](4);
        threeValid[0] = _sign(0, digest);
        threeValid[1] = _sign(1, digest);
        threeValid[2] = _sign(2, digest);
        threeValid[3] = _sign(9, digest);
        assertTrue(_verify(threeValid, witnesses, 3));

        bytes[] memory twoValid = new bytes[](4);
        twoValid[0] = _sign(0, digest);
        twoValid[1] = _sign(9, digest);
        twoValid[2] = _sign(1, digest);
        twoValid[3] = _sign(2, keccak256("Different message"));
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(twoValid, witnesses, 3);
    }

    function test_RejectsInvalidSignerAndDuplicateSigner() public {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(9, digest);
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(signatures, _witnesses(1), 1);

        bytes memory duplicate = _sign(0, digest);
        signatures = new bytes[](2);
        signatures[0] = duplicate;
        signatures[1] = duplicate;
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(signatures, _witnesses(2), 2);
    }

    function test_RejectsEmptySignatureOrWitnessArrays() public {
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold exceeds signatures"));
        _verify(new bytes[](0), _witnesses(1), 1);
        vm.expectRevert(bytes("ThresholdSigVerifierUtils: req threshold exceeds witnesses"));
        _verify(_signatures(1), new address[](0), 1);
    }

    function test_HandlesTenWitnessThreshold() public view {
        assertTrue(_verify(_signatures(10), _witnesses(10), 10));
    }

    function test_IgnoresNonWitnessSignaturesWhenEnoughWitnessesSign() public view {
        bytes[] memory signatures = new bytes[](3);
        signatures[0] = _sign(0, digest);
        signatures[1] = _sign(9, digest);
        signatures[2] = _sign(1, digest);
        assertTrue(_verify(signatures, _witnesses(2), 2));
    }

    function test_DuplicateWitnessEntriesDoNotPreventDistinctSignerThreshold() public view {
        bytes[] memory signatures = _signatures(2);
        address[] memory witnesses = new address[](3);
        witnesses[0] = _witness(0);
        witnesses[1] = _witness(0);
        witnesses[2] = _witness(1);
        assertTrue(_verify(signatures, witnesses, 2));
    }

    function test_EarlyThresholdSuccessIgnoresUnneededLaterSignatures() public view {
        assertTrue(_verify(_signatures(5), _witnesses(5), 2));
    }

    function test_RejectsMalformedAndEmptySignatureBytes() public {
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _sign(0, messageHash);
        signatures[1] = hex"1234";
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        verifier.verifyWitnessSignatures(messageHash, signatures, _witnesses(2), 2);

        signatures[1] = "";
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        verifier.verifyWitnessSignatures(messageHash, signatures, _witnesses(2), 2);
    }
}
