//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "contracts/interfaces/IEscrow.sol";

/**
 * @title OrchestratorMock
 * @notice Mock orchestrator contract for testing escrow orchestrator-only functions
 */
contract ReentrantOrchestratorMock {
    
    IEscrow public escrow;
    ReenterFunction public reenterFunction;

    // Events and state to make reentrancy attempts observable in tests
    event ReentryAttempted(uint8 indexed fn, bool success, string reason);

    uint256 public lockReentries;
    uint256 public unlockReentries;
    uint256 public unlockAndTransferReentries;
    
    enum ReenterFunction {
        None,
        LockFunds
    }
    
    
    constructor(address _escrow) {
        escrow = IEscrow(_escrow);
    }

    function setFunctionToReenter(ReenterFunction _reenterFunction) public {
        reenterFunction = _reenterFunction;
    }
    
    /**
     * @notice Implementation of pruneIntents required by IOrchestrator
     */
    function pruneIntents(bytes32[] calldata /*_intents*/) external {
        // Tries to reenter the configured function; capture revert so Escrow's try/catch
        // won't mask the signal we need in tests.
        if (reenterFunction == ReenterFunction.LockFunds) {
            try escrow.lockFunds(0, bytes32(0), 0) {
                emit ReentryAttempted(uint8(ReenterFunction.LockFunds), true, "");
                lockReentries++;
            } catch Error(string memory reason) {
                emit ReentryAttempted(uint8(ReenterFunction.LockFunds), false, reason);
                lockReentries++;
            } catch (bytes memory) {
                emit ReentryAttempted(uint8(ReenterFunction.LockFunds), false, "low-level");
                lockReentries++;
            }
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
}
