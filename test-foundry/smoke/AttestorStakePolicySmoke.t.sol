// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {DisputeWindowBypassFixture} from "../deterministic/helpers/DisputeWindowBypassFixture.sol";

/// @notice Opt-in cross-repo smoke test. Set ATTESTOR_POLICY_SMOKE_ROOT to a local
/// attestation-service checkout with dependencies installed; skips otherwise.
/// Lives outside test-foundry/deterministic/, so coverage never runs it.
contract AttestorStakePolicySmokeTest is DisputeWindowBypassFixture {
    function test_ServiceSignedProofSmoke() public {
        string memory attestor = vm.envOr("ATTESTOR_POLICY_SMOKE_ROOT", string(""));
        if (bytes(attestor).length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(block.chainid, 31337);
        _stake();
        string[3] memory modes = [string("personal"), "goods", "balance"];
        for (uint256 i; i < modes.length; i++) {
            bytes32 hash = _signalUnstaked();
            IOrchestratorV3.Intent memory intent = orchestrator.getIntent(hash);
            string[] memory command = new string[](11);
            command[0] = "node";
            command[1] = string.concat(attestor, "/node_modules/tsx/dist/cli.mjs");
            command[2] = "--tsconfig";
            command[3] = string.concat(attestor, "/tsconfig.json");
            command[4] = string.concat(attestor, "/scripts/stake-policy-smoke.ts");
            command[5] = vm.toString(address(upv));
            command[6] = vm.toString(hash);
            command[7] = vm.toString(intent.amount);
            command[8] = vm.toString(intent.timestamp);
            command[9] = modes[i];
            command[10] = vm.toString(i);
            bytes memory proof = vm.ffi(command);
            UnifiedPaymentVerifierV3.PaymentAttestation memory attestation =
                abi.decode(proof, (UnifiedPaymentVerifierV3.PaymentAttestation));
            assertEq(attestation.data.length, 480);
            if (i != 2) _setNoStake(hash, false);
            _settle(hash, proof);
            assertEq(attestation.releaseAmount, i == 1 ? 45e6 : 50e6);
            assertEq(
                protection.getDisputeProtectionIntent(hash).releaseEligibleAt,
                block.timestamp + (i == 2 ? 0 : RISK_WINDOW)
            );
        }
        assertEq(token.balanceOf(taker), 145e6);
        assertEq(vault.lockedStake(taker), 95e6);
    }
}
