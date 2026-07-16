//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISettlementHook } from "../interfaces/ISettlementHook.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";

/**
 * @title ReentrantSettlementHook
 * @notice Malicious V2 hook contract that attempts reentrancy attack on fulfillIntent
 * @dev Used for testing reentrancy protection in OrchestratorV2 contract
 */
contract ReentrantSettlementHook is ISettlementHook {

    /* ============ State Variables ============ */

    IOrchestratorV2 public immutable orchestrator;
    IERC20 public immutable usdc;

    // Attack configuration
    bool public attemptReentry = true;
    uint256 public reentrancyAttempts = 0;

    // Stored params for reentrancy attempt
    IOrchestratorV2.FulfillIntentParams public storedFulfillParams;

    /* ============ Events ============ */

    event ReentrancyAttempted(bool success);
    event ExecutionCompleted(address recipient, uint256 amount);

    /* ============ Constructor ============ */

    constructor(address _usdc, address _orchestrator) {
        usdc = IERC20(_usdc);
        orchestrator = IOrchestratorV2(_orchestrator);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Stores fulfill params for reentrancy attack attempt
     */
    function setFulfillParams(
        bytes calldata paymentProof,
        bytes32 intentHash,
        bytes calldata verificationData,
        bytes calldata settlementHookData
    ) external {
        storedFulfillParams = IOrchestratorV2.FulfillIntentParams({
            paymentProof: paymentProof,
            intentHash: intentHash,
            verificationData: verificationData,
            settlementHookData: settlementHookData
        });
    }

    /**
     * @notice Toggles whether to attempt reentrancy
     */
    function setAttemptReentry(bool _attempt) external {
        attemptReentry = _attempt;
    }

    /**
     * @notice Executes settlement action and attempts reentrancy attack
     * @param _ctx Hook execution context
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata /* _fulfillHookData */
    ) external override {
        // Increment attempt counter
        reentrancyAttempts++;

        // Attempt reentrancy attack if enabled
        if (attemptReentry && reentrancyAttempts == 1) {
            // Only attempt once to avoid infinite loop
            attemptReentry = false;

            // Try to call fulfillIntent again (should fail with ReentrancyGuard)
            try orchestrator.fulfillIntent(storedFulfillParams) {
                // This should never execute due to reentrancy guard
                emit ReentrancyAttempted(true);
            } catch {
                // Expected behavior - reentrancy guard blocks the call
                emit ReentrancyAttempted(false);
            }
        }

        // Normal execution - transfer funds to intended recipient
        // Pull USDC from orchestrator (which approved this amount)
        usdc.transferFrom(msg.sender, _ctx.intent.to, _ctx.executableAmount);

        emit ExecutionCompleted(_ctx.intent.to, _ctx.executableAmount);
    }

    /**
     * @notice Returns the number of reentrancy attempts made
     */
    function getReentrancyAttempts() external view returns (uint256) {
        return reentrancyAttempts;
    }
}
