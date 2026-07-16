// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierV3 } from "../interfaces/IPaymentVerifierV3.sol";

/**
 * @title BoundedCall
 * @notice Performs gas-limited calls while bounding copied return data.
 * @dev This follows the excessively-safe-call pattern: the callee cannot force the caller to
 *      copy unbounded return data and exhaust gas during memory expansion.
 */
library BoundedCall {
    /// @dev Conservative allowance for CALL base/cold-access cost and local argument bookkeeping.
    uint256 internal constant CALL_OVERHEAD_GAS = 10_000;

    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );

    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error InvalidRiskHookResponse(address hook, bytes response);
    error RequiredSettlementHookMissing(bytes32 intentHash);
    error PaymentVerificationFailed();
    error HashMismatch(bytes32 expected, bytes32 actual);

    /**
     * @notice Calls the payment-ID-aware verifier without expanding the already size-constrained
     *         OrchestratorV3 runtime.
     * @dev Public library execution uses DELEGATECALL, so the verifier still observes the
     *      orchestrator as msg.sender.
     */
    function verifyPaymentV3(
        address _verifier,
        bytes32 _intentHash,
        bytes memory _paymentProof,
        bytes memory _verificationData
    ) public returns (uint256 releaseAmount, bytes32 paymentId) {
        IPaymentVerifierV3.PaymentVerificationResult memory result = IPaymentVerifierV3(_verifier).verifyPayment(
            IPaymentVerifier.VerifyPaymentData({
                intentHash: _intentHash,
                paymentProof: _paymentProof,
                data: _verificationData
            })
        );
        if (!result.success || result.paymentId == bytes32(0)) revert PaymentVerificationFailed();
        if (result.intentHash != _intentHash) revert HashMismatch(_intentHash, result.intentHash);
        return (result.releaseAmount, result.paymentId);
    }

    /**
     * @notice Executes a fail-closed risk admission callback.
     * @return requiresSettlementHook Whether settlement must use the snapshotted settlement hook.
     */
    function executeRiskAdmission(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        address _settlementHook,
        uint256 _gasLimit,
        uint256 _postCallGasReserve,
        uint256 _maxReturnDataSize
    ) public returns (bool requiresSettlementHook) {
        if (address(_riskHook) == address(0)) return false;

        (bool success, bytes memory response) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _postCallGasReserve,
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
        bytes32 _paymentId,
        uint256 _gasLimit,
        uint256 _postCallGasReserve,
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
            callData = abi.encodeCall(
                IIntentRiskHook.onIntentFulfilled,
                (_intentHash, _releasedAmount, _paymentId)
            );
        } else {
            callbackSelector = IIntentRiskHook.onIntentReleased.selector;
            callData = abi.encodeCall(IIntentRiskHook.onIntentReleased, (_intentHash, _releasedAmount));
        }

        bytes memory revertData;
        (success, revertData) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _postCallGasReserve,
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
     * @param _postCallGasReserve Gas retained for caller-side reconciliation after the call.
     * @param _maxReturnDataSize Maximum number of return-data bytes copied into memory.
     * @param _callData Encoded calldata sent to the target.
     * @return success Whether the target call succeeded.
     * @return returnData Bounded return or revert data from the target.
     */
    function callWithBoundedReturnData(
        address _target,
        uint256 _gasLimit,
        uint256 _postCallGasReserve,
        uint256 _maxReturnDataSize,
        bytes memory _callData
    ) internal returns (bool success, bytes memory returnData) {
        uint256 callGas = _calculateCallGas(gasleft(), _gasLimit, _postCallGasReserve);
        if (callGas == 0) return (false, bytes(""));

        assembly ("memory-safe") {
            success := call(
                callGas,
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

    /**
     * @dev Caps forwarded gas by the configured allowance, EIP-150's 63/64 rule, and the
     *      amount that leaves the requested reconciliation reserve after conservative CALL overhead.
     */
    function _calculateCallGas(
        uint256 _availableGas,
        uint256 _gasLimit,
        uint256 _postCallGasReserve
    ) internal pure returns (uint256 callGas) {
        if (_availableGas <= CALL_OVERHEAD_GAS + _postCallGasReserve) return 0;

        uint256 afterOverhead = _availableGas - CALL_OVERHEAD_GAS;
        uint256 eip150Maximum = afterOverhead - (afterOverhead / 64);
        uint256 reserveMaximum = afterOverhead - _postCallGasReserve;

        callGas = _gasLimit;
        if (callGas > eip150Maximum) callGas = eip150Maximum;
        if (callGas > reserveMaximum) callGas = reserveMaximum;
    }

}
