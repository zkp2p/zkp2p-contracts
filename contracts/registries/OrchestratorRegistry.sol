// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";

/**
 * @title OrchestratorRegistry
 * @notice Owner-managed allowlist of orchestrator contracts authorized to call EscrowV2.
 */
contract OrchestratorRegistry is Ownable, IOrchestratorRegistry {
    /* ============ Custom Errors ============ */

    error ZeroAddress();
    error OrchestratorAlreadyAdded(address orchestrator);
    error OrchestratorNotFound(address orchestrator);

    /* ============ State Variables ============ */

    mapping(address => bool) public override isOrchestrator;

    /* ============ Events ============ */

    event OrchestratorAdded(address indexed orchestrator);
    event OrchestratorRemoved(address indexed orchestrator);

    /* ============ External Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Adds an orchestrator to the allowlist.
     * @dev Reverts on zero address.
     * @param _orchestrator Orchestrator address to authorize.
     */
    function addOrchestrator(address _orchestrator) external override onlyOwner {
        if (_orchestrator == address(0)) revert ZeroAddress();
        if (isOrchestrator[_orchestrator]) revert OrchestratorAlreadyAdded(_orchestrator);

        isOrchestrator[_orchestrator] = true;
        emit OrchestratorAdded(_orchestrator);
    }

    /**
     * @notice GOVERNANCE ONLY: Removes an orchestrator from the allowlist.
     * @dev Reverts on zero address.
     * @param _orchestrator Orchestrator address to de-authorize.
     */
    function removeOrchestrator(address _orchestrator) external override onlyOwner {
        if (_orchestrator == address(0)) revert ZeroAddress();
        if (!isOrchestrator[_orchestrator]) revert OrchestratorNotFound(_orchestrator);

        delete isOrchestrator[_orchestrator];
        emit OrchestratorRemoved(_orchestrator);
    }
}
