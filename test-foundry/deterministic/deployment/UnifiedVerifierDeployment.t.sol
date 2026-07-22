// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract UnifiedVerifierDeploymentTest is Test {
    address internal witness;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifier internal verifier;
    NullifierRegistry internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;

    function setUp() public {
        witness = makeAddr("paymentWitness");
        orchestratorRegistry = new OrchestratorRegistry();
        nullifierRegistry = new NullifierRegistry();
        attestationVerifier = new SimpleAttestationVerifier(witness);
        verifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(nullifierRegistry)),
            IAttestationVerifier(address(attestationVerifier))
        );
        nullifierRegistry.addWritePermission(address(verifier));
        nullifierRegistry.removeWritePermission(address(verifier));
    }

    function test_SimpleAttestationVerifierDeploymentSetsOwner() public view {
        assertEq(attestationVerifier.owner(), address(this));
    }

    function test_UnifiedPaymentVerifierDeploymentSetsOwner() public view {
        assertEq(verifier.owner(), address(this));
    }

    function test_UnifiedPaymentVerifierDeploymentSetsOrchestratorRegistry() public view {
        assertEq(address(verifier.orchestratorRegistry()), address(orchestratorRegistry));
    }

    function test_UnifiedPaymentVerifierDeploymentSetsNullifierRegistry() public view {
        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
    }

    function test_UnifiedPaymentVerifierDeploymentSetsAttestationVerifier() public view {
        assertEq(address(verifier.attestationVerifier()), address(attestationVerifier));
    }

    function test_RetiredVerifierLegacyNullifierPermissionIsRevoked() public view {
        assertFalse(nullifierRegistry.isWriter(address(verifier)));
    }
}
