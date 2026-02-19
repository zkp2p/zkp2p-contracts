// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IOrchestratorRegistry
 * @notice Interface for EscrowV2 orchestrator authorization registry.
 */
interface IOrchestratorRegistry {
    /**
     * @notice Adds an orchestrator to the allowlist.
     * @param _orchestrator Orchestrator address to add.
     */
    function addOrchestrator(address _orchestrator) external;

    /**
     * @notice Removes an orchestrator from the allowlist.
     * @param _orchestrator Orchestrator address to remove.
     */
    function removeOrchestrator(address _orchestrator) external;

    /**
     * @notice Returns whether an address is currently allowlisted as orchestrator.
     * @param _orchestrator Address to check.
     * @return allowed True when `_orchestrator` is authorized.
     */
    function isOrchestrator(address _orchestrator) external view returns (bool allowed);
}
