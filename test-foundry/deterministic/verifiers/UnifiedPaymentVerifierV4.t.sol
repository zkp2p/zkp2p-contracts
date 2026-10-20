// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {UnifiedPaymentVerifierV3Test, IUnifiedVerifierCaller} from "./UnifiedPaymentVerifierV3.t.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {UnifiedPaymentVerifierV4CallerHarness, UnifiedPaymentVerifierV4V4CallerHarness} from "../../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

contract UnifiedPaymentVerifierV4Test is UnifiedPaymentVerifierV3Test {
    UnifiedPaymentVerifierV4CallerHarness internal supportedPrimaryCaller;

    function setUp() public override {
        super.setUp();
        UnifiedPaymentVerifierV4 replacement =
            new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        replacement.addPaymentMethod(METHOD);
        replacement.addPaymentMethod(OTHER_METHOD);
        nullifierRegistry.removeWritePermission(address(verifier));
        nullifierRegistry.addWritePermission(address(replacement));
        verifier = UnifiedPaymentVerifierV3(address(replacement));
        supportedPrimaryCaller = new UnifiedPaymentVerifierV4CallerHarness();
        supportedPrimaryCaller.setIntent(LEGACY_INTENT, v2Caller.getIntent(V2_INTENT));
        orchestratorRegistry.addOrchestrator(address(supportedPrimaryCaller));
    }

    /// @dev Reuse the shared signature, snapshot, and replay matrix with two supported V2-shaped callers.
    /// Tests deploying a separate UPV3 retain its actual V1 caller and compatibility coverage.
    function _call(
        IUnifiedVerifierCaller caller,
        UnifiedPaymentVerifierV3 target,
        bytes32 intentHash,
        bytes memory proof
    ) internal override returns (IPaymentVerifier.PaymentVerificationResult memory) {
        if (address(target) == address(verifier) && address(caller) == address(legacyCaller)) {
            caller = IUnifiedVerifierCaller(address(supportedPrimaryCaller));
        }
        return super._call(caller, target, intentHash, proof);
    }

    function test_RejectsRegisteredV1WithoutConsumingPayment() public {
        bytes32 paymentId = keccak256("retired-v1");
        bytes memory proof = _validProof(verifier, LEGACY_INTENT, paymentId);
        vm.expectRevert("UPV: Unsupported orchestrator");
        legacyCaller.verifyPayment(
            verifier, IPaymentVerifier.VerifyPaymentData(LEGACY_INTENT, proof, "")
        );
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
        assertEq(nullifierRegistry.nullifierByIntentHash(LEGACY_INTENT), bytes32(0));

        // The rejected V1 call does not prevent the same payment from settling a supported intent.
        IPaymentVerifier.PaymentVerificationResult memory result = _call(
            IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, _validProof(verifier, V2_INTENT, paymentId)
        );
        assertTrue(result.success);
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), V2_INTENT);
    }

    function test_O4IntentValidatesBeforeV2Probe() public {
        UnifiedPaymentVerifierV4V4CallerHarness caller = new UnifiedPaymentVerifierV4V4CallerHarness();
        IOrchestratorV2.Intent memory source = v2Caller.getIntent(V2_INTENT);
        IOrchestratorV4.Intent memory intent = IOrchestratorV4.Intent(
            source.owner, source.to, source.escrow, source.depositId, source.amount, source.timestamp,
            source.paymentMethod, source.fiatCurrency, source.conversionRate, source.payeeId,
            new IReferralFee.ReferralFee[](1), "", false
        );
        intent.referralFees[0] = IReferralFee.ReferralFee(address(123), 1e15);
        caller.setIntent(V2_INTENT, intent);
        orchestratorRegistry.addOrchestrator(address(caller));
        bytes32 paymentId = keccak256("o4-intent");
        IPaymentVerifierV2.VerifyPaymentData memory request = IPaymentVerifierV2.VerifyPaymentData(
            V2_INTENT, _validProof(verifier, V2_INTENT, paymentId), ""
        );
        intent.amount++;
        caller.setIntent(V2_INTENT, intent);
        vm.expectRevert("UPV: Snapshot amount mismatch");
        caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
        intent.amount--;
        caller.setIntent(V2_INTENT, intent);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory settlementData) =
            caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        assertTrue(result.success);
        assertEq(result.intentHash, V2_INTENT);
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(settlementData, "");
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), V2_INTENT);
    }

    /// @dev A zero payer commitment hash (the field V4 appends to V3's snapshot), then an empty settlementData field:
    /// its offset after the sixteen-word head, then a zero length.
    function _payloadSuffix() internal pure override returns (bytes memory) {
        return abi.encode(bytes32(0), uint256(512), uint256(0));
    }

    function test_O4PayerCommitmentMustMatchSnapshot() public {
        UnifiedPaymentVerifierV4V4CallerHarness caller = new UnifiedPaymentVerifierV4V4CallerHarness();
        IOrchestratorV2.Intent memory source = v2Caller.getIntent(V2_INTENT);
        bytes memory commitment = "payer";
        IOrchestratorV4.Intent memory intent = IOrchestratorV4.Intent(
            source.owner, source.to, source.escrow, source.depositId, source.amount, source.timestamp,
            source.paymentMethod, source.fiatCurrency, source.conversionRate, source.payeeId,
            new IReferralFee.ReferralFee[](0), commitment, false
        );
        caller.setIntent(V2_INTENT, intent);
        orchestratorRegistry.addOrchestrator(address(caller));
        bytes32 paymentId = keccak256("payer-commitment");
        IPaymentVerifierV2.VerifyPaymentData memory request =
            IPaymentVerifierV2.VerifyPaymentData(V2_INTENT, _validProof(verifier, V2_INTENT, paymentId), "");
        vm.expectRevert("UPV: Snapshot payer commitment mismatch");
        caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        bytes memory data = abi.encode(_payment(paymentId), _snapshot(V2_INTENT), keccak256(commitment), bytes(""));
        request.paymentProof = _encodeProof(verifier, V2_INTENT, AMOUNT, keccak256(data), data, WITNESS_KEY);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result,) =
            caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        assertTrue(result.success);
        assertEq(result.intent.payerCommitmentHash, keccak256(commitment));
    }

    function test_V2IntentRejectsNonZeroPayerCommitment() public {
        bytes32 paymentId = keccak256("v2-commitment");
        bytes memory data = abi.encode(_payment(paymentId), _snapshot(V2_INTENT), keccak256("payer"), bytes(""));
        bytes memory proof = _encodeProof(verifier, V2_INTENT, AMOUNT, keccak256(data), data, WITNESS_KEY);
        vm.expectRevert("UPV: Snapshot payer commitment mismatch");
        _call(IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, proof);
    }

    function test_AcceptsEmptySettlementData() public {
        _checkSettlementData("");
    }

    function test_ReturnsSignedSettlementData() public {
        _checkSettlementData(hex"deadbeef010203");
    }

    function test_ReturnsSettlementDataUninterpreted() public {
        _checkSettlementData(abi.encode(uint256(2)));
    }

    function testFuzz_ReturnsSignedSettlementData(bytes memory settlementData) public {
        vm.assume(settlementData.length <= 1024);
        _checkSettlementData(settlementData);
    }

    function _checkSettlementData(bytes memory settlementData) internal {
        UnifiedPaymentVerifierV4CallerHarness caller = new UnifiedPaymentVerifierV4CallerHarness();
        caller.setIntent(V2_INTENT, v2Caller.getIntent(V2_INTENT));
        orchestratorRegistry.addOrchestrator(address(caller));
        bytes32 paymentId = keccak256("settlement-data");
        bytes memory data = abi.encode(_payment(paymentId), _snapshot(V2_INTENT), bytes32(0), settlementData);
        bytes memory proof = _encodeProof(verifier, V2_INTENT, AMOUNT - 1, keccak256(data), data, WITNESS_KEY);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
        attestation.metadata = hex"badbad";
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory returned) = caller.verifyPayment(
            IPaymentVerifierV2(address(verifier)), IPaymentVerifierV2.VerifyPaymentData(V2_INTENT, abi.encode(attestation), "")
        );
        assertTrue(result.success);
        assertEq(result.intentHash, V2_INTENT);
        assertEq(result.releaseAmount, AMOUNT - 1);
        assertEq(result.attestedReleaseAmount, AMOUNT - 1);
        assertEq(abi.encode(result.payment), abi.encode(_payment(paymentId)));
        assertEq(abi.encode(result.intent), abi.encode(_snapshot(V2_INTENT), bytes32(0)));
        assertEq(returned, settlementData);
    }

    function test_SettlementDataTamperingFails() public {
        bytes32 paymentId = keccak256("tampered-settlement-data");
        bytes memory data = abi.encode(_payment(paymentId), _snapshot(V2_INTENT), bytes32(0), hex"010203");
        bytes memory proof = _encodeProof(verifier, V2_INTENT, AMOUNT, keccak256(data), data, WITNESS_KEY);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
        // Content starts after the sixteen-word head and the length word.
        attestation.data[545] = 0xff;
        vm.expectRevert("UPV: Data hash mismatch");
        _call(IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, abi.encode(attestation));
        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _call(IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, abi.encode(attestation));
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_RejectsPayloadWithoutSettlementDataField() public {
        uint256[4] memory lengths = [uint256(0), 447, 448, 480];
        for (uint256 i; i < lengths.length; i++) {
            _rejectPayload(new bytes(lengths[i]));
        }
        bytes32 paymentId = keccak256("old-480-byte-payload");
        _rejectPayload(abi.encode(_payment(paymentId), _snapshot(V2_INTENT), true));
        _rejectPayload(abi.encode(_payment(paymentId), _snapshot(V2_INTENT), false));
    }

    function _rejectPayload(bytes memory data) internal {
        bytes memory proof = _encodeProof(verifier, V2_INTENT, AMOUNT, keccak256(data), data, WITNESS_KEY);
        vm.expectRevert();
        _call(IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, proof);
    }

    function test_SettlementDataIsSigned() public {
        bytes32 paymentId = keccak256("signed-settlement-data");
        bytes memory proof = _validProof(verifier, V2_INTENT, paymentId);
        UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
            abi.decode(proof, (UnifiedPaymentVerifierV3.PaymentAttestation));
        attestation.data = abi.encode(_payment(paymentId), _snapshot(V2_INTENT), bytes32(0), abi.encode(true));
        vm.expectRevert("UPV: Data hash mismatch");
        _call(IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, abi.encode(attestation));
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_IgnoresIntentData() public {
        bytes[4] memory opaqueData =
            [bytes(hex"deadbeef"), bytes(hex"1234"), abi.encode(address(0), bytes("")), abi.encode(attacker, bytes(""))];
        for (uint256 index; index < opaqueData.length; index++) {
            bytes32 intentHash = keccak256(abi.encode("opaque-intent", index));
            bytes32 paymentId = keccak256(abi.encode("opaque-data", index));
            IOrchestratorV2.Intent memory intent = v2Caller.getIntent(V2_INTENT);
            intent.data = opaqueData[index];
            v2Caller.setIntent(intentHash, intent);
            IPaymentVerifier.PaymentVerificationResult memory result = _call(
                IUnifiedVerifierCaller(address(v2Caller)), verifier, intentHash, _validProof(verifier, intentHash, paymentId)
            );
            assertTrue(result.success);
            assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), intentHash);
        }
    }

    function test_ThreeFieldCallerDecodesV4Result() public {
        bytes32 paymentId = keccak256("three-field");
        IPaymentVerifier.PaymentVerificationResult memory result = _call(
            IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, _validProof(verifier, V2_INTENT, paymentId)
        );
        assertTrue(result.success);
        assertEq(result.intentHash, V2_INTENT);
        assertEq(result.releaseAmount, AMOUNT);
    }

    function test_NullifierAndSnapshotChecksUnchanged() public {
        bytes32 paymentId = keccak256("replay");
        bytes memory proof = _validProof(verifier, V2_INTENT, paymentId);
        IUnifiedVerifierCaller caller = IUnifiedVerifierCaller(address(v2Caller));
        _call(caller, verifier, V2_INTENT, proof);
        vm.expectRevert("Nullifier has already been used");
        _call(caller, verifier, V2_INTENT, proof);
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot = _snapshot(V2_INTENT);
        snapshot.amount++;
        paymentId = keccak256("snapshot-mismatch");
        proof = _proof(verifier, V2_INTENT, AMOUNT, _payment(paymentId), snapshot, WITNESS_KEY, true);
        vm.expectRevert("UPV: Snapshot amount mismatch");
        _call(caller, verifier, V2_INTENT, proof);
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

}
