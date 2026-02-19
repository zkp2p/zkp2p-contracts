// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";

/**
 * @title RevertingPruneOrchestratorMock
 * @notice Mock orchestrator for exercising EscrowV2 prune-intent catch paths.
 */
contract RevertingPruneOrchestratorMock {
    IEscrow public immutable escrow;

    constructor(address _escrow) {
        escrow = IEscrow(_escrow);
    }

    function pruneIntents(bytes32[] calldata) external pure {
        revert("prune failed");
    }

    function lockFunds(
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _amount
    ) external {
        escrow.lockFunds(_depositId, _intentHash, _amount);
    }
}
