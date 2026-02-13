// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAcrossSpokePoolPeriphery } from "../external/Interfaces/IAcrossSpokePoolPeriphery.sol";

/**
 * @title AcrossSpokePoolPeripheryMock
 * @notice Minimal mock for Across SpokePoolPeriphery used in unit tests.
 */
contract AcrossSpokePoolPeripheryMock is IAcrossSpokePoolPeriphery {
    error TransferFailed();
    error MockSwapAndBridgeFailure();

    bool public shouldRevert;

    address public lastSwapToken;
    address public lastExchange;
    uint8 public lastTransferType;
    uint256 public lastSwapTokenAmount;
    uint256 public lastMinExpectedInputTokenAmount;
    bool public lastEnableProportionalAdjustment;
    address public lastSpokePool;
    uint256 public lastNonce;

    address public lastDepositInputToken;
    bytes32 public lastDepositOutputToken;
    uint256 public lastDepositOutputAmount;
    address public lastDepositDepositor;
    bytes32 public lastDepositRecipient;
    uint256 public lastDepositDestinationChainId;
    bytes32 public lastDepositExclusiveRelayer;
    uint32 public lastDepositQuoteTimestamp;
    uint32 public lastDepositFillDeadline;
    uint32 public lastDepositExclusivityParameter;

    bytes public lastRouterCalldata;
    bytes public lastDepositMessage;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function swapAndBridge(SwapAndDepositData calldata swapAndDepositData) external payable {
        if (shouldRevert) {
            revert MockSwapAndBridgeFailure();
        }

        lastSwapToken = swapAndDepositData.swapToken;
        lastExchange = swapAndDepositData.exchange;
        lastTransferType = uint8(swapAndDepositData.transferType);
        lastSwapTokenAmount = swapAndDepositData.swapTokenAmount;
        lastMinExpectedInputTokenAmount = swapAndDepositData.minExpectedInputTokenAmount;
        lastEnableProportionalAdjustment = swapAndDepositData.enableProportionalAdjustment;
        lastSpokePool = swapAndDepositData.spokePool;
        lastNonce = swapAndDepositData.nonce;

        lastDepositInputToken = swapAndDepositData.depositData.inputToken;
        lastDepositOutputToken = swapAndDepositData.depositData.outputToken;
        lastDepositOutputAmount = swapAndDepositData.depositData.outputAmount;
        lastDepositDepositor = swapAndDepositData.depositData.depositor;
        lastDepositRecipient = swapAndDepositData.depositData.recipient;
        lastDepositDestinationChainId = swapAndDepositData.depositData.destinationChainId;
        lastDepositExclusiveRelayer = swapAndDepositData.depositData.exclusiveRelayer;
        lastDepositQuoteTimestamp = swapAndDepositData.depositData.quoteTimestamp;
        lastDepositFillDeadline = swapAndDepositData.depositData.fillDeadline;
        lastDepositExclusivityParameter = swapAndDepositData.depositData.exclusivityParameter;

        lastRouterCalldata = swapAndDepositData.routerCalldata;
        lastDepositMessage = swapAndDepositData.depositData.message;

        if (!IERC20(swapAndDepositData.swapToken).transferFrom(msg.sender, address(this), swapAndDepositData.swapTokenAmount)) {
            revert TransferFailed();
        }
    }
}
