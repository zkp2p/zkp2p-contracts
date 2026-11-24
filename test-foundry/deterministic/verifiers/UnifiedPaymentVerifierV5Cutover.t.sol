// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {UnifiedPaymentVerifierV5} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV5.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {UnifiedPaymentVerifierV4V4CallerHarness} from "../../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

/**
 * @notice UPV5 and DisputeVerifierV2 wired as the Base cutover wires them: one production MultiAttestationVerifier
 * with two witnesses and threshold one, shared with the retiring UPV4 and DisputeVerifier, and NullifierRegistryV3
 * reading through NullifierRegistryV2 and the legacy registry.
 * @dev The golden vector is `test-foundry/fixtures/upv5-golden-vector.json` (version 2), which the attestation
 * service asserts byte for byte. Its values are embedded below because Foundry has no file-read permission here;
 * change both together.
 */
contract UnifiedPaymentVerifierV5CutoverTest is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);

    /// @dev Both real attestation verifiers revert here instead of returning false, so a bad or misdomained
    /// signature never reaches "UPV: Invalid attestation" or `AttestationVerificationFailed`.
    string internal constant THRESHOLD_ERROR = "ThresholdSigVerifierUtils: Not enough valid witness signatures";
    bytes32 internal constant PAYMENT_ATTESTATION_TYPEHASH =
        keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");

    uint256 internal constant WITNESS_A_KEY = 0xA11CE;
    uint256 internal constant WITNESS_B_KEY = 0xB0B;
    uint256 internal constant OUTSIDER_KEY = 0xBAD;

    /* ============ Golden vector (test-foundry/fixtures/upv5-golden-vector.json) ============ */

    bytes32 internal constant GOLDEN_METHOD = 0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268;
    bytes32 internal constant GOLDEN_PAYMENT_ID = 0x4b837befdc945edbecacae6ab3c40f8e404ffcb0ee7cbf5d944123d37564cd8b;
    bytes32 internal constant GOLDEN_PAYEE_ID = 0x36c81cbb101d4c53cfdd80f8d62c2dd6892b455614fbd4e8ad86963146c1a55a;
    uint256 internal constant GOLDEN_AMOUNT = 10000;
    bytes32 internal constant GOLDEN_CURRENCY = 0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e;
    uint256 internal constant GOLDEN_TIMESTAMP_MS = 1795400000000;
    bytes32 internal constant GOLDEN_INTENT = 0xdc701cf2c8c8811799ad84e33e897de7a564c64eaa7124ad11805495e3d575cb;
    uint256 internal constant GOLDEN_INTENT_AMOUNT = 100000000;
    uint256 internal constant GOLDEN_CONVERSION_RATE = 1e18;
    uint256 internal constant GOLDEN_SIGNAL_TIMESTAMP = 1795399000;
    uint256 internal constant GOLDEN_TIMESTAMP_BUFFER = 0;
    bytes32 internal constant GOLDEN_PAYER_COMMITMENT_HASH = bytes32(0);
    address internal constant GOLDEN_OWNER = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant GOLDEN_DISPUTE_WINDOW_SECONDS = 0;
    bytes32 internal constant GOLDEN_DISPUTE_ID = 0xd6283071c9bb5e4bf91a1270e1ceaf76786faeb0ba4e7cfc8614f54da4035130;
    bytes32 internal constant GOLDEN_NULLIFIER = 0xedf06cc2b152dcdbcffbbd4a7661587ff4fcb8f22310c2aef960a53157ee167d;
    bytes32 internal constant GOLDEN_PAYMENT_DATA_HASH =
        0x4e45abe8a6ecdcbcf7ee8888f0726e7026e487247aec59b6470a736201ac2db1;
    bytes32 internal constant GOLDEN_UNRELATED_NULLIFIER =
        0x7b290df65a5eb6ad829d9e4f4320876d89ed9983eb48f76f91ed4c90f5410a09;
    bytes32 internal constant GOLDEN_DISPUTE_DATA_HASH =
        0xba9d18772db7612acb405e2a4f690af059cbb1fbc2c3166a9dcc911fea9ce31d;
    bytes32 internal constant GOLDEN_DISPUTE_DATA_TWO_CANDIDATES_HASH =
        0xf1bf32720d980c14a725bbb2f4d3353d1fc76d70e7a4b2ccb827f03c13af534f;

    /// @dev `abi.encode(PaymentDetails, IntentSnapshot, bytes settlementData, bytes32[] nullifiers)`, one word a line.
    bytes internal constant GOLDEN_PAYMENT_DATA =
        hex"90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268"
        hex"36c81cbb101d4c53cfdd80f8d62c2dd6892b455614fbd4e8ad86963146c1a55a"
        hex"0000000000000000000000000000000000000000000000000000000000002710"
        hex"c4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e"
        hex"000000000000000000000000000000000000000000000000000001a2062de200"
        hex"4b837befdc945edbecacae6ab3c40f8e404ffcb0ee7cbf5d944123d37564cd8b"
        hex"dc701cf2c8c8811799ad84e33e897de7a564c64eaa7124ad11805495e3d575cb"
        hex"0000000000000000000000000000000000000000000000000000000005f5e100"
        hex"90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268"
        hex"c4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e"
        hex"36c81cbb101d4c53cfdd80f8d62c2dd6892b455614fbd4e8ad86963146c1a55a"
        hex"0000000000000000000000000000000000000000000000000de0b6b3a7640000"
        hex"000000000000000000000000000000000000000000000000000000006b039d58"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"000000000000000000000000000000000000000000000000000000000000dead"
        hex"0000000000000000000000000000000000000000000000000000000000000240"
        hex"0000000000000000000000000000000000000000000000000000000000000280"
        hex"0000000000000000000000000000000000000000000000000000000000000020"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"edf06cc2b152dcdbcffbbd4a7661587ff4fcb8f22310c2aef960a53157ee167d";

    /// @dev `disputeAttestationData`: `abi.encode(IDisputeVerifier.DisputeDetails, bytes32[] nullifiers)` with the
    /// golden nullifier as the only candidate, one word a line.
    bytes internal constant GOLDEN_DISPUTE_DATA =
        hex"90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268"
        hex"4b837befdc945edbecacae6ab3c40f8e404ffcb0ee7cbf5d944123d37564cd8b"
        hex"d6283071c9bb5e4bf91a1270e1ceaf76786faeb0ba4e7cfc8614f54da4035130"
        hex"0000000000000000000000000000000000000000000000000000000000002710"
        hex"c4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e"
        hex"00000000000000000000000000000000000000000000000000000000000000c0"
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"edf06cc2b152dcdbcffbbd4a7661587ff4fcb8f22310c2aef960a53157ee167d";

    /// @dev `disputeAttestationDataTwoCandidates`: an unrelated nullifier first, the golden one second.
    bytes internal constant GOLDEN_DISPUTE_DATA_TWO_CANDIDATES =
        hex"90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268"
        hex"4b837befdc945edbecacae6ab3c40f8e404ffcb0ee7cbf5d944123d37564cd8b"
        hex"d6283071c9bb5e4bf91a1270e1ceaf76786faeb0ba4e7cfc8614f54da4035130"
        hex"0000000000000000000000000000000000000000000000000000000000002710"
        hex"c4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e"
        hex"00000000000000000000000000000000000000000000000000000000000000c0"
        hex"0000000000000000000000000000000000000000000000000000000000000002"
        hex"7b290df65a5eb6ad829d9e4f4320876d89ed9983eb48f76f91ed4c90f5410a09"
        hex"edf06cc2b152dcdbcffbbd4a7661587ff4fcb8f22310c2aef960a53157ee167d";

    /// @dev Signed beside the data, not part of the vector.
    uint256 internal constant RELEASE_AMOUNT = GOLDEN_INTENT_AMOUNT;
    bytes32 internal constant SECOND_INTENT = keccak256("cutover-second-intent");
    bytes32 internal constant SECOND_PAYMENT_ID = keccak256("cutover-second-payment");
    bytes32 internal constant THIRD_INTENT = keccak256("cutover-third-intent");
    bytes32 internal constant THIRD_PAYMENT_ID = keccak256("cutover-third-payment");

    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal nullifierRegistryV2;
    NullifierRegistryV3 internal nullifierRegistryV3;
    OrchestratorRegistry internal orchestratorRegistry;
    MultiAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifierV4 internal upv4;
    UnifiedPaymentVerifierV5 internal upv5;
    DisputeVerifier internal disputeVerifier;
    DisputeVerifierV2 internal disputeVerifierV2;
    UnifiedPaymentVerifierV4V4CallerHarness internal caller;

    function setUp() public {
        legacyRegistry = new NullifierRegistry();
        nullifierRegistryV2 = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        nullifierRegistryV3 = new NullifierRegistryV3(nullifierRegistryV2);
        orchestratorRegistry = new OrchestratorRegistry();

        address[] memory witnesses = new address[](2);
        witnesses[0] = vm.addr(WITNESS_A_KEY);
        witnesses[1] = vm.addr(WITNESS_B_KEY);
        attestationVerifier = new MultiAttestationVerifier(witnesses, 1);

        upv4 = new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifierRegistryV2, attestationVerifier);
        upv5 = new UnifiedPaymentVerifierV5(
            orchestratorRegistry, INullifierRegistryV2(address(nullifierRegistryV3)), attestationVerifier
        );
        disputeVerifier = new DisputeVerifier(address(this), nullifierRegistryV2, attestationVerifier);
        disputeVerifierV2 = new DisputeVerifierV2(address(this), nullifierRegistryV3, attestationVerifier);
        caller = new UnifiedPaymentVerifierV4V4CallerHarness();

        orchestratorRegistry.addOrchestrator(address(caller));
        nullifierRegistryV2.addWritePermission(address(upv4));
        nullifierRegistryV3.addWritePermission(address(upv5));
        upv4.addPaymentMethod(GOLDEN_METHOD);
        upv5.addPaymentMethod(GOLDEN_METHOD);
        caller.setIntent(GOLDEN_INTENT, _goldenIntent());
        caller.setIntent(SECOND_INTENT, _goldenIntent());
        caller.setIntent(THIRD_INTENT, _goldenIntent());
    }

    /* ============ Golden vector ============ */

    function test_GoldenInputsEncodeToTheGoldenPayload() public pure {
        assertEq(GOLDEN_METHOD, keccak256("venmo"));
        assertEq(GOLDEN_PAYMENT_ID, keccak256("4242424242424242424"));
        assertEq(GOLDEN_PAYEE_ID, keccak256("golden-payee"));
        assertEq(GOLDEN_CURRENCY, keccak256("USD"));
        assertEq(GOLDEN_INTENT, keccak256("golden-intent"));
        assertEq(GOLDEN_DISPUTE_ID, keccak256("golden-case-1"));
        assertEq(GOLDEN_NULLIFIER, keccak256(abi.encodePacked(GOLDEN_METHOD, GOLDEN_PAYMENT_ID)));

        bytes memory encoded = abi.encode(
            _goldenPayment(), _goldenSnapshot(), _goldenSettlementData(), _single(GOLDEN_NULLIFIER)
        );
        assertEq(encoded, GOLDEN_PAYMENT_DATA);
        assertEq(GOLDEN_PAYMENT_DATA.length, 704);
        assertEq(keccak256(GOLDEN_PAYMENT_DATA), GOLDEN_PAYMENT_DATA_HASH);

        (
            IPaymentVerifierV2.PaymentDetails memory payment,
            IPaymentVerifierV2.IntentSnapshot memory snapshot,
            bytes memory settlementData,
            bytes32[] memory nullifiers
        ) = abi.decode(
            GOLDEN_PAYMENT_DATA,
            (IPaymentVerifierV2.PaymentDetails, IPaymentVerifierV2.IntentSnapshot, bytes, bytes32[])
        );
        _assertGoldenPayment(payment);
        _assertGoldenSnapshot(snapshot);
        assertEq(abi.decode(settlementData, (uint256)), GOLDEN_DISPUTE_WINDOW_SECONDS);
        assertEq(nullifiers.length, 1);
        assertEq(nullifiers[0], GOLDEN_NULLIFIER);
    }

    function test_GoldenPayloadSettlesThroughUPV5AndStoresTheGoldenNullifier() public {
        bytes memory proof = _signPayment(upv5.DOMAIN_SEPARATOR(), GOLDEN_INTENT, GOLDEN_PAYMENT_DATA, WITNESS_A_KEY);
        UnifiedPaymentVerifierV5.PaymentAttestation memory attestation =
            abi.decode(proof, (UnifiedPaymentVerifierV5.PaymentAttestation));
        assertEq(attestation.data, GOLDEN_PAYMENT_DATA);
        assertEq(attestation.dataHash, GOLDEN_PAYMENT_DATA_HASH);

        vm.expectEmit(true, true, true, true, address(nullifierRegistryV3));
        emit NullifierAdded(GOLDEN_NULLIFIER, GOLDEN_INTENT, address(upv5));
        vm.expectEmit(true, true, true, true, address(upv5));
        emit PaymentVerified(
            GOLDEN_INTENT,
            GOLDEN_METHOD,
            GOLDEN_CURRENCY,
            GOLDEN_AMOUNT,
            GOLDEN_TIMESTAMP_MS,
            GOLDEN_PAYMENT_ID,
            GOLDEN_PAYEE_ID
        );
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory settlementData) =
            _verify(upv5, GOLDEN_INTENT, proof);

        assertTrue(result.success);
        assertEq(result.intentHash, GOLDEN_INTENT);
        assertEq(result.releaseAmount, RELEASE_AMOUNT);
        assertEq(result.attestedReleaseAmount, RELEASE_AMOUNT);
        _assertGoldenPayment(result.payment);
        _assertGoldenSnapshot(result.intent);
        assertEq(settlementData, _goldenSettlementData());
        assertEq(nullifierRegistryV3.intentHashByNullifier(GOLDEN_NULLIFIER), GOLDEN_INTENT);
        assertFalse(nullifierRegistryV2.isNullified(GOLDEN_NULLIFIER));
    }

    function test_GoldenDisputeEvidenceBindsOnceV3HoldsTheGoldenNullifier() public {
        _assertGoldenDisputeData(GOLDEN_DISPUTE_DATA, GOLDEN_DISPUTE_DATA_HASH, _single(GOLDEN_NULLIFIER));

        IDisputeVerifier.DisputeAttestation memory attestation = _goldenDispute();
        attestation.signatures = _signatures(WITNESS_A_KEY, disputeVerifierV2.hashDisputeAttestation(attestation));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, GOLDEN_INTENT, GOLDEN_NULLIFIER)
        );
        disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);

        _settleGolden();

        (bytes32 disputeId, bytes32 disputeNullifier) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(GOLDEN_METHOD, GOLDEN_DISPUTE_ID)));
    }

    /// @dev The unrelated first candidate never binds; the golden nullifier in second place does.
    function test_GoldenTwoCandidateEvidenceBindsThroughTheSecondCandidate() public {
        assertEq(GOLDEN_UNRELATED_NULLIFIER, keccak256("golden-unrelated-nullifier"));
        bytes32[] memory candidates = new bytes32[](2);
        candidates[0] = GOLDEN_UNRELATED_NULLIFIER;
        candidates[1] = GOLDEN_NULLIFIER;
        _assertGoldenDisputeData(
            GOLDEN_DISPUTE_DATA_TWO_CANDIDATES, GOLDEN_DISPUTE_DATA_TWO_CANDIDATES_HASH, candidates
        );

        IDisputeVerifier.DisputeAttestation memory attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: GOLDEN_INTENT,
            dataHash: GOLDEN_DISPUTE_DATA_TWO_CANDIDATES_HASH,
            signatures: new bytes[](0),
            data: GOLDEN_DISPUTE_DATA_TWO_CANDIDATES
        });
        attestation.signatures = _signatures(WITNESS_A_KEY, disputeVerifierV2.hashDisputeAttestation(attestation));
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeVerifier.InvalidPaymentBinding.selector, GOLDEN_INTENT, GOLDEN_UNRELATED_NULLIFIER
            )
        );
        disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);

        _settleGolden();

        (bytes32 disputeId, bytes32 disputeNullifier) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);
        assertEq(disputeNullifier, keccak256(abi.encodePacked(GOLDEN_METHOD, GOLDEN_DISPUTE_ID)));
    }

    /// @dev A payment UPV4 settled into V2 before the cutover stays disputable through V3's fallback.
    function test_GoldenDisputeEvidenceBindsAPaymentUPV4SettledBeforeTheCutover() public {
        bytes memory v4Data = abi.encode(_goldenPayment(), _goldenSnapshot(), _goldenSettlementData());
        _verify(upv4, GOLDEN_INTENT, _signPayment(upv4.DOMAIN_SEPARATOR(), GOLDEN_INTENT, v4Data, WITNESS_A_KEY));
        assertEq(nullifierRegistryV2.intentHashByNullifier(GOLDEN_NULLIFIER), GOLDEN_INTENT);

        IDisputeVerifier.DisputeAttestation memory attestation = _goldenDispute();
        attestation.signatures = _signatures(WITNESS_A_KEY, disputeVerifierV2.hashDisputeAttestation(attestation));
        (bytes32 disputeId,) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);
    }

    /* ============ Production attestation verifier ============ */

    function test_UPV5SettlesWithEitherProductionWitnessAloneAndRejectsANonWitness() public {
        assertEq(attestationVerifier.witnessCount(), 2);
        assertEq(attestationVerifier.requiredSignatures(), 1);
        bytes32 domainSeparator = upv5.DOMAIN_SEPARATOR();

        _verify(upv5, GOLDEN_INTENT, _signPayment(domainSeparator, GOLDEN_INTENT, GOLDEN_PAYMENT_DATA, WITNESS_A_KEY));
        assertEq(nullifierRegistryV3.intentHashByNullifier(GOLDEN_NULLIFIER), GOLDEN_INTENT);

        bytes memory secondData = _payload(SECOND_INTENT, SECOND_PAYMENT_ID);
        _verify(upv5, SECOND_INTENT, _signPayment(domainSeparator, SECOND_INTENT, secondData, WITNESS_B_KEY));
        assertEq(nullifierRegistryV3.intentHashByNullifier(_nullifier(SECOND_PAYMENT_ID)), SECOND_INTENT);

        bytes memory outsiderProof =
            _signPayment(domainSeparator, THIRD_INTENT, _payload(THIRD_INTENT, THIRD_PAYMENT_ID), OUTSIDER_KEY);
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(upv5, THIRD_INTENT, outsiderProof);
        assertFalse(nullifierRegistryV3.isNullified(_nullifier(THIRD_PAYMENT_ID)));
    }

    function test_DisputeVerifierV2AcceptsEitherProductionWitnessAloneAndRejectsANonWitness() public {
        _settleGolden();
        IDisputeVerifier.DisputeAttestation memory attestation = _goldenDispute();
        bytes32 digest = disputeVerifierV2.hashDisputeAttestation(attestation);

        attestation.signatures = _signatures(WITNESS_A_KEY, digest);
        (bytes32 disputeId,) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);

        attestation.signatures = _signatures(WITNESS_B_KEY, digest);
        (disputeId,) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);

        attestation.signatures = _signatures(OUTSIDER_KEY, digest);
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
    }

    /* ============ Signing domains ============ */

    /// @dev UPV4 and UPV5 share the domain name and version; only the verifying contract separates them.
    function test_UPV5RejectsAPaymentAttestationSignedForUPV4sDomain() public {
        bytes32 v5Domain = upv5.DOMAIN_SEPARATOR();
        bytes memory misdomainedProof =
            _signPayment(upv4.DOMAIN_SEPARATOR(), GOLDEN_INTENT, GOLDEN_PAYMENT_DATA, WITNESS_A_KEY);

        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(upv5, GOLDEN_INTENT, misdomainedProof);
        assertFalse(nullifierRegistryV3.isNullified(GOLDEN_NULLIFIER));

        _verify(upv5, GOLDEN_INTENT, _signPayment(v5Domain, GOLDEN_INTENT, GOLDEN_PAYMENT_DATA, WITNESS_A_KEY));
        assertEq(nullifierRegistryV3.intentHashByNullifier(GOLDEN_NULLIFIER), GOLDEN_INTENT);
    }

    /// @dev The UPV4 control also shows UPV4's on-chain derivation produces the golden nullifier, and that UPV4
    /// emits the same `PaymentVerified` topic as UPV5, so indexers read both through one event.
    function test_UPV4RejectsAPaymentAttestationSignedForUPV5sDomain() public {
        bytes memory v4Data = abi.encode(_goldenPayment(), _goldenSnapshot(), _goldenSettlementData());
        bytes32 v4Domain = upv4.DOMAIN_SEPARATOR();
        bytes memory misdomainedProof = _signPayment(upv5.DOMAIN_SEPARATOR(), GOLDEN_INTENT, v4Data, WITNESS_A_KEY);

        vm.expectRevert(bytes(THRESHOLD_ERROR));
        _verify(upv4, GOLDEN_INTENT, misdomainedProof);
        assertFalse(nullifierRegistryV2.isNullified(GOLDEN_NULLIFIER));

        vm.expectEmit(true, true, true, true, address(upv4));
        emit PaymentVerified(
            GOLDEN_INTENT,
            GOLDEN_METHOD,
            GOLDEN_CURRENCY,
            GOLDEN_AMOUNT,
            GOLDEN_TIMESTAMP_MS,
            GOLDEN_PAYMENT_ID,
            GOLDEN_PAYEE_ID
        );
        _verify(upv4, GOLDEN_INTENT, _signPayment(v4Domain, GOLDEN_INTENT, v4Data, WITNESS_A_KEY));
        assertEq(nullifierRegistryV2.intentHashByNullifier(GOLDEN_NULLIFIER), GOLDEN_INTENT);
    }

    function test_DisputeVerifierV2RejectsEvidenceSignedForTheOldDisputeVerifiersDomain() public {
        _settleGolden();
        IDisputeVerifier.DisputeAttestation memory attestation = _goldenDispute();
        bytes32 oldDigest = disputeVerifier.hashDisputeAttestation(attestation);
        bytes32 newDigest = disputeVerifierV2.hashDisputeAttestation(attestation);
        assertNotEq(oldDigest, newDigest);

        attestation.signatures = _signatures(WITNESS_A_KEY, oldDigest);
        vm.expectRevert(bytes(THRESHOLD_ERROR));
        disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);

        attestation.signatures = _signatures(WITNESS_A_KEY, newDigest);
        (bytes32 disputeId,) = disputeVerifierV2.verifyDispute(attestation, GOLDEN_METHOD);
        assertEq(disputeId, GOLDEN_DISPUTE_ID);
    }

    /* ============ Helpers ============ */

    function _goldenIntent() internal pure returns (IOrchestratorV4.Intent memory) {
        return IOrchestratorV4.Intent({
            owner: GOLDEN_OWNER,
            to: GOLDEN_OWNER,
            escrow: address(1),
            depositId: 0,
            amount: GOLDEN_INTENT_AMOUNT,
            timestamp: GOLDEN_SIGNAL_TIMESTAMP,
            paymentMethod: GOLDEN_METHOD,
            fiatCurrency: GOLDEN_CURRENCY,
            conversionRate: GOLDEN_CONVERSION_RATE,
            payeeId: GOLDEN_PAYEE_ID,
            referralFees: new IReferralFee.ReferralFee[](0),
            payerCommitment: "",
            takerWhitelisted: false,
            arbitrator: address(0)
        });
    }

    function _goldenPayment() internal pure returns (IPaymentVerifierV2.PaymentDetails memory) {
        return IPaymentVerifierV2.PaymentDetails({
            method: GOLDEN_METHOD,
            payeeId: GOLDEN_PAYEE_ID,
            amount: GOLDEN_AMOUNT,
            currency: GOLDEN_CURRENCY,
            timestamp: GOLDEN_TIMESTAMP_MS,
            paymentId: GOLDEN_PAYMENT_ID
        });
    }

    function _goldenSnapshot() internal pure returns (IPaymentVerifierV2.IntentSnapshot memory) {
        return IPaymentVerifierV2.IntentSnapshot({
            intentHash: GOLDEN_INTENT,
            amount: GOLDEN_INTENT_AMOUNT,
            paymentMethod: GOLDEN_METHOD,
            fiatCurrency: GOLDEN_CURRENCY,
            payeeDetails: GOLDEN_PAYEE_ID,
            conversionRate: GOLDEN_CONVERSION_RATE,
            signalTimestamp: GOLDEN_SIGNAL_TIMESTAMP,
            timestampBuffer: GOLDEN_TIMESTAMP_BUFFER,
            payerCommitmentHash: GOLDEN_PAYER_COMMITMENT_HASH,
            owner: GOLDEN_OWNER
        });
    }

    /// @dev The dispute protection policy decodes settlement data as `abi.encode(uint256 disputeWindow)`.
    function _goldenSettlementData() internal pure returns (bytes memory) {
        return abi.encode(GOLDEN_DISPUTE_WINDOW_SECONDS);
    }

    /// @dev `originalPaymentId` is the raw provider payment ID hash, as for DisputeVerifier.
    function _assertGoldenDisputeData(bytes memory data, bytes32 dataHash, bytes32[] memory expectedCandidates)
        internal
        pure
    {
        IDisputeVerifier.DisputeDetails memory goldenDetails = IDisputeVerifier.DisputeDetails({
            paymentMethod: GOLDEN_METHOD,
            originalPaymentId: GOLDEN_PAYMENT_ID,
            disputeId: GOLDEN_DISPUTE_ID,
            paymentAmount: GOLDEN_AMOUNT,
            paymentCurrency: GOLDEN_CURRENCY
        });
        assertEq(abi.encode(goldenDetails, expectedCandidates), data);
        assertEq(keccak256(data), dataHash);

        (IDisputeVerifier.DisputeDetails memory details, bytes32[] memory candidates) =
            abi.decode(data, (IDisputeVerifier.DisputeDetails, bytes32[]));
        assertEq(details.paymentMethod, GOLDEN_METHOD);
        assertEq(details.originalPaymentId, GOLDEN_PAYMENT_ID);
        assertEq(details.disputeId, GOLDEN_DISPUTE_ID);
        assertEq(details.paymentAmount, GOLDEN_AMOUNT);
        assertEq(details.paymentCurrency, GOLDEN_CURRENCY);
        assertEq(candidates, expectedCandidates);
    }

    function _goldenDispute() internal pure returns (IDisputeVerifier.DisputeAttestation memory) {
        return IDisputeVerifier.DisputeAttestation({
            intentHash: GOLDEN_INTENT,
            dataHash: GOLDEN_DISPUTE_DATA_HASH,
            signatures: new bytes[](0),
            data: GOLDEN_DISPUTE_DATA
        });
    }

    /// @dev The golden payment with another intent and payment ID, carrying that payment's own nullifier.
    function _payload(bytes32 intentHash, bytes32 paymentId) internal pure returns (bytes memory) {
        IPaymentVerifierV2.PaymentDetails memory payment = _goldenPayment();
        payment.paymentId = paymentId;
        IPaymentVerifierV2.IntentSnapshot memory snapshot = _goldenSnapshot();
        snapshot.intentHash = intentHash;
        return abi.encode(payment, snapshot, _goldenSettlementData(), _single(_nullifier(paymentId)));
    }

    function _nullifier(bytes32 paymentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(GOLDEN_METHOD, paymentId));
    }

    function _single(bytes32 nullifier) internal pure returns (bytes32[] memory nullifiers) {
        nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;
    }

    function _assertGoldenPayment(IPaymentVerifierV2.PaymentDetails memory payment) internal pure {
        assertEq(payment.method, GOLDEN_METHOD);
        assertEq(payment.payeeId, GOLDEN_PAYEE_ID);
        assertEq(payment.amount, GOLDEN_AMOUNT);
        assertEq(payment.currency, GOLDEN_CURRENCY);
        assertEq(payment.timestamp, GOLDEN_TIMESTAMP_MS);
        assertEq(payment.paymentId, GOLDEN_PAYMENT_ID);
    }

    function _assertGoldenSnapshot(IPaymentVerifierV2.IntentSnapshot memory snapshot) internal pure {
        assertEq(snapshot.intentHash, GOLDEN_INTENT);
        assertEq(snapshot.amount, GOLDEN_INTENT_AMOUNT);
        assertEq(snapshot.paymentMethod, GOLDEN_METHOD);
        assertEq(snapshot.fiatCurrency, GOLDEN_CURRENCY);
        assertEq(snapshot.payeeDetails, GOLDEN_PAYEE_ID);
        assertEq(snapshot.conversionRate, GOLDEN_CONVERSION_RATE);
        assertEq(snapshot.signalTimestamp, GOLDEN_SIGNAL_TIMESTAMP);
        assertEq(snapshot.timestampBuffer, GOLDEN_TIMESTAMP_BUFFER);
        assertEq(snapshot.payerCommitmentHash, GOLDEN_PAYER_COMMITMENT_HASH);
        assertEq(snapshot.owner, GOLDEN_OWNER);
    }

    function _settleGolden() internal {
        bytes32 domainSeparator = upv5.DOMAIN_SEPARATOR();
        _verify(upv5, GOLDEN_INTENT, _signPayment(domainSeparator, GOLDEN_INTENT, GOLDEN_PAYMENT_DATA, WITNESS_A_KEY));
    }

    function _signPayment(bytes32 domainSeparator, bytes32 intentHash, bytes memory data, uint256 signerKey)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(data);
        bytes32 structHash = keccak256(abi.encode(PAYMENT_ATTESTATION_TYPEHASH, intentHash, RELEASE_AMOUNT, dataHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        return abi.encode(
            UnifiedPaymentVerifierV5.PaymentAttestation({
                intentHash: intentHash,
                releaseAmount: RELEASE_AMOUNT,
                dataHash: dataHash,
                signatures: _signatures(signerKey, digest),
                data: data,
                metadata: ""
            })
        );
    }

    function _signatures(uint256 signerKey, bytes32 digest) internal pure returns (bytes[] memory signatures) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
    }

    function _verify(IPaymentVerifierV2 verifier, bytes32 intentHash, bytes memory proof)
        internal
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory, bytes memory)
    {
        return caller.verifyPayment(verifier, IPaymentVerifierV2.VerifyPaymentData(intentHash, proof, ""));
    }
}
