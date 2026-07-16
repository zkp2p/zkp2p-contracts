// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";

/**
 * @title BoundedCall
 * @notice Performs gas-limited calls while bounding copied return data.
 * @dev This follows the excessively-safe-call pattern: the callee cannot force the caller to
 *      copy unbounded return data and exhaust gas during memory expansion.
 */
library BoundedCall {
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );

    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error InvalidRiskHookResponse(address hook, bytes response);
    error RequiredSettlementHookMissing(bytes32 intentHash);

    /**
     * @notice Executes a fail-closed risk admission callback.
     * @return requiresSettlementHook Whether settlement must use the snapshotted settlement hook.
     */
    function executeRiskAdmission(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        address _settlementHook,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public returns (bool requiresSettlementHook) {
        if (address(_riskHook) == address(0)) return false;

        (bool success, bytes memory response) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(IIntentRiskHook.onIntentCreated, (_intentHash))
        );
        if (!success) revert RiskHookAdmissionFailed(_intentHash, address(_riskHook), response);
        if (response.length != 32) revert InvalidRiskHookResponse(address(_riskHook), response);

        requiresSettlementHook = abi.decode(response, (bool));
        if (requiresSettlementHook && _settlementHook == address(0)) {
            revert RequiredSettlementHookMissing(_intentHash);
        }
    }

    /**
     * @notice Executes a fail-open terminal risk callback.
     * @param _resolution Zero for cancellation, one for fulfillment, and two for manual release.
     * @return success Whether the callback completed successfully.
     */
    function executeTerminalRiskCallback(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        uint8 _resolution,
        uint256 _releasedAmount,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public returns (bool success) {
        if (address(_riskHook) == address(0)) return true;

        bytes4 callbackSelector;
        bytes memory callData;
        if (_resolution == 0) {
            callbackSelector = IIntentRiskHook.onIntentCancelled.selector;
            callData = abi.encodeCall(IIntentRiskHook.onIntentCancelled, (_intentHash));
        } else if (_resolution == 1) {
            callbackSelector = IIntentRiskHook.onIntentFulfilled.selector;
            callData = abi.encodeCall(IIntentRiskHook.onIntentFulfilled, (_intentHash, _releasedAmount));
        } else {
            callbackSelector = IIntentRiskHook.onIntentReleased.selector;
            callData = abi.encodeCall(IIntentRiskHook.onIntentReleased, (_intentHash, _releasedAmount));
        }

        bytes memory revertData;
        (success, revertData) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            callData
        );
        if (!success) {
            emit RiskHookCallbackFailed(_intentHash, address(_riskHook), callbackSelector, revertData);
        }
    }

    /**
     * @notice Calls a target with a fixed gas allowance and copies at most `_maxReturnDataSize` bytes.
     * @param _target Address receiving the call.
     * @param _gasLimit Maximum gas forwarded to the target.
     * @param _maxReturnDataSize Maximum number of return-data bytes copied into memory.
     * @param _callData Encoded calldata sent to the target.
     * @return success Whether the target call succeeded.
     * @return returnData Bounded return or revert data from the target.
     */
    function callWithBoundedReturnData(
        address _target,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize,
        bytes memory _callData
    ) internal returns (bool success, bytes memory returnData) {
        assembly ("memory-safe") {
            success := call(
                _gasLimit,
                _target,
                0,
                add(_callData, 0x20),
                mload(_callData),
                0,
                0
            )

            let copySize := returndatasize()
            if gt(copySize, _maxReturnDataSize) { copySize := _maxReturnDataSize }

            returnData := mload(0x40)
            mstore(returnData, copySize)
            returndatacopy(add(returnData, 0x20), 0, copySize)
            mstore(
                0x40,
                add(add(returnData, 0x20), and(add(copySize, 0x1f), not(0x1f)))
            )
        }
    }

}
