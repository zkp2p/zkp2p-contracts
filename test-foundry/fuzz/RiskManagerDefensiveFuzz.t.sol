// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerHarnessFixture} from "../deterministic/helpers/RiskManagerHarnessFixture.sol";

import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {RiskManagerStateHarness} from "contracts/mocks/RiskManagerHarnessMocks.sol";

/// @dev Added assurance: corrupted settled positions must fail closed before any
/// attestation validation or stake mutation can occur.
contract RiskManagerDefensiveFuzzTest is RiskManagerHarnessFixture {
    RiskManagerStateHarness internal stateManager;

    function setUp() public override {
        super.setUp();
        stateManager = new RiskManagerStateHarness(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
    }

    function testFuzz_ChargebackRejectsEveryNonChargebackModeBeforeValidation(uint8 rawMode) public {
        IRiskManager.RiskMode invalidMode = IRiskManager.RiskMode(bound(uint256(rawMode), 0, 1));
        bytes32 intentHash = keccak256(abi.encode("defensive-invalid-mode", invalidMode));
        stateManager.forcePosition(
            intentHash, invalidMode, IRiskManager.PositionStatus.SETTLED, PAYPAL, 10_000, uint64(block.timestamp + DAY)
        );

        bytes memory data = "";
        IRiskManager.ChargebackAttestation memory attestation = IRiskManager.ChargebackAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data, metadata: ""
        });

        vm.expectRevert(abi.encodeWithSelector(IRiskManager.PositionModeMismatch.selector, intentHash, invalidMode));
        stateManager.submitChargeback(attestation);
        assertEq(uint256(stateManager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SETTLED));
    }
}
