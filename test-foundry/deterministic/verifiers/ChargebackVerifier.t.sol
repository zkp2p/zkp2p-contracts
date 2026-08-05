// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {IChargebackVerifier} from "contracts/interfaces/IChargebackVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";

contract ChargebackVerifierTest is Test {
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    bytes32 internal constant METHOD = keccak256("method");
    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant TRANSFORMER = keccak256("transformer");
    bytes32 internal constant DISPUTE_SCHEMA_ID = keccak256("zkp2p.attestation.dispute.v1");

    NullifierRegistryV2 internal nullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    ChargebackVerifier internal verifier;
    address internal other = address(0xBEEF);

    function setUp() public {
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        attestationVerifier = new AttestationVerifierMock();
        verifier = new ChargebackVerifier(address(this), nullifierRegistry, attestationVerifier);
    }

    function test_VerifyChargebackValidatesSignatureAndPaymentBinding() public {
        bytes32 paymentId = keccak256("payment");
        bytes32 disputeId = keccak256("dispute");
        IChargebackVerifier.ChargebackAttestation memory attestation = _attestation(INTENT, paymentId, disputeId);
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);

        (bytes32 actualDisputeId, bytes32 disputeNullifier) = verifier.verifyChargeback(attestation, METHOD, false);

        assertEq(actualDisputeId, disputeId);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(METHOD, disputeId)));
    }

    function test_VerifyChargebackDoesNotMaintainTransformerAllowlist() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, paymentId, keccak256("dispute"));
        attestation.transformerId = keccak256("another-trusted-service-transformer");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);

        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackRejectsNonDisputeSchema() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        attestation.schemaId = keccak256("zkp2p.attestation.identity.v1");

        vm.expectRevert(
            abi.encodeWithSelector(IChargebackVerifier.InvalidAttestationSchema.selector, attestation.schemaId)
        );
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackRejectsManualRelease() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(IChargebackVerifier.ManualReleaseNotChargebackable.selector);
        verifier.verifyChargeback(attestation, METHOD, true);
    }

    function test_VerifyChargebackRejectsMalformedEnvelope() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("payment"), keccak256("dispute"));

        attestation.transformerId = bytes32(0);
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);

        attestation = _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        attestation.input = hex"01";
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);

        attestation = _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        attestation.output = hex"01";
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);

        attestation = _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        attestation.signatures = new bytes[](0);
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackRejectsZeroDecodedValues() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(bytes32(0), keccak256("payment"), keccak256("dispute"));
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);

        attestation = _attestation(INTENT, bytes32(0), keccak256("dispute"));
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);

        attestation = _attestation(INTENT, keccak256("payment"), bytes32(0));
        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackRejectsSignatureFailure() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        attestationVerifier.setResult(false);

        vm.expectRevert(IChargebackVerifier.AttestationVerificationFailed.selector);
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackRequiresBothDirectionsOfPaymentBinding() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        bytes memory bindingRevert =
            abi.encodeWithSelector(IChargebackVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier);

        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD, false);

        vm.mockCall(
            address(nullifierRegistry),
            abi.encodeCall(INullifierRegistryV2.intentHashByNullifier, (paymentNullifier)),
            abi.encode(INTENT)
        );
        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD, false);
        vm.clearMockedCalls();

        vm.mockCall(
            address(nullifierRegistry),
            abi.encodeCall(INullifierRegistryV2.nullifierByIntentHash, (INTENT)),
            abi.encode(paymentNullifier)
        );
        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_VerifyChargebackForwardsDigestSignaturesAndOutput() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);
        bytes32 expectedDigest = verifier.hashChargebackAttestation(attestation);

        vm.expectCall(
            address(attestationVerifier),
            abi.encodeCall(IAttestationVerifier.verify, (expectedDigest, attestation.signatures, attestation.output))
        );
        verifier.verifyChargeback(attestation, METHOD, false);
    }

    function test_HashChargebackAttestationMatchesGenericEip712Digest() public view {
        assertEq(verifier.DISPUTE_SCHEMA_ID(), DISPUTE_SCHEMA_ID);
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("payment"), keccak256("dispute"));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ZKP2P Attestation")),
                keccak256(bytes("1")),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Attestation(bytes32 schemaId,bytes32 transformerId,bytes input,bytes output)"),
                attestation.schemaId,
                attestation.transformerId,
                keccak256(attestation.input),
                keccak256(attestation.output)
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        assertEq(verifier.hashChargebackAttestation(attestation), expected);
    }

    function test_SetAttestationVerifierEnforcesOwnershipValidationAndEmits() public {
        vm.prank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setAttestationVerifier(address(attestationVerifier));

        vm.expectRevert(IChargebackVerifier.ZeroAddress.selector);
        verifier.setAttestationVerifier(address(0));

        vm.expectRevert(abi.encodeWithSelector(IChargebackVerifier.InvalidContract.selector, other));
        verifier.setAttestationVerifier(other);

        AttestationVerifierMock replacement = new AttestationVerifierMock();
        vm.expectEmit(true, true, false, true);
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_ConstructorValidatesDependencies() public {
        vm.expectRevert(IChargebackVerifier.ZeroAddress.selector);
        new ChargebackVerifier(address(0), nullifierRegistry, attestationVerifier);

        vm.expectRevert(IChargebackVerifier.ZeroAddress.selector);
        new ChargebackVerifier(address(this), NullifierRegistryV2(address(0)), attestationVerifier);

        vm.expectRevert(abi.encodeWithSelector(IChargebackVerifier.InvalidContract.selector, other));
        new ChargebackVerifier(address(this), NullifierRegistryV2(other), attestationVerifier);

        vm.expectRevert(IChargebackVerifier.ZeroAddress.selector);
        new ChargebackVerifier(address(this), nullifierRegistry, IAttestationVerifier(address(0)));

        vm.expectRevert(abi.encodeWithSelector(IChargebackVerifier.InvalidContract.selector, other));
        new ChargebackVerifier(address(this), nullifierRegistry, AttestationVerifierMock(other));
    }

    function test_RenounceOwnershipDisabled() public {
        vm.expectRevert(IChargebackVerifier.OwnershipRenunciationDisabled.selector);
        verifier.renounceOwnership();
    }

    function _attestation(bytes32 intentHash, bytes32 paymentId, bytes32 disputeId)
        internal
        pure
        returns (IChargebackVerifier.ChargebackAttestation memory attestation)
    {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = hex"01";
        attestation = IChargebackVerifier.ChargebackAttestation({
            schemaId: DISPUTE_SCHEMA_ID,
            transformerId: TRANSFORMER,
            input: abi.encode(intentHash),
            output: abi.encode(paymentId, disputeId),
            signatures: signatures
        });
    }
}
