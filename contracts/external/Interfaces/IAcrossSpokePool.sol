// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAcrossSpokePool
 * @notice Minimal interface for Across SpokePool used by AcrossBridgeHook.
 * @dev Uses depositNow which supports bytes32 addresses for cross-chain compatibility (EVM and Solana).
 */
interface IAcrossSpokePool {
    /**
     * @notice Deposits tokens into the SpokePool for cross-chain transfer using current timestamp.
     * @dev Uses bytes32 for addresses to support both EVM (left-padded) and Solana addresses.
     * @param depositor The address (as bytes32) initiating the deposit
     * @param recipient The address (as bytes32) to receive tokens on the destination chain
     * @param inputToken The token address (as bytes32) being deposited on the source chain
     * @param outputToken The token address (as bytes32) to receive on the destination chain
     * @param inputAmount The amount of inputToken to deposit
     * @param outputAmount The amount of outputToken to receive on the destination chain
     * @param destinationChainId The chain ID of the destination chain
     * @param exclusiveRelayer The address (as bytes32) of an exclusive relayer, or bytes32(0) for open
     * @param fillDeadlineOffset Seconds from current time until the fill deadline expires
     * @param exclusivityParameter Seconds of exclusivity for the exclusive relayer
     * @param message Optional message to pass to the recipient contract
     */
    function depositNow(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32 exclusiveRelayer,
        uint32 fillDeadlineOffset,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;
}
