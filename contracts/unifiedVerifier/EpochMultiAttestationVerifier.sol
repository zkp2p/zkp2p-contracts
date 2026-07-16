// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IEpochAttestationVerifier } from "../interfaces/IEpochAttestationVerifier.sol";
import { ThresholdSigVerifierUtils } from "../lib/ThresholdSigVerifierUtils.sol";

/**
 * @title EpochMultiAttestationVerifier
 * @notice Threshold verifier with delayed, atomic witness-set changes and immutable history.
 * @dev Payment and chargeback deployments must use separate instances and credentials. Every
 *      epoch is immutably constrained to an independent 2-of-3 witness set; deployments additionally
 *      choose the governance delay applied before a complete replacement set can activate.
 */
contract EpochMultiAttestationVerifier is IEpochAttestationVerifier, Ownable {
    uint256 public constant REQUIRED_WITNESS_COUNT = 3;
    uint256 public constant REQUIRED_SIGNATURES = 2;

    uint64 public immutable configChangeDelay;
    uint64 public override currentEpoch;
    uint64 public pendingActivationTime;
    uint256 public pendingThreshold;

    mapping(uint64 => address[]) private epochWitnesses;
    mapping(uint64 => uint256) public requiredSignaturesAtEpoch;
    mapping(uint64 => uint64) public epochActivatedAt;
    address[] private pendingWitnesses;

    event ConfigurationProposed(bytes32 indexed configHash, uint64 activationTime);
    event ConfigurationCancelled(bytes32 indexed configHash);
    event ConfigurationActivated(uint64 indexed epoch, uint256 threshold, address[] witnesses);

    constructor(
        address[] memory _initialWitnesses,
        uint256 _initialThreshold,
        uint64 _configChangeDelay
    ) Ownable() {
        _validateConfiguration(_initialWitnesses, _initialThreshold);

        configChangeDelay = _configChangeDelay;
        currentEpoch = 1;
        epochActivatedAt[1] = uint64(block.timestamp);
        requiredSignaturesAtEpoch[1] = _initialThreshold;
        _storeWitnesses(epochWitnesses[1], _initialWitnesses);

        emit ConfigurationActivated(1, _initialThreshold, _initialWitnesses);
    }

    function verify(
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata
    ) external view override returns (bool isValid) {
        return _verifyAtEpoch(currentEpoch, _digest, _sigs);
    }

    function verifyAtEpoch(
        uint64 _epoch,
        bytes32 _digest,
        bytes[] calldata _sigs,
        bytes calldata
    ) external view override returns (bool isValid) {
        return _verifyAtEpoch(_epoch, _digest, _sigs);
    }

    function proposeConfiguration(
        address[] calldata _witnesses,
        uint256 _threshold
    ) external onlyOwner {
        _validateConfiguration(_witnesses, _threshold);

        delete pendingWitnesses;
        for (uint256 witnessIndex = 0; witnessIndex < _witnesses.length; witnessIndex++) {
            pendingWitnesses.push(_witnesses[witnessIndex]);
        }

        pendingThreshold = _threshold;
        pendingActivationTime = uint64(block.timestamp) + configChangeDelay;

        emit ConfigurationProposed(_configurationHash(_witnesses, _threshold), pendingActivationTime);
    }

    function cancelPendingConfiguration() external onlyOwner {
        bytes32 configHash = pendingConfigurationHash();
        require(configHash != bytes32(0), "EMAV: no pending config");

        _clearPendingConfiguration();
        emit ConfigurationCancelled(configHash);
    }

    function activatePendingConfiguration() external {
        require(pendingActivationTime != 0, "EMAV: no pending config");
        require(block.timestamp >= pendingActivationTime, "EMAV: delay active");

        uint64 nextEpoch = currentEpoch + 1;
        uint256 threshold = pendingThreshold;
        address[] memory witnesses_ = pendingWitnesses;

        currentEpoch = nextEpoch;
        epochActivatedAt[nextEpoch] = uint64(block.timestamp);
        requiredSignaturesAtEpoch[nextEpoch] = threshold;
        _storeWitnesses(epochWitnesses[nextEpoch], witnesses_);
        _clearPendingConfiguration();

        emit ConfigurationActivated(nextEpoch, threshold, witnesses_);
    }

    function epochAt(uint64 _timestamp) external view override returns (uint64 epoch) {
        if (_timestamp < epochActivatedAt[1]) return 0;

        uint64 low = 1;
        uint64 high = currentEpoch;
        while (low < high) {
            uint64 middle = low + (high - low + 1) / 2;
            if (epochActivatedAt[middle] <= _timestamp) low = middle;
            else high = middle - 1;
        }
        return low;
    }

    function witnessesAtEpoch(uint64 _epoch) external view returns (address[] memory) {
        return epochWitnesses[_epoch];
    }

    function witnesses() external view returns (address[] memory) {
        return epochWitnesses[currentEpoch];
    }

    function requiredSignatures() external view returns (uint256) {
        return requiredSignaturesAtEpoch[currentEpoch];
    }

    function isWitnessAtEpoch(uint64 _epoch, address _witness) public view returns (bool) {
        address[] storage witnesses_ = epochWitnesses[_epoch];
        for (uint256 witnessIndex = 0; witnessIndex < witnesses_.length; witnessIndex++) {
            if (witnesses_[witnessIndex] == _witness) return true;
        }
        return false;
    }

    function isWitness(address _witness) external view returns (bool) {
        return isWitnessAtEpoch(currentEpoch, _witness);
    }

    function pendingConfigurationHash() public view returns (bytes32) {
        if (pendingActivationTime == 0) return bytes32(0);
        return _configurationHash(pendingWitnesses, pendingThreshold);
    }

    function _verifyAtEpoch(
        uint64 _epoch,
        bytes32 _digest,
        bytes[] calldata _sigs
    ) internal view returns (bool) {
        uint256 threshold = requiredSignaturesAtEpoch[_epoch];
        require(threshold != 0, "EMAV: unknown epoch");
        return ThresholdSigVerifierUtils.verifyWitnessSignatures(
            _digest,
            _sigs,
            epochWitnesses[_epoch],
            threshold
        );
    }

    function _validateConfiguration(address[] memory _witnesses, uint256 _threshold) internal pure {
        require(_witnesses.length == REQUIRED_WITNESS_COUNT, "EMAV: witness count must be three");
        require(_threshold == REQUIRED_SIGNATURES, "EMAV: threshold must be two");

        for (uint256 witnessIndex = 0; witnessIndex < _witnesses.length; witnessIndex++) {
            address witness = _witnesses[witnessIndex];
            require(witness != address(0), "EMAV: zero witness");
            for (uint256 priorIndex = 0; priorIndex < witnessIndex; priorIndex++) {
                require(_witnesses[priorIndex] != witness, "EMAV: duplicate witness");
            }
        }
    }

    function _storeWitnesses(address[] storage _destination, address[] memory _witnesses) internal {
        for (uint256 witnessIndex = 0; witnessIndex < _witnesses.length; witnessIndex++) {
            _destination.push(_witnesses[witnessIndex]);
        }
    }

    function _clearPendingConfiguration() internal {
        delete pendingWitnesses;
        delete pendingThreshold;
        delete pendingActivationTime;
    }

    function _configurationHash(address[] memory _witnesses, uint256 _threshold) internal pure returns (bytes32) {
        return keccak256(abi.encode(_witnesses, _threshold));
    }
}
