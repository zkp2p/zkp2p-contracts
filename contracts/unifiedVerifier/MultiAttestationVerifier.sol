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
 *
 *      Depositors can replace the protocol witness set for their own deposits by storing
 *      a tagged attestor override in the deposit's payment method verification data
 *      (DepositPaymentMethodData.data), encoded as:
 *
 *          abi.encode(ATTESTOR_OVERRIDE_TAG, address[] attestors, uint256 threshold)
 *
 *      The UnifiedPaymentVerifier forwards that data as the `_data` param of verify().
 *      Tagged data verifies signatures exclusively against the depositor's attestors;
 *      the protocol witnesses only count if explicitly included. Data that is empty or
 *      doesn't start with the tag (e.g. legacy deposit data) falls back to the protocol
 *      witness set, keeping existing deposits unaffected.
 */
contract MultiAttestationVerifier is IAttestationVerifier, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ============ Events ============ */

    event WitnessAdded(address indexed witness);
    event WitnessRemoved(address indexed witness);
    event RequiredSignaturesUpdated(uint256 oldThreshold, uint256 newThreshold);

    /* ============ Constants ============ */

    // First 32 bytes of deposit verification data that opts a deposit into a custom attestor set
    bytes32 public constant ATTESTOR_OVERRIDE_TAG = keccak256("zkp2p.attestorOverride.v1");

    // Caps override size so depositors can't make fulfillment unreasonably expensive for takers
    uint256 public constant MAX_OVERRIDE_ATTESTORS = 10;

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
     * @notice Verifies attestation signatures against the attestor set resolved from `_data`
     * @param _digest The message digest to verify
     * @param _sigs Array of signatures from attestors
     * @param _data Deposit verification data; a tagged attestor override replaces the protocol
     * witness set, anything else resolves to the protocol witness set
     * @return isValid True if the resolved attestor threshold is met
     */
    function verify(
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata _data
    ) external view override returns (bool isValid) {
        (address[] memory attestors, uint256 threshold) = resolveAttestors(_data);

        isValid = ThresholdSigVerifierUtils.verifyWitnessSignatures(
            _digest,
            _sigs,
            attestors,
            threshold
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
     * @notice Resolves the attestor set and threshold that apply to a deposit's verification data
     * @dev Data tagged with ATTESTOR_OVERRIDE_TAG must decode as (bytes32, address[], uint256) and
     * is validated strictly; malformed overrides revert so a depositor's custom trust policy can
     * never silently fall back to the protocol witness set. Attestors can be EOAs or ERC-1271
     * contracts. Untagged data (empty or legacy formats) resolves to the protocol witness set.
     * @param _data Deposit verification data (DepositPaymentMethodData.data)
     * @return attestors The attestor addresses signatures are verified against
     * @return threshold The minimum number of distinct attestor signatures required
     */
    function resolveAttestors(bytes calldata _data)
        public
        view
        returns (address[] memory attestors, uint256 threshold)
    {
        if (_data.length < 32 || bytes32(_data[0:32]) != ATTESTOR_OVERRIDE_TAG) {
            return (witnessesSet.values(), requiredSignatures);
        }

        (, attestors, threshold) = abi.decode(_data, (bytes32, address[], uint256));

        require(attestors.length > 0, "MAV: empty override attestors");
        require(attestors.length <= MAX_OVERRIDE_ATTESTORS, "MAV: too many override attestors");
        require(threshold > 0, "MAV: override threshold must be > 0");
        require(threshold <= attestors.length, "MAV: override threshold exceeds count");

        for (uint256 i = 0; i < attestors.length; i++) {
            require(attestors[i] != address(0), "MAV: zero override attestor");

            for (uint256 j = i + 1; j < attestors.length; j++) {
                require(attestors[i] != attestors[j], "MAV: duplicate override attestor");
            }
        }
    }

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
