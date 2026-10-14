// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {CascadeStackFixture} from "../deterministic/helpers/CascadeStackFixture.sol";
import {ICascadeDisputeProtectionPolicy as P} from "contracts/interfaces/ICascadeDisputeProtectionPolicy.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";

/// @notice Opt-in cross-repo smoke; set ATTESTOR_POLICY_SMOKE_ROOT to a checkout with dependencies.
/// @dev Outside deterministic/, so coverage never runs this FFI test.
contract AttestorCascadeSmokeTest is CascadeStackFixture {
    function test_ServiceSignedProofSmoke() public {
        string memory attestor = vm.envOr("ATTESTOR_POLICY_SMOKE_ROOT", string(""));
        if (bytes(attestor).length == 0) {
            vm.skip(true);
            return;
        }
        assertEq(block.chainid, 31337);
        string[3] memory modes = [string("balance"), "personal", "goods"];
        uint256 paid;
        for (uint256 index; index < modes.length; index++) {
            if (index == 1) _stake(vault, taker, INTENT_AMOUNT);
            assertEq(vault.freeStake(taker), index == 1 ? INTENT_AMOUNT : 0);
            bytes32 id = _signalDefault();
            bytes memory proof = _serviceProof(attestor, id, modes[index], index);
            UnifiedPaymentVerifierV4.PaymentAttestation memory attestation =
                abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
            assertEq(attestation.data.length, 480);
            (,, bool balanceFunded) = abi.decode(
                attestation.data,
                (UnifiedPaymentVerifierV4.PaymentDetails, UnifiedPaymentVerifierV4.IntentSnapshot, bool)
            );
            assertEq(balanceFunded, index == 0);
            assertEq(attestation.releaseAmount, index == 2 ? 45e6 : INTENT_AMOUNT);
            uint256 net = attestation.releaseAmount - attestation.releaseAmount * PROTOCOL_FEE / 1e18
                - attestation.releaseAmount * REFERRAL_FEE / 1e18;
            orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, id, "", ""));
            P.DisputeProtectionIntent memory record = protection.getDisputeProtectionIntent(id);
            (address lockOwner, uint256 lockedAmount,) = vault.locks(id);
            if (index == 0) {
                assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.BYPASS));
                assertEq(lockOwner, address(0));
                assertEq(lockedAmount, 0);
                assertEq(token.balanceOf(address(vault)), 0);
                paid += net;
            } else if (index == 1) {
                assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.STAKE));
                assertEq(lockOwner, taker);
                assertEq(lockedAmount, INTENT_AMOUNT);
                paid += net;
            } else {
                assertEq(uint256(record.collateralSource), uint256(P.CollateralSource.DEFERRED_PAYOUT));
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
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(id);
        string[] memory command = new string[](11);
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
        return vm.ffi(command);
    }
}
