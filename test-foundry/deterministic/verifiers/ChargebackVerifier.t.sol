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
    bytes32 internal constant USD = keccak256("USD");

    NullifierRegistryV2 internal nullifierRegistry;
    AttestationVerifierMock internal attestationVerifier;
    ChargebackVerifier internal verifier;
    address internal other = address(0xBEEF);

    function setUp() public {
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        attestationVerifier = new AttestationVerifierMock();
        verifier = new ChargebackVerifier(address(this), nullifierRegistry, attestationVerifier);
    }

    function test_VerifyChargebackRejectsMissingPaymentBinding() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));

        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        vm.expectRevert(
            abi.encodeWithSelector(IChargebackVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier)
        );
        verifier.verifyChargeback(attestation, METHOD);
    }

    function test_VerifyChargebackRejectsTamperedDataHash() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));
        attestation.dataHash = keccak256("tampered");

        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD);
    }

    function test_VerifyChargebackRejectsMethodMismatch() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, keccak256("wrong"), keccak256("payment"), keccak256("dispute"));

        vm.expectRevert(IChargebackVerifier.InvalidAttestation.selector);
        verifier.verifyChargeback(attestation, METHOD);
    }

    function test_VerifyChargebackRejectsSignatureFailure() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));
        attestationVerifier.setResult(false);

        vm.expectRevert(IChargebackVerifier.AttestationVerificationFailed.selector);
        verifier.verifyChargeback(attestation, METHOD);
    }

    function test_VerifyChargebackProofPathRequiresBothDirectionBinding() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        bytes memory bindingRevert =
            abi.encodeWithSelector(IChargebackVerifier.InvalidPaymentBinding.selector, INTENT, paymentNullifier);

        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD);

        // Forward direction only: nullifier -> intent resolves, intent -> nullifier does not.
        vm.mockCall(
            address(nullifierRegistry),
            abi.encodeCall(INullifierRegistryV2.intentHashByNullifier, (paymentNullifier)),
            abi.encode(INTENT)
        );
        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD);
        vm.clearMockedCalls();

        // Reverse direction only: intent -> nullifier resolves, nullifier -> intent does not.
        vm.mockCall(
            address(nullifierRegistry),
            abi.encodeCall(INullifierRegistryV2.nullifierByIntentHash, (INTENT)),
            abi.encode(paymentNullifier)
        );
        vm.expectRevert(bindingRevert);
        verifier.verifyChargeback(attestation, METHOD);
        vm.clearMockedCalls();

        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, INTENT);

        (bytes32 disputeId,) = verifier.verifyChargeback(attestation, METHOD);
        assertEq(disputeId, keccak256("dispute"));
    }

    function test_VerifyChargebackForwardsDigestSignaturesAndDataToAttestationVerifier() public {
        bytes32 paymentId = keccak256("payment");
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, paymentId, keccak256("dispute"));
        _bindPayment(INTENT, paymentId);
        bytes32 expectedDigest = verifier.hashChargebackAttestation(attestation);

        vm.expectCall(
            address(attestationVerifier),
            abi.encodeCall(IAttestationVerifier.verify, (expectedDigest, attestation.signatures, attestation.data))
        );
        verifier.verifyChargeback(attestation, METHOD);
    }

    function test_HashChargebackAttestationMatchesEip712Digest() public {
        IChargebackVerifier.ChargebackAttestation memory attestation =
            _attestation(INTENT, METHOD, keccak256("payment"), keccak256("dispute"));

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ZKP2P ChargebackVerifier")),
                keccak256(bytes("1")),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ChargebackAttestation(bytes32 intentHash,bytes32 dataHash)"),
                attestation.intentHash,
                attestation.dataHash
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

    function _attestation(bytes32 intentHash, bytes32 paymentMethod, bytes32 paymentId, bytes32 disputeId)
        internal
        pure
        returns (IChargebackVerifier.ChargebackAttestation memory attestation)
    {
        IChargebackVerifier.ChargebackDetails memory details = IChargebackVerifier.ChargebackDetails({
            paymentMethod: paymentMethod,
            originalPaymentId: paymentId,
            disputeId: disputeId,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        attestation = IChargebackVerifier.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }

    function _bindPayment(bytes32 intentHash, bytes32 paymentId) internal {
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(keccak256(abi.encodePacked(METHOD, paymentId)), intentHash);
    }
}
