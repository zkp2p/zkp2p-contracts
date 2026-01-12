// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title ITokenMessengerV2
 * @notice Minimal interface for CCTP v2 TokenMessenger used by CctpBridgeHook.
 * @dev Source: https://developers.circle.com/cctp/evm-smart-contracts
 */
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
