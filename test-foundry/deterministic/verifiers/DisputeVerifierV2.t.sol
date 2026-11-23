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

    /// @dev An unused nullifier resolves to the zero intent, so a zero intent hash must never count as bound.
    function test_VerifyDisputeRejectsZeroIntentHash() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(bytes32(0), METHOD, NULLIFIER);

        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeVerifier.InvalidPaymentBinding.selector, bytes32(0), NULLIFIER
            )
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
    }

    /// @dev Same five words as the V1 details, so signing and decoding code keeps one layout.
    function test_DisputeDetailsKeepTheV1Layout() public {
        bytes memory v1 = abi.encode(
            IDisputeVerifier.DisputeDetails({
                paymentMethod: METHOD,
                originalPaymentId: NULLIFIER,
                disputeId: DISPUTE_ID,
                paymentAmount: 100,
                paymentCurrency: USD
            })
        );
        assertEq(_attestation(INTENT, METHOD, NULLIFIER).data, v1);
    }

    /* ============ Attestation ============ */

    function test_VerifyDisputeRejectsTamperedDataHash() public {
        IDisputeVerifier.DisputeAttestation memory attestation = _attestation(INTENT, METHOD, NULLIFIER);
        attestation.dataHash = keccak256("tampered");

        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        verifier.verifyDispute(attestation, METHOD);
    }

    function test_VerifyDisputeRejectsMethodMismatch() public {
        IDisputeVerifier.DisputeAttestation memory attestation =
            _attestation(INTENT, keccak256("wrong"), NULLIFIER);

        vm.expectRevert(IDisputeVerifier.InvalidAttestation.selector);
        verifier.verifyDispute(attestation, METHOD);
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

    function _attestation(bytes32 intentHash, bytes32 paymentMethod, bytes32 paymentNullifier)
        internal
        pure
        returns (IDisputeVerifier.DisputeAttestation memory attestation)
    {
        DisputeVerifierV2.DisputeDetailsV2 memory details = DisputeVerifierV2.DisputeDetailsV2({
            paymentMethod: paymentMethod,
            paymentNullifier: paymentNullifier,
            disputeId: DISPUTE_ID,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }
}
