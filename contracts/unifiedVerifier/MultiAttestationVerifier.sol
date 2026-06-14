// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { ThresholdSigVerifierUtils } from "../lib/ThresholdSigVerifierUtils.sol";

/**
 * @title MultiAttestationVerifier
 * @notice Verifies attestations against the witness set or a deposit-specific attestor set
 * @dev Drop-in replacement for SimpleAttestationVerifier that supports a dynamic
 *      witness set with a configurable signature threshold. Threshold defaults to 1
 *      so the contract behaves as "any witness can sign" unless an owner raises it.
 *
 *      Depositors can add their own attestors by storing tagged deposit attestor data
 *      in the deposit's payment method verification data
 *      (DepositPaymentMethodData.data), encoded as:
 *
 *          abi.encode(DEPOSIT_ATTESTORS_TAG, address[] attestors, uint256 threshold)
 *
 *      The UnifiedPaymentVerifier forwards that data as the `_data` param of verify().
 *      Tagged data appends the depositor's attestors to the witness set and verifies
 *      against that combined set. Empty data falls back to the witness set for legacy
 *      deposits. Non-empty untagged data reverts so malformed depositor configuration
 *      cannot silently fall back to a different policy.
 */
contract MultiAttestationVerifier is IAttestationVerifier, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ============ Events ============ */

    event WitnessAdded(address indexed witness);
    event WitnessRemoved(address indexed witness);
    event RequiredSignaturesUpdated(uint256 oldThreshold, uint256 newThreshold);

    /* ============ Constants ============ */

    // First 32 bytes of deposit verification data that opts a deposit into additional attestors
    bytes32 public constant DEPOSIT_ATTESTORS_TAG = keccak256("zkp2p.depositAttestors.v1");

    // Caps additional deposit-specific attestors so fulfillment remains bounded for takers
    uint256 public constant MAX_DEPOSIT_ATTESTORS = 3;

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
     * @param _data Deposit verification data; empty data resolves to the witness set,
     * and tagged data appends the depositor's attestors to the witness set
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
     * @dev Data tagged with DEPOSIT_ATTESTORS_TAG must decode as (bytes32, address[], uint256) and
     * is validated strictly; malformed deposit attestor data reverts so a depositor's custom trust
     * policy can never silently fall back to a different policy. Attestors can be EOAs or ERC-1271
     * contracts. Empty data resolves to the witness set for legacy deposits. Tagged data appends
     * deposit attestors to the witness set. Any non-empty untagged data reverts so invalid custom
     * configuration fails closed.
     * @param _data Deposit verification data (DepositPaymentMethodData.data)
     * @return attestors The attestor addresses signatures are verified against
     * @return threshold The minimum number of distinct attestor signatures required
     */
    function resolveAttestors(bytes calldata _data)
        public
        view
        returns (address[] memory attestors, uint256 threshold)
    {
        if (_data.length == 0) {
            return (witnessesSet.values(), requiredSignatures);
        }

        require(_data.length >= 32, "MAV: invalid deposit attestors tag");
        require(bytes32(_data[0:32]) == DEPOSIT_ATTESTORS_TAG, "MAV: invalid deposit attestors tag");

        address[] memory defaultWitnesses = witnessesSet.values();
        address[] memory depositAttestors;
        (, depositAttestors, threshold) = abi.decode(_data, (bytes32, address[], uint256));

        require(depositAttestors.length > 0, "MAV: empty deposit attestors");
        require(depositAttestors.length <= MAX_DEPOSIT_ATTESTORS, "MAV: too many deposit attestors");
        require(threshold > 0, "MAV: deposit threshold must be > 0");
        require(threshold >= requiredSignatures, "MAV: deposit threshold below default");
        require(threshold <= defaultWitnesses.length + depositAttestors.length, "MAV: deposit threshold exceeds count");

        attestors = new address[](defaultWitnesses.length + depositAttestors.length);
        for (uint256 witnessIndex = 0; witnessIndex < defaultWitnesses.length; witnessIndex++) {
            attestors[witnessIndex] = defaultWitnesses[witnessIndex];
        }

        for (uint256 i = 0; i < depositAttestors.length; i++) {
            address depositAttestor = depositAttestors[i];
            require(depositAttestor != address(0), "MAV: zero deposit attestor");

            for (uint256 witnessIndex = 0; witnessIndex < defaultWitnesses.length; witnessIndex++) {
                // IMPORTANT: deployment/client flows must keep deposit attestors disjoint from
                // default witnesses. If that invariant changes, deduplicate the combined set
                // instead of reverting on default/deposit overlap, and only reject duplicates
                // within the user-provided list if needed.
                require(depositAttestor != defaultWitnesses[witnessIndex], "MAV: duplicate deposit attestor");
            }

            for (uint256 j = i + 1; j < depositAttestors.length; j++) {
                require(depositAttestor != depositAttestors[j], "MAV: duplicate deposit attestor");
            }

            attestors[defaultWitnesses.length + i] = depositAttestor;
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
