// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {OrchestratorV3Fixture} from "./OrchestratorV3Fixture.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";

/// @dev Real UPV routing for policy lifecycle tests. These suites mock signatures; DisputePolicyTest signs real proofs.
abstract contract PolicyVerifierFixture is OrchestratorV3Fixture {
    UnifiedPaymentVerifierV3 internal policyVerifier;

    function _configurePolicyVerifier(
        DisputeProtectionPolicy policy,
        NullifierRegistryV2 payments,
        IAttestationVerifier signatures
    ) internal {
        policyVerifier = new UnifiedPaymentVerifierV3(orchestratorRegistry, payments, signatures);
        policyVerifier.addPaymentMethod(METHOD);
        policyVerifier.setAttestationVerifier(address(policy));
        payments.addWritePermission(address(policyVerifier));
        paymentVerifierRegistry.removePaymentMethod(METHOD);
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(policyVerifier), currencies);
        policy.registerPolicyRoute(address(orchestrator), address(policyVerifier), address(signatures));
    }

    function _fulfillPolicy(bytes32 intentHash, uint256 releaseAmount) internal {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        bytes memory data = abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(
                intent.paymentMethod, intent.payeeId, 5000, USD, block.timestamp * 1000, keccak256("payment")
            ),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash,
                intent.amount,
                intent.paymentMethod,
                USD,
                intent.payeeId,
                intent.conversionRate,
                intent.timestamp,
                0
            ),
            bytes32(0)
        );
        UnifiedPaymentVerifierV3.PaymentAttestation memory attestation = UnifiedPaymentVerifierV3.PaymentAttestation(
            intentHash, releaseAmount, keccak256(data), new bytes[](0), data, ""
        );
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(abi.encode(attestation), intentHash, "", ""));
    }
}
