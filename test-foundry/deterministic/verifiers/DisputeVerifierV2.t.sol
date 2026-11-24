// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";

contract DisputeVerifierV2Test is Test {
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    bytes32 internal constant METHOD = keccak256("method");
    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant NULLIFIER = keccak256("payment-nullifier");
    bytes32 internal constant UNRELATED_NULLIFIER = keccak256("unrelated-nullifier");
    bytes32 internal constant PAYMENT_ID = keccak256("provider-payment-id");
    bytes32 internal constant DISPUTE_ID = keccak256("dispute");

    NullifierRegistryV2 internal predecessor;
    NullifierRegistryV3 internal nullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    DisputeVerifierV2 internal verifier;
    address internal other = address(0xBEEF);

    function setUp() public {
        predecessor = new NullifierRegistryV2(INullifierRegistry(address(new NullifierRegistry())));
        nullifierRegistry = new NullifierRegistryV3(predecessor);
        attestationVerifier = new AttestationVerifierMock();
        verifier = new DisputeVerifierV2(address(this), nullifierRegistry, attestationVerifier);
        predecessor.addWritePermission(address(this));
        nullifierRegistry.addWritePermission(address(this));
    }

    /* ============ Payment binding ============ */

    function test_VerifyDisputeRejectsMissingPaymentBinding() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, NULLIFIER
            )
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    function test_VerifyDisputeRejectsPaymentBoundToAnotherIntent() public {
        nullifierRegistry.addNullifier(NULLIFIER, keccak256("another-intent"));
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, NULLIFIER
            )
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    /// @dev An unused or zero nullifier resolves to the zero intent, so a zero intent hash must never count as bound.
    function test_VerifyDisputeRejectsZeroIntentHash() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(bytes32(0), METHOD, NULLIFIER);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeVerifier.InvalidPaymentBinding.selector, bytes32(0), NULLIFIER
            )
        );
        verifier.verifyDispute(attestation, METHOD);

        attestation = _attestation(bytes32(0), METHOD, bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, bytes32(0), bytes32(0))
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    /// @dev Every nullifier the payment consumed has equal standing; the attestation service owns which one
    /// a kind of evidence may name.
    function test_VerifyDisputeAcceptsAnyNullifierOfTheIntent() public {
        bytes32 sharedNullifier = keccak256("shared-nullifier");
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        nullifierRegistry.addNullifier(sharedNullifier, INTENT);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            verifier.verifyDispute(_attestation(INTENT, METHOD, NULLIFIER), METHOD);
        assertEq(disputeId, DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(METHOD, DISPUTE_ID)));

        (disputeId, disputeNullifier) = verifier.verifyDispute(_attestation(INTENT, METHOD, sharedNullifier), METHOD);
        assertEq(disputeId, DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(METHOD, DISPUTE_ID)));
    }

    function test_VerifyDisputeResolvesPaymentsSettledBeforeCutover() public {
        predecessor.addNullifier(NULLIFIER, INTENT);

        (bytes32 disputeId,) = verifier.verifyDispute(_attestation(INTENT, METHOD, NULLIFIER), METHOD);
        assertEq(disputeId, DISPUTE_ID);

        (disputeId,) =
            verifier.verifyDispute(_attestation(INTENT, METHOD, _pair(UNRELATED_NULLIFIER, NULLIFIER)), METHOD);
        assertEq(disputeId, DISPUTE_ID);
    }

    /* ============ Candidate nullifiers ============ */

    function test_VerifyDisputeBindsThroughALaterCandidate() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            verifier.verifyDispute(_attestation(INTENT, METHOD, _pair(UNRELATED_NULLIFIER, NULLIFIER)), METHOD);
        assertEq(disputeId, DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(METHOD, DISPUTE_ID)));
    }

    /// @dev The revert names the first candidate.
    function test_VerifyDisputeRejectsCandidatesNoneBoundToTheIntent() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, _pair(UNRELATED_NULLIFIER, NULLIFIER));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, UNRELATED_NULLIFIER)
        );
        verifier.verifyDispute(attestation, METHOD);

        nullifierRegistry.addNullifier(UNRELATED_NULLIFIER, keccak256("another-intent"));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, UNRELATED_NULLIFIER)
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    function test_VerifyDisputeRejectsAnEmptyCandidateSet() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, new bytes32[](0));

        vm.expectRevert(DisputeVerifierV2.NoNullifierCandidates.selector);
        verifier.verifyDispute(attestation, METHOD);
    }

    /// @dev Zero and repeated entries never match a nonzero intent they are not bound to, so they are harmless.
    function test_VerifyDisputeIgnoresZeroAndRepeatedCandidates() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        bytes32[] memory candidates = new bytes32[](4);
        candidates[0] = bytes32(0);
        candidates[1] = UNRELATED_NULLIFIER;
        candidates[2] = UNRELATED_NULLIFIER;
        candidates[3] = NULLIFIER;

        (bytes32 disputeId,) = verifier.verifyDispute(_attestation(INTENT, METHOD, candidates), METHOD);
        assertEq(disputeId, DISPUTE_ID);
        (disputeId,) = verifier.verifyDispute(_attestation(INTENT, METHOD, _pair(bytes32(0), NULLIFIER)), METHOD);
        assertEq(disputeId, DISPUTE_ID);
    }

    /// @dev `originalPaymentId` is the provider payment ID hash again; only the candidates bind.
    function test_VerifyDisputeDoesNotBindThroughOriginalPaymentId() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, METHOD, NULLIFIER, _single(UNRELATED_NULLIFIER));

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, INTENT, UNRELATED_NULLIFIER)
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    /// @dev DisputeVerifier's five-word layout carries no candidate list and fails to decode.
    function test_VerifyDisputeRejectsTheDisputeVerifierLayout() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails({
                paymentMethod: METHOD,
                originalPaymentId: NULLIFIER,
                disputeId: DISPUTE_ID,
                paymentAmount: 100,
                paymentCurrency: USD
            })
        );
        IDisputeVerifier.DisputeAttestation memory attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: INTENT, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });

        vm.expectRevert();
        verifier.verifyDispute(attestation, METHOD);
    }

    /* ============ Attestation ============ */

    function test_VerifyDisputeRejectsTamperedDataHash() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);
        attestation.dataHash = keccak256("tampered");

        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        verifier.verifyDispute(attestation, METHOD);
    }

    /// @dev The signed payment method is the TEE's label for the replay key; the policy's method is not compared.
    function test_VerifyDisputeKeysTheSignedMethodAndIgnoresThePolicyMethod() public {
        bytes32 signedMethod = keccak256("signed-label");
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);

        (bytes32 disputeId, bytes32 disputeNullifier) =
            verifier.verifyDispute(_attestation(INTENT, signedMethod, NULLIFIER), METHOD);
        assertEq(disputeId, DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(signedMethod, DISPUTE_ID)));
        assertNotEq(disputeNullifier, keccak256(abi.encodePacked(METHOD, DISPUTE_ID)));
    }

    function test_VerifyDisputeRejectsSignatureFailure() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);
        attestationVerifier.setResult(false);

        vm.expectRevert(IDisputeVerifier.AttestationVerificationFailed.selector);
        verifier.verifyDispute(attestation, METHOD);
    }

    function test_VerifyDisputeForwardsDigestSignaturesAndDataToAttestationVerifier() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        bytes32 expectedDigest = verifier.hashDisputeAttestation(attestation);

        vm.expectCall(
            address(attestationVerifier),
            abi.encodeCall(IAttestationVerifier.verify, (expectedDigest, attestation.signatures, attestation.data))
        );
        verifier.verifyDispute(attestation, METHOD);
    }

    function test_HashDisputeAttestationMatchesEip712Digest() public view {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ZKP2P DisputeVerifier")),
                keccak256(bytes("1")),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("DisputeAttestation(bytes32 intentHash,bytes32 dataHash)"),
                attestation.intentHash,
                attestation.dataHash
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        assertEq(verifier.hashDisputeAttestation(attestation), expected);
    }

    /* ============ Governance ============ */

    function test_SetAttestationVerifierEnforcesOwnershipValidationAndEmits() public {
        vm.prank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setAttestationVerifier(address(attestationVerifier));

        vm.expectRevert(IDisputeVerifier.ZeroAddress.selector);
        verifier.setAttestationVerifier(address(0));

        vm.expectRevert(abi.encodeWithSelector(IDisputeVerifier.InvalidContract.selector, other));
        verifier.setAttestationVerifier(other);

        AttestationVerifierMock replacement = new AttestationVerifierMock();
        vm.expectEmit(true, true, false, true);
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_ConstructorValidatesDependencies() public {
        vm.expectRevert(IDisputeVerifier.ZeroAddress.selector);
        new DisputeVerifierV2(address(0), nullifierRegistry, attestationVerifier);

        vm.expectRevert(IDisputeVerifier.ZeroAddress.selector);
        new DisputeVerifierV2(address(this), NullifierRegistryV3(address(0)), attestationVerifier);

        vm.expectRevert(abi.encodeWithSelector(IDisputeVerifier.InvalidContract.selector, other));
        new DisputeVerifierV2(address(this), NullifierRegistryV3(other), attestationVerifier);

        vm.expectRevert(IDisputeVerifier.ZeroAddress.selector);
        new DisputeVerifierV2(address(this), nullifierRegistry, IAttestationVerifier(address(0)));

        vm.expectRevert(abi.encodeWithSelector(IDisputeVerifier.InvalidContract.selector, other));
        new DisputeVerifierV2(address(this), nullifierRegistry, AttestationVerifierMock(other));
    }

    function test_RenounceOwnershipDisabled() public {
        vm.expectRevert(IDisputeVerifier.OwnershipRenunciationDisabled.selector);
        verifier.renounceOwnership();
    }

    /* ============ Helpers ============ */

    function _attestation(bytes32 intentHash, bytes32 paymentMethod, bytes32 candidate)
        internal
        pure
        returns (IDisputeVerifier.DisputeAttestation memory)
    {
        return _attestation(intentHash, paymentMethod, _single(candidate));
    }

    function _attestation(bytes32 intentHash, bytes32 paymentMethod, bytes32[] memory candidates)
        internal
        pure
        returns (IDisputeVerifier.DisputeAttestation memory)
    {
        return _attestation(intentHash, paymentMethod, PAYMENT_ID, candidates);
    }

    function _attestation(
        bytes32 intentHash,
        bytes32 paymentMethod,
        bytes32 originalPaymentId,
        bytes32[] memory candidates
    ) internal pure returns (IDisputeVerifier.DisputeAttestation memory attestation) {
        IDisputeVerifier.DisputeDetails memory details = IDisputeVerifier.DisputeDetails({
            paymentMethod: paymentMethod,
            originalPaymentId: originalPaymentId,
            disputeId: DISPUTE_ID,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details, candidates);
        attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }

    function _single(bytes32 candidate) internal pure returns (bytes32[] memory candidates) {
        candidates = new bytes32[](1);
        candidates[0] = candidate;
    }

    function _pair(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory candidates) {
        candidates = new bytes32[](2);
        candidates[0] = first;
        candidates[1] = second;
    }
}
