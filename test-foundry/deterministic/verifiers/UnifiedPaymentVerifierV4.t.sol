// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {UnifiedPaymentVerifierV3Test, IUnifiedVerifierCaller} from "./UnifiedPaymentVerifierV3.t.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {IPaymentValidationHook} from "contracts/interfaces/IPaymentValidationHook.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";

contract PaymentValidationHookMock is IPaymentValidationHook {
    function validatePayment(bytes32, bytes calldata data, bytes calldata hookData) external pure {
        require(keccak256(data) == abi.decode(hookData, (bytes32)), "Hook: Unexpected data");
    }
}

/// @dev Run the existing verifier behavior tests unchanged through V4's matching ABI.
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

    function test_ForwardsOpaqueDataToEachIntentsCanonicalHook() public {
        for (uint256 i; i < 2; i++) {
            bytes32 intentHash = i == 0 ? LEGACY_INTENT : V2_INTENT;
            bytes32 paymentId = keccak256(abi.encode("generic-hook-payment", i));
            bytes memory data = bytes.concat(abi.encode(_payment(paymentId), _snapshot(intentHash)), hex"123456");
            bytes memory hookData = abi.encode(keccak256(data));
            PaymentValidationHookMock hook = new PaymentValidationHookMock();
            _setIntentData(intentHash, abi.encode(hook, hookData));
            bytes memory proof = _encodeProof(verifier, intentHash, AMOUNT, keccak256(data), data, WITNESS_KEY);
            vm.expectCall(
                address(hook),
                abi.encodeWithSelector(IPaymentValidationHook.validatePayment.selector, intentHash, data, hookData),
                1
            );
            IUnifiedVerifierCaller caller = IUnifiedVerifierCaller(i == 0 ? address(legacyCaller) : address(v2Caller));
            caller.verifyPayment(
                verifier,
                IPaymentVerifier.VerifyPaymentData({
                    intentHash: intentHash,
                    paymentProof: proof,
                    data: abi.encode(address(0), bytes("untrusted fulfillment data"))
                })
            );
            assertEq(nullifierRegistry.intentHashByNullifier(_nullifier(paymentId)), intentHash);
        }
    }

    function test_HookRejectionDoesNotConsumePayment() public {
        bytes32 paymentId = keccak256("rejected-hook-payment");
        _setIntentData(LEGACY_INTENT, abi.encode(new PaymentValidationHookMock(), abi.encode(bytes32(0))));
        bytes memory proof = _validProof(verifier, LEGACY_INTENT, paymentId);
        vm.expectRevert("Hook: Unexpected data");
        _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, proof);
        assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
    }

    function test_MalformedEnvelopeOrUndeployedHookRejectsPayment() public {
        bytes32 paymentId = keccak256("invalid-hook-payment");
        bytes memory proof = _validProof(verifier, LEGACY_INTENT, paymentId);
        bytes[3] memory invalidData =
            [bytes(hex"1234"), abi.encode(address(0), bytes("")), abi.encode(attacker, bytes(""))];
        for (uint256 i; i < invalidData.length; i++) {
            _setIntentData(LEGACY_INTENT, invalidData[i]);
            vm.expectRevert();
            _call(IUnifiedVerifierCaller(address(legacyCaller)), verifier, LEGACY_INTENT, proof);
            assertFalse(nullifierRegistry.isNullified(_nullifier(paymentId)));
        }
    }

    function _setIntentData(bytes32 intentHash, bytes memory data) internal {
        if (intentHash == LEGACY_INTENT) {
            IOrchestrator.Intent memory intent = legacyCaller.getIntent(intentHash);
            intent.data = data;
            legacyCaller.setIntent(intentHash, intent);
        } else {
            IOrchestratorV2.Intent memory intent = v2Caller.getIntent(intentHash);
            intent.data = data;
            v2Caller.setIntent(intentHash, intent);
        }
    }
}
