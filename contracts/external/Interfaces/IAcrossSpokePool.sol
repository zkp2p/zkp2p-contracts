// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IAcrossSpokePool
 * @notice Minimal interface for Across SpokePool used by AcrossBridgeHook.
 */
interface IAcrossSpokePool {
    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external payable;

    function getCurrentTime() external view returns (uint256);
    function depositQuoteTimeBuffer() external view returns (uint256);
    function fillDeadlineBuffer() external view returns (uint256);
}
