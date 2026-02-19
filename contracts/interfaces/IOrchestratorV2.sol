// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestrator } from "./IOrchestrator.sol";

/**
 * @title IOrchestratorV2
 * @notice Marker interface for the EscrowV2-aware orchestrator.
 * @dev Inherits current orchestrator surface and behavior while changing Escrow rate query routing.
 */
interface IOrchestratorV2 is IOrchestrator {}
