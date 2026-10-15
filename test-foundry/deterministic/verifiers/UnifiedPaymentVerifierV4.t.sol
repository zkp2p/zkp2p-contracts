// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {UnifiedPaymentVerifierV3Test, IUnifiedVerifierCaller} from "./UnifiedPaymentVerifierV3.t.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {UnifiedPaymentVerifierV4CallerHarness, UnifiedPaymentVerifierV4V2CallerHarness, UnifiedPaymentVerifierV4V4CallerHarness} from "../../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

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

    function test_O4IntentValidatesBeforeV2Probe() public {
        UnifiedPaymentVerifierV4V4CallerHarness caller = new UnifiedPaymentVerifierV4V4CallerHarness();
        IOrchestratorV2.Intent memory source = v2Caller.getIntent(V2_INTENT);
        IOrchestratorV4.Intent memory intent = IOrchestratorV4.Intent(
            source.owner, source.to, source.escrow, source.depositId, source.amount, source.timestamp,
            source.paymentMethod, source.fiatCurrency, source.conversionRate, source.payeeId,
            new IReferralFee.ReferralFee[](1), hex"aabbccdd"
        );
        intent.referralFees[0] = IReferralFee.ReferralFee(address(123), 1e15);
        caller.setIntent(V2_INTENT, intent);
        orchestratorRegistry.addOrchestrator(address(caller));
        bytes32 paymentId = keccak256("o4-intent");
        IPaymentVerifier.VerifyPaymentData memory request = IPaymentVerifier.VerifyPaymentData(
            V2_INTENT, _validProof(verifier, V2_INTENT, paymentId), ""
        );
        intent.amount++;
        caller.setIntent(V2_INTENT, intent);
        vm.expectRevert("UPV: Snapshot amount mismatch");
        caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
        intent.amount--;
        caller.setIntent(V2_INTENT, intent);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory extension) =
            caller.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
        assertTrue(result.success);
        assertEq(result.intentHash, V2_INTENT);
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(extension, "");
        assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), V2_INTENT);
    }

    function _payloadSuffix() internal pure override returns (bytes memory) {
        return "";
    }

    function test_Old480BytePayloadReturnsTrueBoolAsExtensionWordZero() public {
        _checkBalanceFlag(true);
    }

    function test_Old480BytePayloadReturnsFalseBoolAsExtensionWordZero() public {
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
            (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory extensionData) = i == 0
                ? legacy.verifyPayment(IPaymentVerifierV2(address(verifier)), request)
                : v2.verifyPayment(IPaymentVerifierV2(address(verifier)), request);
            assertTrue(result.success);
            assertEq(result.intentHash, intentHash);
            assertEq(result.releaseAmount, AMOUNT);
            assertEq(result.attestedReleaseAmount, AMOUNT + 1);
            assertEq(abi.encode(result.payment), abi.encode(_payment(paymentId)));
            assertEq(abi.encode(result.intent), abi.encode(_snapshot(intentHash)));
            // The old trailing bool is harmless: it is now exactly extension word 0.
            assertEq(data.length, 480);
            assertEq(extensionData, abi.encode(flag));
        }
    }

    function test_Accepts448BytePayloadWithEmptyExtension() public {
        _checkExtension("");
    }

    function test_ReturnsSignedExtensionData() public {
        _checkExtension(hex"deadbeef010203");
    }

    function testFuzz_ReturnsSignedExtensionData(bytes memory extensionData) public {
        vm.assume(extensionData.length <= 1024);
        _checkExtension(extensionData);
    }

    function _checkExtension(bytes memory extensionData) internal {
        UnifiedPaymentVerifierV4CallerHarness caller = new UnifiedPaymentVerifierV4CallerHarness();
        caller.setIntent(LEGACY_INTENT, legacyCaller.getIntent(LEGACY_INTENT));
        orchestratorRegistry.addOrchestrator(address(caller));
        bytes32 paymentId = keccak256("extension");
        bytes memory data = bytes.concat(abi.encode(_payment(paymentId), _snapshot(LEGACY_INTENT)), extensionData);
        assertEq(data.length, 448 + extensionData.length);
        bytes memory proof = _encodeProof(verifier, LEGACY_INTENT, AMOUNT - 1, keccak256(data), data, WITNESS_KEY);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
        attestation.metadata = hex"badbad";
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory returnedExtension) = caller.verifyPayment(
            IPaymentVerifierV2(address(verifier)), IPaymentVerifier.VerifyPaymentData(LEGACY_INTENT, abi.encode(attestation), "")
        );
        assertTrue(result.success);
        assertEq(result.intentHash, LEGACY_INTENT);
        assertEq(result.releaseAmount, AMOUNT - 1);
        assertEq(result.attestedReleaseAmount, AMOUNT - 1);
        assertEq(abi.encode(result.payment), abi.encode(_payment(paymentId)));
        assertEq(abi.encode(result.intent), abi.encode(_snapshot(LEGACY_INTENT)));
        assertEq(returnedExtension, extensionData);
    }

    function test_ExtensionTamperingFails() public {
        bytes32 paymentId = keccak256("tampered-extension");
        bytes memory data = bytes.concat(abi.encode(_payment(paymentId), _snapshot(LEGACY_INTENT)), hex"010203");
        bytes memory proof = _encodeProof(verifier, LEGACY_INTENT, AMOUNT, keccak256(data), data, WITNESS_KEY);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation = abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
        attestation.data[449] = 0xff;
        vm.expectRevert("UPV: Data hash mismatch");
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, abi.encode(attestation));
        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, abi.encode(attestation));
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_RejectsPayloadUnder448Bytes() public {
        _rejectPayloadLength(0);
        _rejectPayloadLength(447);
    }

    function test_ReturnsNonCanonicalFlagUninterpreted() public {
        _checkExtension(abi.encode(uint256(2)));
    }

    function _rejectPayloadLength(uint256 length) internal {
        for (uint256 i; i < 2; i++) {
            bytes32 intentHash = i == 0 ? LEGACY_INTENT : V2_INTENT;
            bytes memory data = new bytes(length);
            bytes memory proof = _encodeProof(verifier, intentHash, AMOUNT, keccak256(data), data, WITNESS_KEY);
            vm.expectRevert("UPV: Invalid payload length");
            _call(IUnifiedVerifierCaller(i == 0 ? address(legacyCaller) : address(v2Caller)), verifier, intentHash, proof);
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
