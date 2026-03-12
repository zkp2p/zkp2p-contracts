// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IPaymentVerifier } from "../../contracts/interfaces/IPaymentVerifier.sol";
import { FailingAttestationVerifier } from "../../contracts/mocks/FailingAttestationVerifier.sol";
import { UnifiedPaymentVerifier } from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import { UnifiedPaymentVerifierTestBase } from "../helpers/UnifiedPaymentVerifierTestBase.sol";

contract UnifiedPaymentVerifierIntegrationTest is UnifiedPaymentVerifierTestBase {
    uint256 internal constant MAX_TIMESTAMP_BUFFER_MS = 48 * 60 * 60 * 1000;

    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    BuiltUnifiedPaymentProof internal builtProof;

    function setUp() public {
        _setUpUnifiedPaymentVerifier();
        builtProof = _buildProof(_defaultConfig());
    }

    function test_verifyPaymentReturnsSuccessfulResult() public {
        IPaymentVerifier.PaymentVerificationResult memory result = _verifyAsOrchestrator(builtProof);

        assertTrue(result.success);
        assertEq(result.intentHash, intentHash);
        assertEq(result.releaseAmount, builtProof.attestation.releaseAmount);
    }

    function test_fulfillIntentEmitsPaymentVerifiedEvent() public {
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(
            intentHash,
            builtProof.paymentDetails.method,
            builtProof.paymentDetails.currency,
            builtProof.paymentDetails.amount,
            builtProof.paymentDetails.timestamp,
            builtProof.paymentDetails.paymentId,
            builtProof.paymentDetails.payeeId
        );

        _fulfill(builtProof);
    }

    function test_fulfillIntentNullifiesPaymentWithMethodScopedNullifier() public {
        _fulfill(builtProof);

        bytes32 expectedNullifier = keccak256(
            abi.encodePacked(builtProof.paymentDetails.method, builtProof.paymentDetails.paymentId)
        );

        assertTrue(nullifierRegistry.isNullified(expectedNullifier));
    }

    function test_fulfillIntentRevertsWhenSnapshotHashMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentHash = bytes32(0);
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot hash mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotAmountMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentAmount = builtProof.intentSnapshot.amount + 1;
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot amount mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotMethodMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentPaymentMethod = bytes32(0);
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot method mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotCurrencyMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentFiatCurrency = bytes32(0);
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot currency mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotRateMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentConversionRate = builtProof.intentSnapshot.conversionRate + 1;
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot rate mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotTimestampMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentSignalTimestamp = builtProof.intentSnapshot.signalTimestamp + 1;
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot timestamp mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotTimestampBufferExceedsMaximum() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentTimestampBuffer = MAX_TIMESTAMP_BUFFER_MS + 1;
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot timestamp buffer exceeds maximum");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenSnapshotPayeeMismatches() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.snapshotIntentPayeeDetails = keccak256(bytes("tampered"));
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Snapshot payee mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenPaymentMethodIsNotRegistered() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.paymentMethod = keccak256(bytes("invalid"));
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Invalid payment method");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenWitnessSignatureIsFromWrongSigner() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.attestationSignerKey = ATTACKER_KEY;
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenAttestationVerifierReturnsFalse() public {
        FailingAttestationVerifier failingVerifier = new FailingAttestationVerifier();

        vm.prank(owner);
        verifier.setAttestationVerifier(address(failingVerifier));

        vm.expectRevert("UPV: Invalid attestation");
        _fulfill(builtProof);
    }

    function test_verifyPaymentCapsReleaseAmountToIntentAmount() public {
        PaymentProofConfig memory config = _defaultConfig();
        config.attestationReleaseAmount = builtProof.attestation.releaseAmount * 2;

        IPaymentVerifier.PaymentVerificationResult memory result = _verifyAsOrchestrator(_buildProof(config));

        assertEq(result.releaseAmount, builtProof.intentSnapshot.amount);
    }

    function test_fulfillIntentRevertsWhenPaymentIdIsReusedAcrossSecondIntent() public {
        _fulfill(builtProof);

        bytes32 secondIntentHash = _signalIntent(intentOwner, receiver, INTENT_AMOUNT);
        IOrchestrator.Intent memory secondIntent = orchestrator.getIntent(secondIntentHash);
        PaymentProofConfig memory config = _defaultProofConfig(
            secondIntentHash,
            secondIntent,
            builtProof.paymentDetails.paymentId
        );
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("Nullifier has already been used");
        _fulfill(proof);
    }

    function test_verifyPaymentRevertsWhenCallerIsNotOrchestrator() public {
        vm.prank(attacker);
        vm.expectRevert("Only orchestrator can call");
        verifier.verifyPayment(
            IPaymentVerifier.VerifyPaymentData({
                intentHash: intentHash,
                paymentProof: builtProof.paymentProof,
                data: builtProof.verificationData
            })
        );
    }

    function test_fulfillIntentRevertsWhenAttestationDataHashDoesNotMatchPayload() public {
        PaymentProofConfig memory config = _defaultConfig();
        UnifiedPaymentVerifier.PaymentDetails memory tamperedDetails = builtProof.paymentDetails;
        tamperedDetails.amount += 1;
        config.useCustomAttestationData = true;
        config.attestationData = _encodePayload(tamperedDetails, builtProof.intentSnapshot);
        BuiltUnifiedPaymentProof memory proof = _buildProof(config);

        vm.expectRevert("UPV: Data hash mismatch");
        _fulfill(proof);
    }

    function test_fulfillIntentRevertsWhenAttestationDigestIsTampered() public {
        BuiltUnifiedPaymentProof memory tamperedProof = builtProof;
        tamperedProof.attestation.releaseAmount += 1;
        tamperedProof.paymentProof = abi.encode(tamperedProof.attestation);

        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _fulfill(tamperedProof);
    }

    function _defaultConfig() internal view returns (PaymentProofConfig memory config) {
        config = _defaultProofConfig(intentHash, intent, defaultPaymentId);
    }

    function _fulfill(BuiltUnifiedPaymentProof memory proof) internal {
        vm.prank(attacker);
        orchestrator.fulfillIntent(
            IOrchestrator.FulfillIntentParams({
                paymentProof: proof.paymentProof,
                intentHash: proof.attestation.intentHash,
                verificationData: proof.verificationData,
                postIntentHookData: ""
            })
        );
    }
}
