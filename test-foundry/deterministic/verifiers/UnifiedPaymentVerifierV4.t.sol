// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {UnifiedPaymentVerifierV3Test, IUnifiedVerifierCaller} from "./UnifiedPaymentVerifierV3.t.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {UnifiedPaymentVerifierV4CallerHarness, UnifiedPaymentVerifierV4V2CallerHarness} from "../../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

contract UnifiedPaymentVerifierV4Test is UnifiedPaymentVerifierV3Test {
    function setUp() public override {
        super.setUp();
        UnifiedPaymentVerifierV4 replacement =
            new UnifiedPaymentVerifierV4(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        replacement.addPaymentMethod(METHOD);
        replacement.addPaymentMethod(OTHER_METHOD);
        nullifierRegistry.removeWritePermission(address(verifier));
        nullifierRegistry.addWritePermission(address(replacement));
        verifier = UnifiedPaymentVerifierV3(address(replacement));
    }

    function _payloadSuffix() internal pure override returns (bytes memory) {
        return abi.encode(false);
    }

    function test_ReturnsBalanceFundedTrue() public {
        _checkBalanceFlag(true);
    }

    function test_ReturnsBalanceFundedFalse() public {
        _checkBalanceFlag(false);
    }

    function _checkBalanceFlag(bool flag) internal {
        UnifiedPaymentVerifierV4CallerHarness legacy = new UnifiedPaymentVerifierV4CallerHarness();
        UnifiedPaymentVerifierV4V2CallerHarness v2 = new UnifiedPaymentVerifierV4V2CallerHarness();
        legacy.setIntent(LEGACY_INTENT, legacyCaller.getIntent(LEGACY_INTENT));
        v2.setIntent(V2_INTENT, v2Caller.getIntent(V2_INTENT));
        orchestratorRegistry.addOrchestrator(address(legacy));
        orchestratorRegistry.addOrchestrator(address(v2));
        for (uint256 i; i < 2; i++) {
            bytes32 intentHash = i == 0 ? LEGACY_INTENT : V2_INTENT;
            bytes32 paymentId = keccak256(abi.encode("flag", flag, i));
            bytes memory data = abi.encode(_payment(paymentId), _snapshot(intentHash), flag);
            IPaymentVerifier.VerifyPaymentData memory request = IPaymentVerifier.VerifyPaymentData(
                intentHash, _encodeProof(verifier, intentHash, AMOUNT + 1, keccak256(data), data, WITNESS_KEY), ""
            );
            IPaymentVerifierV2.PaymentVerificationResultV2 memory result = i == 0
                ? legacy.verifyPayment(IPaymentVerifierV2(address(verifier)), request)
                : v2.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
            assertTrue(result.success);
            assertEq(result.intentHash, intentHash);
            assertEq(result.releaseAmount, AMOUNT);
            assertEq(result.balanceFunded, flag);
        }
    }

    function test_RejectsPayloadWithoutBalanceFlag() public {
        _rejectPayload("", bytes("UPV: Invalid payload length"));
    }

    function test_RejectsOverlongPayload() public {
        _rejectPayload(abi.encode(false, uint256(0)), bytes("UPV: Invalid payload length"));
    }

    function test_RejectsNonCanonicalFlag() public {
        _rejectPayload(abi.encode(uint256(2)), "");
    }

    function _rejectPayload(bytes memory suffix, bytes memory reason) internal {
        for (uint256 i; i < 2; i++) {
            bytes32 intentHash = i == 0 ? LEGACY_INTENT : V2_INTENT;
            bytes32 paymentId = keccak256(abi.encode("invalid-payload", i));
            bytes memory data = bytes.concat(abi.encode(_payment(paymentId), _snapshot(intentHash)), suffix);
            bytes memory proof = _encodeProof(verifier, intentHash, AMOUNT, keccak256(data), data, WITNESS_KEY);
            if (reason.length == 0) vm.expectRevert();
            else vm.expectRevert(reason);
            _call(IUnifiedVerifierCaller(i == 0 ? address(legacyCaller) : address(v2Caller)), verifier, intentHash, proof);
            assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
        }
    }

    function test_FlagIsSigned() public {
        bytes32 paymentId = keccak256("signed-flag");
        bytes memory proof = _validProof(verifier, LEGACY_INTENT, paymentId);
        UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
            abi.decode(proof, (UnifiedPaymentVerifierV3.PaymentAttestation));
        attestation.data = abi.encode(_payment(paymentId), _snapshot(LEGACY_INTENT), true);
        vm.expectRevert("UPV: Data hash mismatch");
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, abi.encode(attestation));
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_IgnoresIntentData() public {
        bytes[4] memory opaqueData =
            [bytes(hex"deadbeef"), bytes(hex"1234"), abi.encode(address(0), bytes("")), abi.encode(attacker, bytes(""))];
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < opaqueData.length; j++) {
                bytes32 intentHash = keccak256(abi.encode("opaque-intent", i, j));
                bytes32 paymentId = keccak256(abi.encode("opaque-data", i, j));
                if (i == 0) {
                    IOrchestrator.Intent memory intent = legacyCaller.getIntent(LEGACY_INTENT);
                    intent.data = opaqueData[j];
                    legacyCaller.setIntent(intentHash, intent);
                } else {
                    IOrchestratorV2.Intent memory intent = v2Caller.getIntent(V2_INTENT);
                    intent.data = opaqueData[j];
                    v2Caller.setIntent(intentHash, intent);
                }
                IPaymentVerifier.PaymentVerificationResult memory result = _call(
                    IUnifiedVerifierCaller(i == 0 ? address(legacyCaller) : address(v2Caller)),
                    verifier, intentHash, _validProof(verifier, intentHash, paymentId)
                );
                assertTrue(result.success);
                assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), intentHash);
            }
        }
    }

    function test_ThreeFieldCallerDecodesV4Result() public {
        for (uint256 i; i < 2; i++) {
            bytes32 intentHash = i == 0 ? LEGACY_INTENT : V2_INTENT;
            bytes32 paymentId = keccak256(abi.encode("three-field", i));
            IPaymentVerifier.PaymentVerificationResult memory result = _call(
                IUnifiedVerifierCaller(i == 0 ? address(legacyCaller) : address(v2Caller)),
                verifier, intentHash, _validProof(verifier, intentHash, paymentId)
            );
            assertTrue(result.success);
            assertEq(result.intentHash, intentHash);
            assertEq(result.releaseAmount, AMOUNT);
        }
    }

    function test_NullifierAndSnapshotChecksUnchanged() public {
        bytes32 paymentId = keccak256("replay");
        bytes memory proof = _validProof(verifier, LEGACY_INTENT, paymentId);
        IUnifiedVerifierCaller caller = IUnifiedVerifierCaller(address(legacyCaller));
        _call(caller, verifier, LEGACY_INTENT, proof);
        vm.expectRevert("Nullifier has already been used");
        _call(caller, verifier, LEGACY_INTENT, proof);
        UnifiedPaymentVerifierV3.IntentSnapshot memory snapshot = _snapshot(LEGACY_INTENT);
        snapshot.amount++;
        paymentId = keccak256("snapshot-mismatch");
        proof = _proof(verifier, LEGACY_INTENT, AMOUNT, _payment(paymentId), snapshot, WITNESS_KEY, true);
        vm.expectRevert("UPV: Snapshot amount mismatch");
        _call(caller, verifier, LEGACY_INTENT, proof);
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

}
