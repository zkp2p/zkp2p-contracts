//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";

/**
 * @title ReentrantPostIntentHook
 * @notice Malicious hook contract that attempts reentrancy attack on fulfillIntent
 * @dev Used for testing reentrancy protection in Orchestrator contract
 */
contract ReentrantPostIntentHook is IPostIntentHook {

    /* ============ State Variables ============ */

    IOrchestrator public immutable orchestrator;
    IERC20 public immutable usdc;

    // Attack configuration
    bool public attemptReentry = true;
    uint256 public reentrancyAttempts = 0;

    // Stored params for reentrancy attempt
    IOrchestrator.FulfillIntentParams public storedFulfillParams;

    /* ============ Events ============ */

    event ReentrancyAttempted(bool success);
    event ExecutionCompleted(address recipient, uint256 amount);

    /* ============ Constructor ============ */

    constructor(address _usdc, address _orchestrator) {
        usdc = IERC20(_usdc);
        orchestrator = IOrchestrator(_orchestrator);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Stores fulfill params for reentrancy attack attempt
     */
    function setFulfillParams(
        bytes calldata paymentProof,
        bytes32 intentHash,
        bytes calldata verificationData,
        bytes calldata postIntentHookData
    ) external {
        storedFulfillParams = IOrchestrator.FulfillIntentParams({
            paymentProof: paymentProof,
            intentHash: intentHash,
            verificationData: verificationData,
            postIntentHookData: postIntentHookData
        });
    }

    /**
     * @notice Toggles whether to attempt reentrancy
     */
    function setAttemptReentry(bool _attempt) external {
        attemptReentry = _attempt;
    }

    /**
     * @notice Executes post-intent action and attempts reentrancy attack
     * @param _intent The intent data
     * @param _amountNetFees Amount of funds to transfer after fees are deducted
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata /* _fulfillIntentData */
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
        usdc.transferFrom(msg.sender, _intent.to, _amountNetFees);

        emit ExecutionCompleted(_intent.to, _amountNetFees);
    }

    /**
     * @notice Returns the number of reentrancy attempts made
     */
    function getReentrancyAttempts() external view returns (uint256) {
        return reentrancyAttempts;
    }
}
