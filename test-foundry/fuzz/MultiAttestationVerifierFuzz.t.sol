// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { MultiAttestationVerifier } from "../../contracts/unifiedVerifier/MultiAttestationVerifier.sol";

contract MultiAttestationVerifierFuzz is Test {
    uint256 internal constant MAX_WITNESSES = 5;

    address public owner;

    function setUp() public {
        owner = makeAddr("owner");
    }

    function testFuzz_addRemoveAddRoundTripPreservesWitnessCount(uint256 newWitnessPrivateKey) public {
        address[] memory initialWitnesses = new address[](2);
        initialWitnesses[0] = vm.addr(1);
        initialWitnesses[1] = vm.addr(2);

        MultiAttestationVerifier verifier = _deployVerifier(initialWitnesses, 1);

        newWitnessPrivateKey = bound(newWitnessPrivateKey, 3, type(uint128).max);
        address newWitness = vm.addr(newWitnessPrivateKey);

        uint256 initialCount = verifier.witnessCount();

        vm.prank(owner);
        verifier.addWitness(newWitness);
        uint256 countAfterFirstAdd = verifier.witnessCount();

        vm.prank(owner);
        verifier.removeWitness(newWitness);
        uint256 countAfterRemove = verifier.witnessCount();

        vm.prank(owner);
        verifier.addWitness(newWitness);

        assertEq(countAfterFirstAdd, initialCount + 1);
        assertEq(countAfterRemove, initialCount);
        assertEq(verifier.witnessCount(), countAfterFirstAdd);
    }

    function testFuzz_verifyMatchesRandomSubset(
        uint8 witnessCountSeed,
        uint8 thresholdSeed,
        uint256 signatureMaskSeed,
        uint256 messageSeed
    ) public {
        uint256 witnessCount = bound(uint256(witnessCountSeed), 1, MAX_WITNESSES);
        uint256 requiredSignatures = bound(uint256(thresholdSeed), 1, witnessCount);

        (address[] memory witnesses, uint256[] memory privateKeys) = _buildWitnessSet(witnessCount);
        MultiAttestationVerifier verifier = _deployVerifier(witnesses, requiredSignatures);

        bytes32 messageHash = keccak256(
            abi.encodePacked("multi-attestation-verifier-fuzz", messageSeed, witnessCount, requiredSignatures)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        uint256 selectionSpace = uint256(1) << witnessCount;
        uint256 signatureMask = signatureMaskSeed % selectionSpace;
        uint256 selectedCount = _countSelectedWitnesses(signatureMask, witnessCount);

        bytes[] memory signatures = new bytes[](selectedCount);
        uint256 signatureIndex = 0;

        for (uint256 witnessIndex = 0; witnessIndex < witnessCount; witnessIndex++) {
            if ((signatureMask & (uint256(1) << witnessIndex)) != 0) {
                signatures[signatureIndex] = _signDigest(privateKeys[witnessIndex], digest);
                signatureIndex++;
            }
        }

        bool shouldVerify = selectedCount >= requiredSignatures;

        if (shouldVerify) {
            bool isValid = verifier.verify(digest, signatures, "");
            assertTrue(isValid);
        } else {
            vm.expectRevert();
            verifier.verify(digest, signatures, "");
        }
    }

    function _deployVerifier(
        address[] memory initialWitnesses,
        uint256 initialThreshold
    ) internal returns (MultiAttestationVerifier deployedVerifier) {
        vm.prank(owner);
        deployedVerifier = new MultiAttestationVerifier(initialWitnesses, initialThreshold);
    }

    function _buildWitnessSet(
        uint256 witnessCount
    ) internal pure returns (address[] memory witnesses, uint256[] memory privateKeys) {
        witnesses = new address[](witnessCount);
        privateKeys = new uint256[](witnessCount);

        for (uint256 witnessIndex = 0; witnessIndex < witnessCount; witnessIndex++) {
            uint256 privateKey = uint256(
                keccak256(abi.encodePacked("multi-attestation-fuzz-witness", witnessCount, witnessIndex))
            );

            if (privateKey == 0) {
                privateKey = witnessIndex + 1;
            }

            privateKeys[witnessIndex] = privateKey;
            witnesses[witnessIndex] = vm.addr(privateKey);
        }
    }

    function _countSelectedWitnesses(
        uint256 signatureMask,
        uint256 witnessCount
    ) internal pure returns (uint256 selectedCount) {
        for (uint256 witnessIndex = 0; witnessIndex < witnessCount; witnessIndex++) {
            if ((signatureMask & (uint256(1) << witnessIndex)) != 0) {
                selectedCount++;
            }
        }
    }

    function _signDigest(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
