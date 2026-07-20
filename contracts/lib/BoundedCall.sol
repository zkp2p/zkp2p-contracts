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
    error RiskHookSettlementFailed(bytes32 intentHash, address hook, bytes revertData);

    /**
     * @notice Executes a fail-closed risk admission callback.
     */
    function executeRiskAdmission(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public {
        if (address(_riskHook) == address(0)) return;
        if (address(_riskHook).code.length == 0) {
            revert RiskHookAdmissionFailed(_intentHash, address(_riskHook), bytes(""));
        }

        (bool success, bytes memory revertData) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(IIntentRiskHook.onIntentCreated, (_intentHash))
        );
        if (!success) revert RiskHookAdmissionFailed(_intentHash, address(_riskHook), revertData);
    }

    /**
     * @notice Executes a fail-closed settlement callback with bounded return data.
     */
    function executeRiskSettlement(
        IIntentRiskHook _riskHook,
        IIntentRiskHook.RiskSettlementContext memory _context,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public {
        (bool success, bytes memory revertData) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(IIntentRiskHook.settleIntent, (_context))
        );
        if (!success) {
            revert RiskHookSettlementFailed(_context.intentHash, address(_riskHook), revertData);
        }
    }

    /**
     * @notice Executes the fail-open cancellation callback.
     * @return success Whether the callback completed successfully.
     */
    function executeRiskCancellation(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public returns (bool success) {
        if (address(_riskHook) == address(0)) return true;
        if (address(_riskHook).code.length == 0) {
            emit RiskHookCallbackFailed(
                _intentHash,
                address(_riskHook),
                IIntentRiskHook.onIntentCancelled.selector,
                bytes("")
            );
            return false;
        }

        bytes memory revertData;
        (success, revertData) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(IIntentRiskHook.onIntentCancelled, (_intentHash))
        );
        if (!success) {
            emit RiskHookCallbackFailed(
                _intentHash,
                address(_riskHook),
                IIntentRiskHook.onIntentCancelled.selector,
                revertData
            );
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
