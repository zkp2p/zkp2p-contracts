// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";

import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";

import {DisputeProtectionStackV2Fixture} from "../deterministic/helpers/DisputeProtectionStackV2Fixture.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";

/// @notice Opt-in cross-repo smoke; set ATTESTOR_POLICY_SMOKE_ROOT to a checkout with dependencies.
/// @dev Outside deterministic/, so coverage never runs this FFI test. The attestor must sign settlementData =
/// abi.encode(disputeWindow): zero for balance payments and 14 days for goods and personal payments.
contract AttestorCascadeSmokeTest is DisputeProtectionStackV2Fixture {
    function test_ServiceSignedProofSmoke() public {
        string memory attestor = vm.envOr("ATTESTOR_POLICY_SMOKE_ROOT", string(""));
        if (bytes(attestor).length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(block.chainid, 31337);
        string[4] memory modes = [string("balance"), "personal", "goods", "personal"];
        uint256 paid;
        for (uint256 index; index < modes.length; index++) {
            if (index == 1) _stake(vault, taker, INTENT_AMOUNT);
            assertEq(vault.freeStake(taker), index == 1 ? INTENT_AMOUNT : 0);
            bool whitelisted = index == 3;
            if (whitelisted) _whitelist(taker);
            bytes32 id = _signalDefault();
            bytes memory proof = _serviceProof(attestor, id, modes[index], index);
            UnifiedPaymentVerifierV4.PaymentAttestation memory attestation =
                abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
            (, IPaymentVerifierV2.IntentSnapshot memory snapshot, bytes memory settlementData) = abi.decode(
                attestation.data, (IPaymentVerifierV2.PaymentDetails, IPaymentVerifierV2.IntentSnapshot, bytes)
            );
            assertEq(snapshot.intentHash, id);
            uint256 window = abi.decode(settlementData, (uint256));
            assertEq(window, index == 0 ? 0 : RISK_WINDOW);
            assertEq(attestation.releaseAmount, index == 2 ? 45e6 : INTENT_AMOUNT);
            uint256 net = attestation.releaseAmount - attestation.releaseAmount * PROTOCOL_FEE / 1e18
                - attestation.releaseAmount * REFERRAL_FEE / 1e18;
            vm.recordLogs();
            orchestrator.fulfillIntent(IOrchestratorV4.FulfillIntentParams(proof, id, ""));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (window == 0 || whitelisted) {
                for (uint256 i; i < logs.length; ++i) assertTrue(logs[i].emitter != address(protection));
            }
            vm.clearMockedCalls();
            bool open = protection.getProtection(id).depositor != address(0);
            (address lockOwner, uint256 lockedAmount, uint64 maturesAt) = vault.locks(id);
            if (window == 0 || whitelisted) {
                assertFalse(open);
            } else {
                assertTrue(open);
                assertEq(maturesAt, block.timestamp + window);
            }
            if (index == 0 || whitelisted) {
                assertEq(lockOwner, address(0));
                assertEq(lockedAmount, 0);
                if (!whitelisted) assertEq(token.balanceOf(address(vault)), 0);
                paid += net;
            } else if (index == 1) {
                assertEq(lockOwner, taker);
                assertEq(lockedAmount, INTENT_AMOUNT);
                paid += net;
            } else {
                assertEq(lockOwner, other);
                assertEq(lockedAmount, net);
                assertEq(token.balanceOf(address(vault)), INTENT_AMOUNT + net);
            }
            assertEq(token.balanceOf(other), paid);
            assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
        }
    }

    function _serviceProof(string memory attestor, bytes32 id, string memory mode, uint256 paymentId)
        private
        returns (bytes memory)
    {
        IOrchestratorV4.Intent memory intent = orchestrator.getIntent(id);
        string[] memory command = new string[](12);
        command[0] = "node";
        command[1] = string.concat(attestor, "/node_modules/tsx/dist/cli.mjs");
        command[2] = "--tsconfig";
        command[3] = string.concat(attestor, "/tsconfig.json");
        command[4] = string.concat(attestor, "/scripts/stake-policy-smoke.ts");
        command[5] = vm.toString(address(upv));
        command[6] = vm.toString(id);
        command[7] = vm.toString(intent.amount);
        command[8] = vm.toString(intent.timestamp);
        command[9] = mode;
        command[10] = vm.toString(paymentId);
        command[11] = vm.toString(intent.owner);
        return vm.ffi(command);
    }
}
