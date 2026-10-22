// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IOrchestratorV4 } from "./IOrchestratorV4.sol";

/// @notice Minimal signal boundary used by OrchestratorV4.
/// @dev Governance replaces the policy to change signal rules without deploying another orchestrator.
interface IIntentSignalPolicy {
    /// @notice Validates a signal; reverts to reject it before any funds are locked.
    /// @dev UPV4 trusts the payer commitment O4 stores, so a policy must reject one it cannot vouch for.
    function validateSignalIntent(address taker, IOrchestratorV4.SignalIntentParams calldata params) external;
}
