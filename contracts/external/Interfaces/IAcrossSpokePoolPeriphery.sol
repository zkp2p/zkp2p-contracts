// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAcrossSpokePoolPeriphery
 * @notice Minimal Across SpokePoolPeriphery interface used by AcrossBridgeHook.
 */
interface IAcrossSpokePoolPeriphery {
    enum TransferType {
        Approval,
        Transfer,
        Permit2Approval
    }

    struct Fees {
        uint256 amount;
        address recipient;
    }

    struct BaseDepositData {
        address inputToken;
        bytes32 outputToken;
        uint256 outputAmount;
        address depositor;
        bytes32 recipient;
        uint256 destinationChainId;
        bytes32 exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    struct SwapAndDepositData {
        Fees submissionFees;
        BaseDepositData depositData;
        address swapToken;
        address exchange;
        TransferType transferType;
        uint256 swapTokenAmount;
        uint256 minExpectedInputTokenAmount;
        bytes routerCalldata;
        bool enableProportionalAdjustment;
        address spokePool;
        uint256 nonce;
    }

    function swapAndBridge(SwapAndDepositData calldata swapAndDepositData) external payable;
}
