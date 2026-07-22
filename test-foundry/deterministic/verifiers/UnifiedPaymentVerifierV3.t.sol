// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {FailingAttestationVerifier} from "contracts/mocks/FailingAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3CallerHarness} from "contracts/mocks/UnifiedPaymentVerifierV3Harness.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

interface IUnifiedVerifierCaller {
    function verifyPayment(IPaymentVerifier verifier, IPaymentVerifier.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifier.PaymentVerificationResult memory);
}

contract UnifiedVerifierV2CallerHarness {
    mapping(bytes32 => IOrchestratorV2.Intent) internal intents;

    function setIntent(bytes32 intentHash, IOrchestratorV2.Intent calldata intent) external {
        intents[intentHash] = intent;
    }

    function getIntent(bytes32 intentHash) external view returns (IOrchestratorV2.Intent memory) {
        return intents[intentHash];
    }

    function getDepositPreIntentHook(address, uint256) external pure returns (address) {
        return address(0);
    }

    function verifyPayment(IPaymentVerifier verifier, IPaymentVerifier.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifier.PaymentVerificationResult memory)
    {
        return verifier.verifyPayment(data);
    }
}

contract UnifiedPaymentVerifierV3Test is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xBAD;
    uint256 internal constant AMOUNT = 50e6;
    uint256 internal constant TIMESTAMP = 1_000_000;
    uint256 internal constant CONVERSION_RATE = 1e18;
    uint256 internal constant MAX_TIMESTAMP_BUFFER_MS = 48 hours * 1000;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant OTHER_METHOD = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("binding-payee");
    bytes32 internal constant LEGACY_INTENT = keccak256("legacy-intent");
    bytes32 internal constant V2_INTENT = keccak256("v2-intent");

    address internal witness;
    address internal attacker;
    NullifierRegistry internal legacyNullifierRegistry;
    NullifierRegistryV2 internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifierV3 internal verifier;
    UnifiedPaymentVerifierV3CallerHarness internal legacyCaller;
    UnifiedVerifierV2CallerHarness internal v2Caller;

    function setUp() public {
        vm.warp(TIMESTAMP);
        witness = vm.addr(WITNESS_KEY);
        attacker = makeAddr("attacker");
        legacyNullifierRegistry = new NullifierRegistry();
        nullifierRegistry = new NullifierRegistryV2(INullifierRegistry(address(legacyNullifierRegistry)));
        orchestratorRegistry = new OrchestratorRegistry();
        attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        legacyCaller = new UnifiedPaymentVerifierV3CallerHarness();
        v2Caller = new UnifiedVerifierV2CallerHarness();

        orchestratorRegistry.addOrchestrator(address(legacyCaller));
        orchestratorRegistry.addOrchestrator(address(v2Caller));
        nullifierRegistry.addWritePermission(address(verifier));
        legacyNullifierRegistry.addWritePermission(address(this));
        verifier.addPaymentMethod(METHOD);
        verifier.addPaymentMethod(OTHER_METHOD);
        _setLegacyIntent(LEGACY_INTENT);
        _setV2Intent(V2_INTENT);
    }

    function _setLegacyIntent(bytes32 intentHash) internal {
        legacyCaller.setIntent(
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

    function _setV2Intent(bytes32 intentHash) internal {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        v2Caller.setIntent(
            intentHash,
            IOrchestratorV2.Intent({
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
                referralFees: referralFees,
                postIntentHook: IPostIntentHookV2(address(0)),
                data: ""
            })
        );
    }

    function _payment(bytes32 paymentId) internal pure returns (UnifiedPaymentVerifierV3.PaymentDetails memory) {
        return UnifiedPaymentVerifierV3.PaymentDetails({
            method: METHOD,
            payeeId: PAYEE,
            amount: AMOUNT,
            currency: USD,
            timestamp: TIMESTAMP * 1000,
            paymentId: paymentId
        });
    }

    function _snapshot(bytes32 intentHash) internal pure returns (UnifiedPaymentVerifierV3.IntentSnapshot memory) {
        return UnifiedPaymentVerifierV3.IntentSnapshot({
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
        UnifiedPaymentVerifierV3 target,
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        UnifiedPaymentVerifierV3.PaymentDetails memory payment,
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot,
        uint256 signerKey,
        bool correctDataHash
    ) internal view returns (bytes memory) {
        bytes memory data = abi.encode(payment, snapshot);
        bytes32 dataHash = correctDataHash ? keccak256(data) : keccak256("tampered-hash");
        return _encodeProof(target, attestedIntentHash, releaseAmount, dataHash, data, signerKey);
    }

    function _encodeProof(
        UnifiedPaymentVerifierV3 target,
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        bytes32 dataHash,
        bytes memory data,
        uint256 signerKey
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, attestedIntentHash, releaseAmount, dataHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", target.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifierV3.PaymentAttestation({
                intentHash: attestedIntentHash,
                releaseAmount: releaseAmount,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }

    function _validProof(UnifiedPaymentVerifierV3 target, bytes32 intentHash, bytes32 paymentId)
        internal
        view
        returns (bytes memory)
    {
        return _proof(target, intentHash, AMOUNT, _payment(paymentId), _snapshot(intentHash), WITNESS_KEY, true);
    }

    function _call(
        IUnifiedVerifierCaller caller,
        UnifiedPaymentVerifierV3 target,
        bytes32 intentHash,
        bytes memory proof
    ) internal returns (IPaymentVerifier.PaymentVerificationResult memory) {
        return caller.verifyPayment(
            target, IPaymentVerifier.VerifyPaymentData({intentHash: intentHash, paymentProof: proof, data: ""})
        );
    }

    function _nullifier(bytes32 paymentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(METHOD, paymentId));
    }

    function _expectFailure(IUnifiedVerifierCaller caller, bytes32 intentHash, bytes memory proof, string memory reason)
        internal
    {
        vm.expectRevert(bytes(reason));
        _call(caller, verifier, intentHash, proof);
    }

    function test_ServesLegacyAndV2ShapedOrchestratorsWithThreeFieldResultAndBindings() public {
        bytes32 legacyPayment = keccak256("payment-legacy");
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(LEGACY_INTENT, METHOD, USD, AMOUNT, TIMESTAMP * 1000, legacyPayment, PAYEE);
        IPaymentVerifier.PaymentVerificationResult memory legacyResult = _call(
            IUnifiedVerifierCaller(address(legacyCaller)),
            verifier,
            LEGACY_INTENT,
            _validProof(verifier, LEGACY_INTENT, legacyPayment)
        );
        assertTrue(legacyResult.success);
        assertEq(legacyResult.intentHash, LEGACY_INTENT);
        assertEq(legacyResult.releaseAmount, AMOUNT);
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(legacyPayment)), LEGACY_INTENT);
        assertEq(nullifierRegistry.nullifierByIntentHash(LEGACY_INTENT), _nullifier(legacyPayment));

        bytes32 v2Payment = keccak256("payment-v2");
        IPaymentVerifier.PaymentVerificationResult memory v2Result = _call(
            IUnifiedVerifierCaller(address(v2Caller)), verifier, V2_INTENT, _validProof(verifier, V2_INTENT, v2Payment)
        );
        assertTrue(v2Result.success);
        assertEq(v2Result.intentHash, V2_INTENT);
        assertEq(v2Result.releaseAmount, AMOUNT);
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(v2Payment)), V2_INTENT);
        assertEq(nullifierRegistry.nullifierByIntentHash(V2_INTENT), _nullifier(v2Payment));
    }

    function test_RejectsPredecessorReplayAndReplayAcrossLiveOrchestrators() public {
        bytes32 predecessorPayment = keccak256("predecessor-payment");
        legacyNullifierRegistry.addNullifier(_nullifier(predecessorPayment));
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _validProof(verifier, LEGACY_INTENT, predecessorPayment),
            "Nullifier has already been used"
        );

        bytes32 sharedPayment = keccak256("shared-live-payment");
        _call(
            IUnifiedVerifierCaller(address(legacyCaller)),
            verifier,
            LEGACY_INTENT,
            _validProof(verifier, LEGACY_INTENT, sharedPayment)
        );
        _expectFailure(
            IUnifiedVerifierCaller(address(v2Caller)),
            V2_INTENT,
            _validProof(verifier, V2_INTENT, sharedPayment),
            "Nullifier has already been used"
        );
    }

    function test_RejectsMethodMismatchAndZeroPaymentFields() public {
        UnifiedPaymentVerifierV3.PaymentDetails memory payment = _payment(keccak256("method"));
        payment.method = OTHER_METHOD;
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, payment, _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Payment method mismatch"
        );

        payment = _payment(bytes32(0));
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, payment, _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Invalid payment ID"
        );

        payment = _payment(keccak256("zero-amount"));
        payment.amount = 0;
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, payment, _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Invalid payment amount"
        );

        payment = _payment(keccak256("zero-currency"));
        payment.currency = bytes32(0);
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, payment, _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Invalid payment currency"
        );
    }

    function test_RejectsDifferentAttestedIntentBeforeNullifierWrite() public {
        bytes32 paymentId = keccak256("wrong-intent");
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, V2_INTENT, AMOUNT, _payment(paymentId), _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Attestation hash mismatch"
        );
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_RejectsZeroReleaseBeforeNullifierWrite() public {
        bytes32 paymentId = keccak256("zero-release");
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, 0, _payment(paymentId), _snapshot(LEGACY_INTENT), WITNESS_KEY, true),
            "UPV: Invalid release amount"
        );
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_AttestationVerifierRotationRequiresDistinctDeployedContractAndOwner() public {
        vm.expectRevert(bytes("UPV: Invalid attestation verifier"));
        verifier.setAttestationVerifier(address(0));
        vm.expectRevert(bytes("UPV: Invalid attestation verifier"));
        verifier.setAttestationVerifier(attacker);
        vm.expectRevert(bytes("UPV: Same verifier"));
        verifier.setAttestationVerifier(address(attestationVerifier));

        SimpleAttestationVerifier replacement = new SimpleAttestationVerifier(witness);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.setAttestationVerifier(address(replacement));
        vm.expectEmit(true, true, false, true, address(verifier));
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_ConstructorAndPaymentMethodGovernanceEnforceAllBoundaries() public {
        vm.expectRevert(bytes("UPV: Invalid orchestrator registry"));
        new UnifiedPaymentVerifierV3(OrchestratorRegistry(address(0)), nullifierRegistry, attestationVerifier);
        vm.expectRevert(bytes("UPV: Invalid orchestrator registry"));
        new UnifiedPaymentVerifierV3(OrchestratorRegistry(attacker), nullifierRegistry, attestationVerifier);
        vm.expectRevert(bytes("UPV: Invalid nullifier registry"));
        new UnifiedPaymentVerifierV3(orchestratorRegistry, NullifierRegistryV2(address(0)), attestationVerifier);
        vm.expectRevert(bytes("UPV: Invalid attestation verifier"));
        new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifierRegistry, IAttestationVerifier(address(0)));

        vm.expectRevert(bytes("UPV: Payment method already exists"));
        verifier.addPaymentMethod(METHOD);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.addPaymentMethod(keccak256("cashapp"));
        verifier.removePaymentMethod(OTHER_METHOD);
        assertFalse(verifier.isPaymentMethod(OTHER_METHOD));
        vm.expectRevert(bytes("UPV: Payment method does not exist"));
        verifier.removePaymentMethod(OTHER_METHOD);
        vm.prank(attacker);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        verifier.removePaymentMethod(METHOD);
    }

    function test_RejectsUnauthorizedUnsupportedInvalidSignatureAndTamperedData() public {
        bytes32 paymentId = keccak256("invalid-cases");
        IPaymentVerifier.VerifyPaymentData memory callData = IPaymentVerifier.VerifyPaymentData({
            intentHash: LEGACY_INTENT, paymentProof: _validProof(verifier, LEGACY_INTENT, paymentId), data: ""
        });
        vm.prank(attacker);
        vm.expectRevert(bytes("Only orchestrator can call"));
        verifier.verifyPayment(callData);

        verifier.removePaymentMethod(METHOD);
        vm.expectRevert(bytes("UPV: Invalid payment method"));
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, callData.paymentProof);
        verifier.addPaymentMethod(METHOD);

        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, _payment(paymentId), _snapshot(LEGACY_INTENT), OTHER_KEY, true),
            "ThresholdSigVerifierUtils: Not enough valid witness signatures"
        );

        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _proof(verifier, LEGACY_INTENT, AMOUNT, _payment(paymentId), _snapshot(LEGACY_INTENT), WITNESS_KEY, false),
            "UPV: Data hash mismatch"
        );

        FailingAttestationVerifier failingVerifier = new FailingAttestationVerifier();
        verifier.setAttestationVerifier(address(failingVerifier));
        _expectFailure(
            IUnifiedVerifierCaller(address(legacyCaller)),
            LEGACY_INTENT,
            _validProof(verifier, LEGACY_INTENT, paymentId),
            "UPV: Invalid attestation"
        );
    }

    function test_ValidatesEveryIntentSnapshotFieldAndTimestampCeiling() public {
        bytes32 paymentId = keccak256("snapshot");
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot = _snapshot(LEGACY_INTENT);
        snapshot.intentHash = bytes32(0);
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot hash mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.payeeDetails = keccak256("wrong-payee");
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot payee mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.amount = 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot amount mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.paymentMethod = OTHER_METHOD;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot method mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.fiatCurrency = keccak256("EUR");
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot currency mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.conversionRate = 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot rate mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.signalTimestamp = 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot timestamp mismatch");
        snapshot = _snapshot(LEGACY_INTENT);
        snapshot.timestampBuffer = MAX_TIMESTAMP_BUFFER_MS + 1;
        _expectSnapshotFailure(snapshot, paymentId, "UPV: Snapshot timestamp buffer exceeds maximum");
    }

    function _expectSnapshotFailure(
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot,
        bytes32 paymentId,
        string memory reason
    ) internal {
        UnifiedPaymentVerifierV3.PaymentDetails memory payment = _payment(paymentId);
        payment.method = snapshot.paymentMethod;
        bytes memory proof = _proof(verifier, LEGACY_INTENT, AMOUNT, payment, snapshot, WITNESS_KEY, true);
        vm.expectRevert(bytes(reason));
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, proof);
    }

    function test_CapsOverpaymentOnLegacySnapshotShape() public {
        bytes32 paymentId = keccak256("overpayment");
        IPaymentVerifier.PaymentVerificationResult memory result = _call(
            IUnifiedVerifierCaller(address(legacyCaller)),
            verifier,
            LEGACY_INTENT,
            _proof(
                verifier, LEGACY_INTENT, AMOUNT * 2, _payment(paymentId), _snapshot(LEGACY_INTENT), WITNESS_KEY, true
            )
        );
        assertEq(result.releaseAmount, AMOUNT);
    }

    function test_VerifierRotationPreservesServiceAndRetiresOldWriter() public {
        UnifiedPaymentVerifierV3 replacement =
            new UnifiedPaymentVerifierV3(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        replacement.addPaymentMethod(METHOD);
        nullifierRegistry.addWritePermission(address(replacement));
        nullifierRegistry.removeWritePermission(address(verifier));

        bytes32 rotatedIntent = keccak256("rotated-intent");
        _setLegacyIntent(rotatedIntent);
        bytes32 paymentId = keccak256("rotated-payment");
        _call(
            IUnifiedVerifierCaller(address(legacyCaller)),
            replacement,
            rotatedIntent,
            _validProof(replacement, rotatedIntent, paymentId)
        );
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), rotatedIntent);
        assertFalse(nullifierRegistry.isWriter(address(verifier)));
        assertTrue(nullifierRegistry.isWriter(address(replacement)));
    }
}
