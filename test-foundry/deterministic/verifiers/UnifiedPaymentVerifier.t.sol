// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {FailingAttestationVerifier} from "contracts/mocks/FailingAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3CallerHarness} from "contracts/mocks/UnifiedPaymentVerifierV3Harness.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";

contract UnifiedPaymentVerifierTest is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant ATTACKER_KEY = 0xBAD;
    uint256 internal constant AMOUNT = 50e6;
    uint256 internal constant TIMESTAMP = 1_000_000;
    uint256 internal constant CONVERSION_RATE = 1e18;
    uint256 internal constant MAX_TIMESTAMP_BUFFER_MS = 48 hours * 1000;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee-123");
    bytes32 internal constant INTENT = keccak256("intent");
    bytes32 internal constant SECOND_INTENT = keccak256("second-intent");

    address internal witness;
    address internal attacker;
    NullifierRegistry internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifier internal verifier;
    UnifiedPaymentVerifierV3CallerHarness internal caller;

    function setUp() public {
        vm.warp(TIMESTAMP);
        witness = vm.addr(WITNESS_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        nullifierRegistry = new NullifierRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifier(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        caller = new UnifiedPaymentVerifierV3CallerHarness();

        orchestratorRegistry.addOrchestrator(address(caller));
        nullifierRegistry.addWritePermission(address(verifier));
        verifier.addPaymentMethod(METHOD);
        _setIntent(INTENT);
        _setIntent(SECOND_INTENT);
    }

    function _setIntent(bytes32 intentHash) internal {
        caller.setIntent(
            intentHash,
            IOrchestrator.Intent({
                owner: address(this),
                to: address(this),
                escrow: makeAddr("escrow"),
                depositId: 0,
                amount: AMOUNT,
                timestamp: TIMESTAMP,
                paymentMethod: METHOD,
                fiatCurrency: USD,
                conversionRate: CONVERSION_RATE,
                payeeId: PAYEE,
                referrer: address(0),
                referrerFee: 0,
                postIntentHook: IPostIntentHook(address(0)),
                data: ""
            })
        );
    }

    function _payment(bytes32 paymentId) internal pure returns (UnifiedPaymentVerifier.PaymentDetails memory) {
        return UnifiedPaymentVerifier.PaymentDetails({
            method: METHOD,
            payeeId: PAYEE,
            amount: AMOUNT,
            currency: USD,
            timestamp: TIMESTAMP * 1000,
            paymentId: paymentId
        });
    }

    function _snapshot(bytes32 intentHash) internal pure returns (UnifiedPaymentVerifier.IntentSnapshot memory) {
        return UnifiedPaymentVerifier.IntentSnapshot({
            intentHash: intentHash,
            amount: AMOUNT,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            payeeDetails: PAYEE,
            conversionRate: CONVERSION_RATE,
            signalTimestamp: TIMESTAMP,
            timestampBuffer: 0
        });
    }

    function _proof(
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        UnifiedPaymentVerifier.PaymentDetails memory payment,
        UnifiedPaymentVerifier.IntentSnapshot memory snapshot,
        uint256 signerKey,
        bool correctDataHash
    ) internal view returns (bytes memory) {
        bytes memory data = abi.encode(payment, snapshot);
        bytes32 dataHash = correctDataHash ? keccak256(data) : keccak256("tampered-hash");
        return _encodeProof(attestedIntentHash, releaseAmount, dataHash, data, signerKey);
    }

    function _encodeProof(
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        bytes32 dataHash,
        bytes memory data,
        uint256 signerKey
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, attestedIntentHash, releaseAmount, dataHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", verifier.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifier.PaymentAttestation({
                intentHash: attestedIntentHash,
                releaseAmount: releaseAmount,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }

    function _validProof(bytes32 intentHash, bytes32 paymentId) internal view returns (bytes memory) {
        return _proof(intentHash, AMOUNT, _payment(paymentId), _snapshot(intentHash), WITNESS_KEY, true);
    }

    function _call(bytes32 intentHash, bytes memory proof)
        internal
        returns (IPaymentVerifier.PaymentVerificationResult memory)
    {
        return caller.verifyPayment(
            verifier, IPaymentVerifier.VerifyPaymentData({intentHash: intentHash, paymentProof: proof, data: ""})
        );
    }

    function _expectFailure(bytes32 intentHash, bytes memory proof, string memory reason) internal {
        vm.expectRevert(bytes(reason));
        _call(intentHash, proof);
    }

    function test_VerifiesWitnessSignatureAndReturnsExactResult() public {
        bytes memory proof = _validProof(INTENT, keccak256("success"));
        IPaymentVerifier.PaymentVerificationResult memory result = _call(INTENT, proof);
        assertTrue(result.success);
        assertEq(result.intentHash, INTENT);
        assertEq(result.releaseAmount, AMOUNT);
    }

    function test_EmitsCompletePaymentVerifiedEvent() public {
        bytes32 paymentId = keccak256("event");
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(INTENT, METHOD, USD, AMOUNT, TIMESTAMP * 1000, paymentId, PAYEE);
        _call(INTENT, _validProof(INTENT, paymentId));
    }

    function test_NullifiesCollisionResistantMethodAndPaymentIdentifier() public {
        bytes32 paymentId = keccak256("nullifier");
        _call(INTENT, _validProof(INTENT, paymentId));
        assertTrue(nullifierRegistry.isNullified(keccak256(abi.encodePacked(METHOD, paymentId))));
        assertFalse(nullifierRegistry.isNullified(paymentId));
    }

    function test_RejectsEveryMismatchedSnapshotFieldAndExcessiveTimestampBuffer() public {
        bytes32 paymentId = keccak256("snapshot");
        UnifiedPaymentVerifier.IntentSnapshot memory snapshot = _snapshot(INTENT);
        snapshot.intentHash = bytes32(0);
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot hash mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.amount += 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot amount mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.paymentMethod = bytes32(0);
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot method mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.fiatCurrency = bytes32(0);
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot currency mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.conversionRate += 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot rate mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.signalTimestamp += 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot timestamp mismatch");
        snapshot = _snapshot(INTENT);
        snapshot.timestampBuffer = MAX_TIMESTAMP_BUFFER_MS + 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot timestamp buffer exceeds maximum");
        snapshot = _snapshot(INTENT);
        snapshot.payeeDetails = keccak256("tampered");
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot payee mismatch");
    }

    function _expectSnapshotFailure(
        UnifiedPaymentVerifier.IntentSnapshot memory snapshot,
        bytes32 paymentId,
        string memory reason
    ) internal {
        bytes memory proof = _proof(INTENT, AMOUNT, _payment(paymentId), snapshot, WITNESS_KEY, true);
        _expectFailure(INTENT, proof, reason);
    }

    function test_RejectsUnregisteredPaymentMethod() public {
        UnifiedPaymentVerifier.PaymentDetails memory payment = _payment(keccak256("unsupported"));
        payment.method = keccak256("invalid");
        bytes memory proof = _proof(INTENT, AMOUNT, payment, _snapshot(INTENT), WITNESS_KEY, true);
        _expectFailure(INTENT, proof, "UPV: Invalid payment method");
    }

    function test_RejectsSignatureFromNonWitness() public {
        bytes memory proof =
            _proof(INTENT, AMOUNT, _payment(keccak256("bad-signer")), _snapshot(INTENT), ATTACKER_KEY, true);
        _expectFailure(INTENT, proof, "ThresholdSigVerifierUtils: Not enough valid witness signatures");
    }

    function test_RejectsFalseAttestationVerifierResult() public {
        bytes memory proof = _validProof(INTENT, keccak256("false-verifier"));
        FailingAttestationVerifier failingVerifier = new FailingAttestationVerifier();
        verifier.setAttestationVerifier(address(failingVerifier));
        _expectFailure(INTENT, proof, "UPV: Invalid attestation");
    }

    function test_CapsReleaseAmountToIntentAmount() public {
        bytes memory proof =
            _proof(INTENT, AMOUNT * 2, _payment(keccak256("overpayment")), _snapshot(INTENT), WITNESS_KEY, true);
        IPaymentVerifier.PaymentVerificationResult memory result = _call(INTENT, proof);
        assertEq(result.releaseAmount, AMOUNT);
    }

    function test_RejectsReusedPaymentAcrossDifferentIntents() public {
        bytes32 paymentId = keccak256("reused-payment");
        _call(INTENT, _validProof(INTENT, paymentId));
        bytes memory secondProof = _validProof(SECOND_INTENT, paymentId);
        _expectFailure(SECOND_INTENT, secondProof, "Nullifier has already been used");
    }

    function test_RejectsCallerOutsideOrchestratorRegistry() public {
        bytes memory proof = _validProof(INTENT, keccak256("unauthorized"));
        vm.prank(attacker);
        vm.expectRevert(bytes("Only orchestrator can call"));
        verifier.verifyPayment(IPaymentVerifier.VerifyPaymentData({intentHash: INTENT, paymentProof: proof, data: ""}));
    }

    function test_RejectsAttestationDataHashMismatch() public {
        bytes memory proof =
            _proof(INTENT, AMOUNT, _payment(keccak256("data-hash")), _snapshot(INTENT), WITNESS_KEY, false);
        _expectFailure(INTENT, proof, "UPV: Data hash mismatch");
    }

    function test_RejectsTamperedSignatureDigest() public {
        bytes memory proof = _validProof(INTENT, keccak256("digest"));
        UnifiedPaymentVerifier.PaymentAttestation memory attestation =
            abi.decode(proof, (UnifiedPaymentVerifier.PaymentAttestation));
        attestation.releaseAmount += 1;
        _expectFailure(
            INTENT, abi.encode(attestation), "ThresholdSigVerifierUtils: Not enough valid witness signatures"
        );
    }
}
