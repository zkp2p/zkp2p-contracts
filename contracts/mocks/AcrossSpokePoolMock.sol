// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AcrossSpokePoolMock
 * @notice Minimal mock for Across SpokePool used in unit tests.
 * @dev Implements depositNow with bytes32 address types for cross-chain compatibility.
 */
contract AcrossSpokePoolMock {
    error TransferFailed();
    error MockBridgeFailure();

    bytes32 public lastDepositor;
    bytes32 public lastRecipient;
    bytes32 public lastInputToken;
    bytes32 public lastOutputToken;
    uint256 public lastInputAmount;
    uint256 public lastOutputAmount;
    uint256 public lastDestinationChainId;
    uint32 public lastFillDeadlineOffset;

    bool public shouldRevert;

    /**
     * @notice Set whether depositNow should revert (for testing fallback behavior)
     * @param _shouldRevert True to make depositNow revert
     */
    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function depositNow(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32,  // exclusiveRelayer
        uint32 fillDeadlineOffset,
        uint32,   // exclusivityParameter
        bytes calldata  // message
    ) external payable {
        // Allow testing of bridge failure scenario
        if (shouldRevert) {
            revert MockBridgeFailure();
        }

        lastDepositor = depositor;
        lastRecipient = recipient;
        lastInputToken = inputToken;
        lastOutputToken = outputToken;
        lastInputAmount = inputAmount;
        lastOutputAmount = outputAmount;
        lastDestinationChainId = destinationChainId;
        lastFillDeadlineOffset = fillDeadlineOffset;

        // Convert bytes32 inputToken to address for ERC20 transfer
        address inputTokenAddr = address(uint160(uint256(inputToken)));
        if (!IERC20(inputTokenAddr).transferFrom(msg.sender, address(this), inputAmount)) {
            revert TransferFailed();
        }
    }
}
