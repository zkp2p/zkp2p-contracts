// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INonPaymentVerifier} from "contracts/interfaces/INonPaymentVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {NonPaymentVerifier} from "contracts/unifiedVerifier/NonPaymentVerifier.sol";
import {FailingAttestationVerifier} from "../../mocks/FailingAttestationVerifier.sol";

contract NonPaymentVerifierTest is Test {
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant INTENT = keccak256("intent");

    MultiAttestationVerifier internal witnesses;
    NonPaymentVerifier internal verifier;

    function setUp() public {
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        verifier = new NonPaymentVerifier(address(this), witnesses);
    }

    function test_DigestIsTheEip712Digest() public {
        INonPaymentVerifier.NonPaymentAttestation memory attestation = _attestation(_details());
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ZKP2P NonPaymentVerifier"),
                keccak256("1"),
                block.chainid,
                address(verifier)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("NonPaymentAttestation(bytes32 intentHash,bytes32 dataHash)"), INTENT, attestation.dataHash)
        );
        assertEq(
            verifier.hashNonPaymentAttestation(attestation),
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
        );
    }

    function test_ReturnsTheSignedScan() public {
        INonPaymentVerifier.NonPaymentDetails memory expected = _details();
        INonPaymentVerifier.NonPaymentDetails memory scan = verifier.verifyNonPayment(_sign(_attestation(expected), WITNESS_KEY));

        assertEq(keccak256(abi.encode(scan)), keccak256(abi.encode(expected)));
    }

    function test_RejectsDataHashMismatch() public {
        INonPaymentVerifier.NonPaymentAttestation memory attestation = _sign(_attestation(_details()), WITNESS_KEY);
        attestation.dataHash = keccak256("other");

        vm.expectRevert(INonPaymentVerifier.InvalidAttestation.selector);
        verifier.verifyNonPayment(attestation);
    }

    function test_RejectsNonWitnessSignature() public {
        INonPaymentVerifier.NonPaymentAttestation memory attestation = _sign(_attestation(_details()), 0xB0B);

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        verifier.verifyNonPayment(attestation);
    }

    function test_RejectsWhenAttestationVerifierReturnsFalse() public {
        INonPaymentVerifier.NonPaymentAttestation memory attestation = _sign(_attestation(_details()), WITNESS_KEY);
        verifier.setAttestationVerifier(address(new FailingAttestationVerifier()));

        vm.expectRevert(INonPaymentVerifier.AttestationVerificationFailed.selector);
        verifier.verifyNonPayment(attestation);
    }

    function test_GovernanceReplacesAttestationVerifier() public {
        address replacement = address(new FailingAttestationVerifier());
        vm.expectEmit(true, true, false, false, address(verifier));
        emit AttestationVerifierUpdated(address(witnesses), replacement);
        verifier.setAttestationVerifier(replacement);
        assertEq(address(verifier.attestationVerifier()), replacement);

        vm.expectRevert(INonPaymentVerifier.ZeroAddress.selector);
        verifier.setAttestationVerifier(address(0));
        vm.expectRevert(abi.encodeWithSelector(INonPaymentVerifier.InvalidContract.selector, address(0xBEEF)));
        verifier.setAttestationVerifier(address(0xBEEF));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setAttestationVerifier(replacement);
        vm.expectRevert(INonPaymentVerifier.OwnershipRenunciationDisabled.selector);
        verifier.renounceOwnership();
    }

    function test_ConstructorRejectsMissingDependencies() public {
        vm.expectRevert(INonPaymentVerifier.ZeroAddress.selector);
        new NonPaymentVerifier(address(0), witnesses);
        vm.expectRevert(abi.encodeWithSelector(INonPaymentVerifier.InvalidContract.selector, address(0xBEEF)));
        new NonPaymentVerifier(address(this), IAttestationVerifier(address(0xBEEF)));
    }

    function _details() internal pure returns (INonPaymentVerifier.NonPaymentDetails memory details) {
        bytes32[] memory excluded = new bytes32[](1);
        excluded[0] = keccak256("used payment");
        details = INonPaymentVerifier.NonPaymentDetails({
            paymentMethod: keccak256("venmo"),
            payeeId: keccak256("payee"),
            fiatCurrency: keccak256("USD"),
            windowStart: 1_000,
            windowEnd: 2_000,
            claimedAmount: 150e6,
            receivedAmount: 120e6,
            payerHash: keccak256("payer"),
            txIdHash: keccak256("tx"),
            historyHash: keccak256("rows"),
            excludedPaymentIds: excluded
        });
    }

    function _attestation(INonPaymentVerifier.NonPaymentDetails memory _scan)
        internal
        pure
        returns (INonPaymentVerifier.NonPaymentAttestation memory attestation)
    {
        attestation.intentHash = INTENT;
        attestation.data = abi.encode(_scan);
        attestation.dataHash = keccak256(attestation.data);
        attestation.signatures = new bytes[](1);
    }

    function _sign(INonPaymentVerifier.NonPaymentAttestation memory _attestationToSign, uint256 _key)
        internal
        view
        returns (INonPaymentVerifier.NonPaymentAttestation memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key, verifier.hashNonPaymentAttestation(_attestationToSign));
        _attestationToSign.signatures[0] = abi.encodePacked(r, s, v);
        return _attestationToSign;
    }
}
