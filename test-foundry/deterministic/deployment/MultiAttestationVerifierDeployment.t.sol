// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract MultiAttestationVerifierDeploymentTest is Test {
    address internal multisig;
    address[] internal configuredWitnesses;
    MultiAttestationVerifier internal multiVerifier;
    UnifiedPaymentVerifier internal paymentVerifier;

    function setUp() public {
        multisig = makeAddr("multisig");
        configuredWitnesses.push(makeAddr("witnessOne"));
        configuredWitnesses.push(makeAddr("witnessTwo"));
        configuredWitnesses.push(makeAddr("witnessThree"));

        multiVerifier = new MultiAttestationVerifier(configuredWitnesses, 2);
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        NullifierRegistry nullifierRegistry = new NullifierRegistry();
        paymentVerifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(nullifierRegistry)),
            IAttestationVerifier(address(new AttestationVerifierMock()))
        );
        paymentVerifier.setAttestationVerifier(address(multiVerifier));
        multiVerifier.transferOwnership(multisig);
    }

    function test_MultiAttestationVerifierHasConfiguredWitnessSet() public view {
        address[] memory actualWitnesses = multiVerifier.witnesses();
        assertEq(actualWitnesses.length, configuredWitnesses.length);
        for (uint256 index = 0; index < configuredWitnesses.length; index++) {
            assertTrue(_contains(actualWitnesses, configuredWitnesses[index]));
        }
    }

    function test_MultiAttestationVerifierHasConfiguredThreshold() public view {
        assertEq(multiVerifier.requiredSignatures(), 2);
    }

    function test_MultiAttestationVerifierAllowlistsEveryConfiguredWitness() public view {
        for (uint256 index = 0; index < configuredWitnesses.length; index++) {
            assertTrue(multiVerifier.isWitness(configuredWitnesses[index]));
        }
    }

    function test_MultiAttestationVerifierReportsConfiguredWitnessCount() public view {
        assertEq(multiVerifier.witnessCount(), configuredWitnesses.length);
    }

    function test_MultiAttestationVerifierTransfersOwnership() public view {
        assertEq(multiVerifier.owner(), multisig);
    }

    function test_UnifiedPaymentVerifierV2WiresMultiAttestationVerifier() public view {
        assertEq(address(paymentVerifier.attestationVerifier()), address(multiVerifier));
    }

    function _contains(address[] memory values, address needle) internal pure returns (bool) {
        for (uint256 index = 0; index < values.length; index++) {
            if (values[index] == needle) return true;
        }
        return false;
    }
}
