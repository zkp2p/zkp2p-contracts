// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerHarnessFixture} from "../helpers/RiskManagerHarnessFixture.sol";

import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {RiskManagerStateHarness} from "contracts/mocks/RiskManagerHarnessMocks.sol";

contract RiskManagerDefensiveTest is RiskManagerHarnessFixture {
    function test_ChargebackRejectsNonChargebackModeBeforeValidation() public {
        RiskManagerStateHarness stateManager = new RiskManagerStateHarness(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
        bytes32 intentHash = keccak256("defensive-invalid-mode");
        stateManager.forcePosition(
            intentHash,
            IRiskManager.RiskMode.NONE,
            IRiskManager.PositionStatus.SETTLED,
            PAYPAL,
            10_000,
            uint64(block.timestamp + DAY)
        );

        bytes memory data = "";
        IRiskManager.ChargebackAttestation memory attestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data, metadata: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(IRiskManager.PositionModeMismatch.selector, intentHash, IRiskManager.RiskMode.NONE)
        );
        stateManager.submitChargeback(attestation);
        assertEq(uint256(stateManager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SETTLED));
    }
}
