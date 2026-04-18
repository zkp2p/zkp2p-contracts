// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { ThresholdSigVerifierUtils } from "../lib/ThresholdSigVerifierUtils.sol";

/**
 * @title MultiAttestationVerifier
 * @notice Verifies attestations from one of N authorized witness addresses
 * @dev Drop-in replacement for SimpleAttestationVerifier that supports a dynamic
 *      witness set with a configurable signature threshold. Threshold defaults to 1
 *      so the contract behaves as "any witness can sign" unless an owner raises it.
 */
contract MultiAttestationVerifier is IAttestationVerifier, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ============ Events ============ */

    event WitnessAdded(address indexed witness);
    event WitnessRemoved(address indexed witness);
    event RequiredSignaturesUpdated(uint256 oldThreshold, uint256 newThreshold);

    /* ============ State Variables ============ */

    EnumerableSet.AddressSet private witnessesSet;
    uint256 public requiredSignatures;

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the attestation verifier with an initial witness set and threshold
     * @param _initialWitnesses Initial witness addresses
     * @param _initialThreshold Initial required signature threshold
     */
    constructor(address[] memory _initialWitnesses, uint256 _initialThreshold) Ownable() {
        require(_initialThreshold > 0, "MAV: threshold must be > 0");
        require(_initialThreshold <= _initialWitnesses.length, "MAV: threshold exceeds count");

        for (uint256 witnessIndex = 0; witnessIndex < _initialWitnesses.length; witnessIndex++) {
            address witnessAddress = _initialWitnesses[witnessIndex];

            require(witnessAddress != address(0), "MAV: zero witness");
            require(witnessesSet.add(witnessAddress), "MAV: duplicate witness");

            emit WitnessAdded(witnessAddress);
        }

        requiredSignatures = _initialThreshold;

        emit RequiredSignaturesUpdated(0, _initialThreshold);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Verifies attestation signatures against the current witness set
     * @param _digest The message digest to verify
     * @param _sigs Array of signatures from witnesses
     * @return isValid True if the witness threshold is met
     */
    function verify(
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata
    ) external view override returns (bool isValid) {
        isValid = ThresholdSigVerifierUtils.verifyWitnessSignatures(
            _digest,
            _sigs,
            witnessesSet.values(),
            requiredSignatures
        );

        return isValid;
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice Adds a new witness to the authorized witness set
     * @param _witness New witness address
     */
    function addWitness(address _witness) external onlyOwner {
        require(_witness != address(0), "MAV: zero witness");
        require(witnessesSet.add(_witness), "MAV: already a witness");

        emit WitnessAdded(_witness);
    }

    /**
     * @notice Removes a witness from the authorized witness set
     * @param _witness Witness address to remove
     */
    function removeWitness(address _witness) external onlyOwner {
        require(witnessesSet.remove(_witness), "MAV: not a witness");
        require(witnessesSet.length() >= requiredSignatures, "MAV: below threshold");

        emit WitnessRemoved(_witness);
    }

    /**
     * @notice Updates the required witness signature threshold
     * @param _requiredSignatures New threshold
     */
    function setRequiredSignatures(uint256 _requiredSignatures) external onlyOwner {
        require(_requiredSignatures > 0, "MAV: threshold must be > 0");
        require(_requiredSignatures <= witnessesSet.length(), "MAV: exceeds witness count");

        emit RequiredSignaturesUpdated(requiredSignatures, _requiredSignatures);

        requiredSignatures = _requiredSignatures;
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the current witness set
     * @return The authorized witness addresses
     */
    function witnesses() external view returns (address[] memory) {
        return witnessesSet.values();
    }

    /**
     * @notice Returns whether an address is an authorized witness
     * @param _witness Address to check
     * @return True if the address is an authorized witness
     */
    function isWitness(address _witness) external view returns (bool) {
        return witnessesSet.contains(_witness);
    }

    /**
     * @notice Returns the current number of authorized witnesses
     * @return The witness count
     */
    function witnessCount() external view returns (uint256) {
        return witnessesSet.length();
    }
}
