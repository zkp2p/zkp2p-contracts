// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IReceiptVerifier} from "contracts/interfaces/IReceiptVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {ReceiptVerifier} from "contracts/unifiedVerifier/ReceiptVerifier.sol";
import {AttestationVerifierMock} from "../../mocks/AttestationVerifierMock.sol";

contract ReceiptVerifierTest is Test {
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    bytes32 internal constant METHOD = keccak256("method");
    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant NULLIFIER = keccak256("payment-nullifier");
    bytes32 internal constant UNRELATED_NULLIFIER = keccak256("unrelated-nullifier");
    uint64 internal constant RELEASE_AT = 1_700_000_000;
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    string internal constant NOT_ENOUGH_SIGNATURES = "ThresholdSigVerifierUtils: Not enough valid witness signatures";

    NullifierRegistryV2 internal predecessor;
    NullifierRegistryV3 internal nullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    ReceiptVerifier internal verifier;
    address internal other = address(0xBEEF);

    function setUp() public {
        predecessor = new NullifierRegistryV2(INullifierRegistry(address(new NullifierRegistry())));
        nullifierRegistry = new NullifierRegistryV3(predecessor);
        attestationVerifier = new AttestationVerifierMock();
        verifier = new ReceiptVerifier(address(this), nullifierRegistry, attestationVerifier);
        predecessor.addWritePermission(address(this));
        nullifierRegistry.addWritePermission(address(this));
    }

    /* ============ Success ============ */

    function test_VerifyReceiptReturnsSignedReleaseAt() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);

        assertEq(verifier.verifyReceipt(_receipt(INTENT, METHOD, _single(NULLIFIER)), METHOD), RELEASE_AT);
    }

    /// @dev A receipt may carry a release time already in the past; the policy pays such a protection at once.
    function test_VerifyReceiptAcceptsAPastReleaseAt() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        receipt.releaseAt = 1;

        assertEq(verifier.verifyReceipt(receipt, METHOD), 1);
    }

    function test_VerifyReceiptForwardsDigestSignaturesAndDataToAttestationVerifier() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        receipt.signatures = new bytes[](1);
        receipt.signatures[0] = hex"1234";
        bytes32 expectedDigest = verifier.hashReceiptAttestation(receipt);

        vm.expectCall(
            address(attestationVerifier),
            abi.encodeCall(IAttestationVerifier.verify, (expectedDigest, receipt.signatures, receipt.data))
        );
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_HashReceiptAttestationMatchesEip712Digest() public view {
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ZKP2P ReceiptVerifier")),
                keccak256(bytes("1")),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ReceiptConfirmation(bytes32 intentHash,uint64 releaseAt,bytes32 dataHash)"),
                receipt.intentHash,
                receipt.releaseAt,
                receipt.dataHash
            )
        );

        assertEq(verifier.RECEIPT_CONFIRMATION_TYPEHASH(), keccak256("ReceiptConfirmation(bytes32 intentHash,uint64 releaseAt,bytes32 dataHash)"));
        assertEq(verifier.hashReceiptAttestation(receipt), keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    /// @dev The signed release time is part of the digest, so a relayer cannot move it.
    function test_HashReceiptAttestationBindsReleaseAt() public view {
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        bytes32 digest = verifier.hashReceiptAttestation(receipt);
        receipt.releaseAt = RELEASE_AT - 1;

        assertTrue(verifier.hashReceiptAttestation(receipt) != digest);
    }

    /* ============ Payment binding ============ */

    function test_VerifyReceiptBindsThroughALaterCandidate() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);

        assertEq(
            verifier.verifyReceipt(_receipt(INTENT, METHOD, _pair(UNRELATED_NULLIFIER, NULLIFIER)), METHOD), RELEASE_AT
        );
    }

    function test_VerifyReceiptResolvesPaymentsSettledBeforeCutover() public {
        predecessor.addNullifier(NULLIFIER, INTENT);

        assertEq(verifier.verifyReceipt(_receipt(INTENT, METHOD, _single(NULLIFIER)), METHOD), RELEASE_AT);
    }

    /// @dev The revert names the first candidate.
    function test_VerifyReceiptRejectsUnboundCandidates() public {
        IReceiptVerifier.ReceiptAttestation memory receipt =
            _receipt(INTENT, METHOD, _pair(UNRELATED_NULLIFIER, NULLIFIER));

        vm.expectRevert(
            abi.encodeWithSelector(IReceiptVerifier.InvalidPaymentBinding.selector, INTENT, UNRELATED_NULLIFIER)
        );
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_VerifyReceiptRejectsPaymentBoundToAnotherIntent() public {
        nullifierRegistry.addNullifier(NULLIFIER, keccak256("another-intent"));
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));

        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidPaymentBinding.selector, INTENT, NULLIFIER));
        verifier.verifyReceipt(receipt, METHOD);
    }

    /// @dev An unused or zero nullifier resolves to the zero intent, so a zero intent hash must never count as bound.
    function test_VerifyReceiptRejectsZeroIntentHash() public {
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(bytes32(0), METHOD, _single(NULLIFIER));
        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidPaymentBinding.selector, bytes32(0), NULLIFIER));
        verifier.verifyReceipt(receipt, METHOD);

        receipt = _receipt(bytes32(0), METHOD, _single(bytes32(0)));
        vm.expectRevert(
            abi.encodeWithSelector(IReceiptVerifier.InvalidPaymentBinding.selector, bytes32(0), bytes32(0))
        );
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_VerifyReceiptRejectsAnEmptyCandidateSet() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, new bytes32[](0));

        vm.expectRevert(IReceiptVerifier.NoNullifierCandidates.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    /* ============ Attestation ============ */

    function test_VerifyReceiptRejectsTamperedData() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        nullifierRegistry.addNullifier(UNRELATED_NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        receipt.data = abi.encode(METHOD, _single(UNRELATED_NULLIFIER));

        vm.expectRevert(IReceiptVerifier.InvalidAttestation.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_VerifyReceiptRejectsTamperedDataHash() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        receipt.dataHash = keccak256("tampered");

        vm.expectRevert(IReceiptVerifier.InvalidAttestation.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_VerifyReceiptRejectsMethodMismatch() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, keccak256("wrong"), _single(NULLIFIER));

        vm.expectRevert(IReceiptVerifier.InvalidAttestation.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    /// @dev Zero means "no early release" on the policy, so a signed zero is malformed.
    function test_VerifyReceiptRejectsZeroReleaseAt() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        receipt.releaseAt = 0;

        vm.expectRevert(IReceiptVerifier.InvalidAttestation.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    function test_VerifyReceiptRejectsSignatureFailure() public {
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        attestationVerifier.setResult(false);

        vm.expectRevert(IReceiptVerifier.AttestationVerificationFailed.selector);
        verifier.verifyReceipt(receipt, METHOD);
    }

    /* ============ Domain separation from disputes ============ */

    /// @dev The witness signs both receipts and disputes. A dispute signature over the same intent and data hash
    /// carries another EIP-712 domain and type, so it never verifies as a receipt, and a receipt signature never
    /// verifies as a dispute.
    function test_DisputeAndReceiptSignaturesAreNotInterchangeable() public {
        address[] memory witnesses = new address[](1);
        witnesses[0] = vm.addr(WITNESS_KEY);
        MultiAttestationVerifier witnessVerifier = new MultiAttestationVerifier(witnesses, 1);
        ReceiptVerifier receipts = new ReceiptVerifier(address(this), nullifierRegistry, witnessVerifier);
        DisputeVerifierV2 disputes = new DisputeVerifierV2(address(this), nullifierRegistry, witnessVerifier);
        nullifierRegistry.addNullifier(NULLIFIER, INTENT);

        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(INTENT, METHOD, _single(NULLIFIER));
        IDisputeVerifier.DisputeAttestation memory dispute = IDisputeVerifier.DisputeAttestation({
            intentHash: INTENT, dataHash: receipt.dataHash, signatures: new bytes[](0), data: receipt.data
        });
        bytes memory disputeSignature = _sign(disputes.hashDisputeAttestation(dispute));
        bytes memory receiptSignature = _sign(receipts.hashReceiptAttestation(receipt));

        receipt.signatures = _signatures(disputeSignature);
        vm.expectRevert(bytes(NOT_ENOUGH_SIGNATURES));
        receipts.verifyReceipt(receipt, METHOD);

        receipt.signatures = _signatures(receiptSignature);
        assertEq(receipts.verifyReceipt(receipt, METHOD), RELEASE_AT);

        bytes memory disputeData = abi.encode(
            IDisputeVerifier.DisputeDetails(METHOD, keccak256("payment"), keccak256("dispute"), 100, keccak256("USD")),
            _single(NULLIFIER)
        );
        dispute = IDisputeVerifier.DisputeAttestation({
            intentHash: INTENT, dataHash: keccak256(disputeData), signatures: new bytes[](0), data: disputeData
        });
        receipt.dataHash = dispute.dataHash;
        dispute.signatures = _signatures(_sign(receipts.hashReceiptAttestation(receipt)));
        vm.expectRevert(bytes(NOT_ENOUGH_SIGNATURES));
        disputes.verifyDispute(dispute, METHOD);

        dispute.signatures = _signatures(_sign(disputes.hashDisputeAttestation(dispute)));
        (bytes32 disputeId,) = disputes.verifyDispute(dispute, METHOD);
        assertEq(disputeId, keccak256("dispute"));
    }

    /* ============ Governance ============ */

    function test_SetAttestationVerifierEnforcesOwnershipValidationAndEmits() public {
        vm.prank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setAttestationVerifier(address(attestationVerifier));

        vm.expectRevert(IReceiptVerifier.ZeroAddress.selector);
        verifier.setAttestationVerifier(address(0));

        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidContract.selector, other));
        verifier.setAttestationVerifier(other);

        AttestationVerifierMock replacement = new AttestationVerifierMock();
        vm.expectEmit(true, true, false, true, address(verifier));
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_ConstructorValidatesDependencies() public {
        vm.expectRevert(IReceiptVerifier.ZeroAddress.selector);
        new ReceiptVerifier(address(0), nullifierRegistry, attestationVerifier);

        vm.expectRevert(IReceiptVerifier.ZeroAddress.selector);
        new ReceiptVerifier(address(this), NullifierRegistryV3(address(0)), attestationVerifier);

        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidContract.selector, other));
        new ReceiptVerifier(address(this), NullifierRegistryV3(other), attestationVerifier);

        vm.expectRevert(IReceiptVerifier.ZeroAddress.selector);
        new ReceiptVerifier(address(this), nullifierRegistry, IAttestationVerifier(address(0)));

        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidContract.selector, other));
        new ReceiptVerifier(address(this), nullifierRegistry, AttestationVerifierMock(other));
    }

    function test_ConstructorStoresDependenciesAndOwner() public view {
        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
        assertEq(address(verifier.attestationVerifier()), address(attestationVerifier));
        assertEq(verifier.owner(), address(this));
    }

    function test_RenounceOwnershipDisabled() public {
        vm.expectRevert(IReceiptVerifier.OwnershipRenunciationDisabled.selector);
        verifier.renounceOwnership();
    }

    /* ============ Helpers ============ */

    function _receipt(bytes32 intentHash, bytes32 paymentMethod, bytes32[] memory candidates)
        internal
        pure
        returns (IReceiptVerifier.ReceiptAttestation memory)
    {
        bytes memory data = abi.encode(paymentMethod, candidates);
        return IReceiptVerifier.ReceiptAttestation({
            intentHash: intentHash, releaseAt: RELEASE_AT, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }

    function _sign(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signatures(bytes memory signature) internal pure returns (bytes[] memory signatures) {
        signatures = new bytes[](1);
        signatures[0] = signature;
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
