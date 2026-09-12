// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Bytes32ArrayUtils} from "../external/Bytes32ArrayUtils.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "../interfaces/INullifierRegistryV2.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";

/**
 * @title BaseUnifiedPaymentVerifierV4
 * @notice Base contract for unified payment verification that manages configuration for multiple payment methods.
 *
 * This contract handles:
 * - Supported payment methods
 * - Attestation verification through pluggable attestation verifiers
 *
 * @dev This is an abstract contract that must be inherited by concrete implementations.
 */
abstract contract BaseUnifiedPaymentVerifierV4 is Ownable {
    using Bytes32ArrayUtils for bytes32[];

    /* ============ Events ============ */

    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    INullifierRegistryV2 public immutable nullifierRegistry;
    IAttestationVerifier public attestationVerifier;

    bytes32[] public paymentMethods;
    mapping(bytes32 => bool) public isPaymentMethod;

    // Assignments survive deactivation so a method can never reopen consumed payments.
    mapping(bytes32 => bytes32) public nullifierNamespace;

    /* ============ Modifiers ============ */

    /**
     * Modifier to ensure only an authorized orchestrator can call.
     */
    modifier onlyOrchestrator() {
        require(orchestratorRegistry.isOrchestrator(msg.sender), "Only orchestrator can call");
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Initializes base payment verifier
     * @param _orchestratorRegistry The orchestrator registry contract that authorizes orchestrators
     * @param _nullifierRegistry The nullifier registry contract that will be used to prevent double-spends
     * @param _attestationVerifier The attestation verifier contract that will be used to verify attestation by the
     * offchain / ZK attestation service
     */
    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        INullifierRegistryV2 _nullifierRegistry,
        IAttestationVerifier _attestationVerifier
    ) Ownable() {
        require(address(_orchestratorRegistry).code.length != 0, "UPV: Invalid orchestrator registry");
        require(address(_nullifierRegistry).code.length != 0, "UPV: Invalid nullifier registry");
        require(address(_attestationVerifier).code.length != 0, "UPV: Invalid attestation verifier");
        orchestratorRegistry = _orchestratorRegistry;
        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Registers or reactivates a payment method with its permanent replay namespace.
     * @param _paymentMethod The payment method hash; hash the payment method name in lowercase.
     * @param _namespace The final replay namespace shared by methods that consume the same payments.
     */
    function addPaymentMethod(bytes32 _paymentMethod, bytes32 _namespace) external onlyOwner {
        require(_paymentMethod != bytes32(0), "UPV: Invalid payment method");
        require(_namespace != bytes32(0), "UPV: Invalid nullifier namespace");
        require(!isPaymentMethod[_paymentMethod], "UPV: Payment method already exists");

        bytes32 assignedNamespace = nullifierNamespace[_paymentMethod];
        if (assignedNamespace == bytes32(0)) {
            nullifierNamespace[_paymentMethod] = _namespace;
        } else {
            require(assignedNamespace == _namespace, "UPV: Nullifier namespace mismatch");
        }

        isPaymentMethod[_paymentMethod] = true;
        paymentMethods.push(_paymentMethod);

        emit PaymentMethodAdded(_paymentMethod);
    }

    /**
     * @notice Deactivates a payment method while retaining its replay namespace.
     * @param _paymentMethod The payment method to remove
     */
    function removePaymentMethod(bytes32 _paymentMethod) external onlyOwner {
        require(isPaymentMethod[_paymentMethod], "UPV: Payment method does not exist");

        delete isPaymentMethod[_paymentMethod];
        paymentMethods.removeStorage(_paymentMethod);

        emit PaymentMethodRemoved(_paymentMethod);
    }

    /**
     * @notice Updates the attestation verifier contract
     * @param _newVerifier The new attestation verifier address
     */
    function setAttestationVerifier(address _newVerifier) external onlyOwner {
        address oldVerifier = address(attestationVerifier);
        require(_newVerifier.code.length != 0, "UPV: Invalid attestation verifier");
        require(_newVerifier != oldVerifier, "UPV: Same verifier");

        attestationVerifier = IAttestationVerifier(_newVerifier);
        emit AttestationVerifierUpdated(oldVerifier, _newVerifier);
    }

    /* ============ View Functions ============ */

    /// @notice Returns the currently active payment methods.
    function getPaymentMethods() external view returns (bytes32[] memory) {
        return paymentMethods;
    }

    /* ============ Internal Functions ============ */

    /**
     * Validates and adds a nullifier to prevent double-spending
     * @param _nullifier The nullifier to add
     */
    function _validateAndAddNullifier(bytes32 _nullifier, bytes32 _intentHash) internal {
        require(!nullifierRegistry.isNullified(_nullifier), "Nullifier has already been used");
        nullifierRegistry.addNullifier(_nullifier, _intentHash);
    }
}
