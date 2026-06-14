// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { MultiAttestationVerifier } from "../../contracts/unifiedVerifier/MultiAttestationVerifier.sol";

contract MultiAttestationVerifierFuzz is Test {
    uint256 internal constant MAX_SIGNERS = 5;

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
        uint256 witnessCount = bound(uint256(witnessCountSeed), 1, MAX_SIGNERS);
        uint256 requiredSignatures = bound(uint256(thresholdSeed), 1, witnessCount);

        (address[] memory witnesses, uint256[] memory privateKeys) = _buildSignerSet(witnessCount);
        MultiAttestationVerifier verifier = _deployVerifier(witnesses, requiredSignatures);

        bytes32 messageHash = keccak256(
            abi.encodePacked("multi-attestation-verifier-fuzz", messageSeed, witnessCount, requiredSignatures)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        uint256 selectionSpace = uint256(1) << witnessCount;
        uint256 signatureMask = signatureMaskSeed % selectionSpace;
        uint256 selectedCount = _countSelectedSigners(signatureMask, witnessCount);

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

    function testFuzz_depositAttestorsVerifyMatchesRandomSubset(
        uint8 attestorCountSeed,
        uint8 thresholdSeed,
        uint256 signatureMaskSeed,
        uint256 messageSeed
    ) public {
        // Deposit attestors are appended to the witness set by construction
        address[] memory witnesses = new address[](2);
        witnesses[0] = vm.addr(1);
        witnesses[1] = vm.addr(2);

        MultiAttestationVerifier verifier = _deployVerifier(witnesses, 1);

        uint256 attestorCount = bound(uint256(attestorCountSeed), 1, verifier.MAX_DEPOSIT_ATTESTORS());
        uint256 combinedCount = witnesses.length + attestorCount;
        uint256 depositThreshold = bound(uint256(thresholdSeed), 1, combinedCount);

        (address[] memory attestors, uint256[] memory privateKeys) = _buildSignerSet(attestorCount);
        bytes memory depositAttestorsData = abi.encode(verifier.DEPOSIT_ATTESTORS_TAG(), attestors, depositThreshold);

        uint256[] memory combinedPrivateKeys = new uint256[](combinedCount);
        combinedPrivateKeys[0] = 1;
        combinedPrivateKeys[1] = 2;
        for (uint256 attestorIndex = 0; attestorIndex < attestorCount; attestorIndex++) {
            combinedPrivateKeys[witnesses.length + attestorIndex] = privateKeys[attestorIndex];
        }

        bytes32 digest = keccak256(
            abi.encodePacked("deposit-attestors-fuzz", messageSeed, attestorCount, depositThreshold)
        );

        uint256 selectionSpace = uint256(1) << combinedCount;
        uint256 signatureMask = signatureMaskSeed % selectionSpace;
        uint256 selectedCount = _countSelectedSigners(signatureMask, combinedCount);

        bytes[] memory signatures = new bytes[](selectedCount);
        uint256 signatureIndex = 0;

        for (uint256 signerIndex = 0; signerIndex < combinedCount; signerIndex++) {
            if ((signatureMask & (uint256(1) << signerIndex)) != 0) {
                signatures[signatureIndex] = _signDigest(combinedPrivateKeys[signerIndex], digest);
                signatureIndex++;
            }
        }

        bool shouldVerify = selectedCount >= depositThreshold;

        if (shouldVerify) {
            assertTrue(verifier.verify(digest, signatures, depositAttestorsData));
        } else {
            vm.expectRevert();
            verifier.verify(digest, signatures, depositAttestorsData);
        }

        // A witness signature alone still satisfies appended deposit attestors when the
        // threshold is one; higher thresholds reject the undersized signature array first.
        bytes[] memory witnessSignatures = new bytes[](1);
        witnessSignatures[0] = _signDigest(1, digest);

        if (depositThreshold > 1) {
            vm.expectRevert("ThresholdSigVerifierUtils: req threshold exceeds signatures");
            verifier.verify(digest, witnessSignatures, depositAttestorsData);
        } else {
            assertTrue(verifier.verify(digest, witnessSignatures, depositAttestorsData));
        }
    }

    function testFuzz_nonEmptyUntaggedDataReverts(bytes memory data) public {
        address[] memory witnesses = new address[](2);
        witnesses[0] = vm.addr(1);
        witnesses[1] = vm.addr(2);

        MultiAttestationVerifier verifier = _deployVerifier(witnesses, 2);

        vm.assume(data.length > 0);
        if (data.length >= 32) {
            bytes32 firstWord;
            assembly {
                firstWord := mload(add(data, 32))
            }
            vm.assume(firstWord != verifier.DEPOSIT_ATTESTORS_TAG());
        }

        vm.expectRevert("MAV: invalid deposit attestors tag");
        verifier.resolveAttestors(data);
    }

    function _deployVerifier(
        address[] memory initialWitnesses,
        uint256 initialThreshold
    ) internal returns (MultiAttestationVerifier deployedVerifier) {
        vm.prank(owner);
        deployedVerifier = new MultiAttestationVerifier(initialWitnesses, initialThreshold);
    }

    function _buildSignerSet(
        uint256 signerCount
    ) internal pure returns (address[] memory signers, uint256[] memory privateKeys) {
        signers = new address[](signerCount);
        privateKeys = new uint256[](signerCount);

        for (uint256 signerIndex = 0; signerIndex < signerCount; signerIndex++) {
            uint256 privateKey = uint256(
                keccak256(abi.encodePacked("multi-attestation-fuzz-signer", signerCount, signerIndex))
            );

            if (privateKey == 0) {
                privateKey = signerIndex + 1;
            }

            privateKeys[signerIndex] = privateKey;
            signers[signerIndex] = vm.addr(privateKey);
        }
    }

    function _countSelectedSigners(
        uint256 signatureMask,
        uint256 signerCount
    ) internal pure returns (uint256 selectedCount) {
        for (uint256 signerIndex = 0; signerIndex < signerCount; signerIndex++) {
            if ((signatureMask & (uint256(1) << signerIndex)) != 0) {
                selectedCount++;
            }
        }
    }

    function _signDigest(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }
}
