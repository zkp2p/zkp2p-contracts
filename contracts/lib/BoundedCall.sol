// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";

/**
 * @title BoundedCall
 * @notice Executes gas-limited risk-hook callbacks while bounding copied return and revert data.
 * @dev This follows the excessively-safe-call pattern: the callee cannot force the caller to copy unbounded return data
 *      and exhaust gas during memory expansion. Admission and settlement are fail-closed and bubble bounded revert data
 *      through typed errors. Cancellation is fail-open for intent-liquidity liveness and emits bounded failure evidence
 *      so the orchestrator can persist a reconciliation record.
 */
library BoundedCall {
    /// @notice Emitted when a fail-open risk cancellation callback does not complete successfully.
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );

    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error RiskHookSettlementFailed(bytes32 intentHash, address hook, bytes revertData);
    error InsufficientGasForRiskCallback(uint256 availableGas, uint256 requiredGas);

    /**
     * @notice Executes a fail-closed risk admission callback with fixed gas and bounded revert data.
     * @dev A zero hook is an intentional no-op. A non-zero hook must contain deployed code and successfully execute
     *      `onIntentCreated`; otherwise the complete outer intent admission reverts with `RiskHookAdmissionFailed`.
     * @param _riskHook Snapshotted governance-selected hook, or zero when no risk policy applies.
     * @param _intentHash Newly created intent identifier readable from the calling orchestrator.
     * @param _gasLimit Exact gas allowance supplied to the callback call.
     * @param _maxReturnDataSize Maximum revert-data bytes copied from the hook.
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
     * @dev The caller must already validate that `_riskHook` is non-zero deployed code. Any callback failure reverts the
     *      outer settlement with the intent-bound `RiskHookSettlementFailed` error and bounded revert data.
     * @param _riskHook Snapshotted non-zero risk hook receiving settlement context.
     * @param _context Exact gross amount, executable amount, fee plan, token, recipient, and settlement type.
     * @param _gasLimit Exact gas allowance supplied to the callback call.
     * @param _maxReturnDataSize Maximum revert-data bytes copied from the hook.
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
     * @notice Executes a fail-open cancellation callback without allowing hook failure to trap intent liquidity.
     * @dev A zero hook succeeds without a call. A non-contract hook or reverted callback emits `RiskHookCallbackFailed`
     *      and returns false so OrchestratorV3 can store durable recovery state. Before calling, the function verifies
     *      EIP-150 permits the complete configured gas allowance to be forwarded; insufficient outer gas reverts rather
     *      than being misclassified as a hook failure.
     * @param _riskHook Snapshotted governance-selected hook, or zero when none applied.
     * @param _intentHash Cancelled intent identifier included in the callback and any failure event.
     * @param _gasLimit Exact gas allowance supplied to the callback call.
     * @param _maxReturnDataSize Maximum revert-data bytes copied from the hook.
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

        // EIP-150 retains one sixty-fourth of the caller's gas. Revert the outer cancellation
        // instead of recording a false callback failure when the transaction cannot forward the
        // configured allowance. The small fixed margin covers call setup before the assembly call.
        uint256 availableGas = gasleft();
        uint256 gasAfterMargin = availableGas > 5_000 ? availableGas - 5_000 : 0;
        uint256 forwardableGas = gasAfterMargin - (gasAfterMargin / 64);
        if (forwardableGas < _gasLimit) {
            revert InsufficientGasForRiskCallback(availableGas, _gasLimit);
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
     * @dev The helper does not validate target code or interpret returned bytes; callers own those policy decisions.
     *      Return data is allocated manually and rounded to the next 32-byte memory boundary.
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
