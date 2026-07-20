//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";
/**
 * @title OrchestratorMock
 * @notice Mock orchestrator contract for testing escrow orchestrator-only functions
 */
contract OrchestratorMock {
    
    IEscrow public escrow;
    bytes32[] public lastPrunedIntents;
    uint256 public pruneCallCount;
    
    // Events for testing
    event IntentsPruned(bytes32 intent);
    
    constructor(address _escrow) {
        escrow = IEscrow(_escrow);
    }
    
    /**
     * @notice Implementation of pruneIntents required by IOrchestrator
     * @param _intents Array of intent hashes to prune
     */
    function pruneIntents(bytes32[] calldata _intents) external {
        delete lastPrunedIntents;
        for (uint256 i = 0; i < _intents.length; i++) {
            lastPrunedIntents.push(_intents[i]);
        }
        pruneCallCount += 1;
        if (_intents.length > 0) {
            emit IntentsPruned(_intents[0]);
        }
    }
    
    // Test helper functions to call orchestrator-only functions on escrow
    
    function lockFunds(
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _amount
    ) external {
        escrow.lockFunds(_depositId, _intentHash, _amount);
    }
    
    function unlockFunds(uint256 _depositId, bytes32 _intentHash) external {
        escrow.unlockFunds(_depositId, _intentHash);
    }
    
    function unlockAndTransferFunds(
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _transferAmount,
        address _to
    ) external {
        escrow.unlockAndTransferFunds(_depositId, _intentHash, _transferAmount, _to);
    }

    function extendIntentExpiry(
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _additionalTime
    ) external {
        escrow.extendIntentExpiry(_depositId, _intentHash, _additionalTime);
    }
    
    // Getter for testing
    function getLastPrunedIntents() external view returns (bytes32[] memory) {
        return lastPrunedIntents;
    }

    function getPruneCallCount() external view returns (uint256) {
        return pruneCallCount;
    }
}
