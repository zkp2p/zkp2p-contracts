// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";
import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { IIntentExtensionHook } from "../interfaces/IIntentExtensionHook.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";

/**
 * @title BoundedCall
 * @notice Executes V3 risk-hook routing with gas-limited, bounded-return-data calls.
 * @dev This follows the excessively-safe-call pattern: the callee cannot force the caller to
 *      copy unbounded return data and exhaust gas during memory expansion.
 */
library BoundedCall {
    event DepositRiskHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event IntentRiskHookSnapshotted(bytes32 indexed intentHash, address indexed riskHook, bool requiresPostIntentHook);
    event IntentExpiryExtended(
        bytes32 indexed intentHash,
        address indexed owner,
        address indexed riskHook,
        uint256 extensionSeconds,
        uint256 fee,
        uint256 previousExpiry,
        uint256 newExpiry
    );
    event RiskHookCallbackFailed(
        bytes32 indexed intentHash,
        address indexed riskHook,
        bytes4 indexed callbackSelector,
        bytes revertData
    );

    error RiskHookAdmissionFailed(bytes32 intentHash, address hook, bytes revertData);
    error RiskHookExtensionFailed(bytes32 intentHash, address hook, bytes revertData);
    error InvalidRiskHookResponse(address hook, bytes response);
    error RequiredPostIntentHookMissing(bytes32 intentHash);
    error ZeroAddress();
    error InvalidRiskHook(address hook);
    error UnauthorizedCallerOrDelegate(address caller, address depositor, address delegate);
    error IntentNotFound(bytes32 intentHash);
    error UnauthorizedCaller(address caller, address authorizedCaller);
    error InvalidIntentExtensionDuration(uint256 extensionSeconds);
    error IntentAlreadyExpired(bytes32 intentHash, uint256 expiry, uint256 currentTime);
    error IntentExtensionCapExceeded(bytes32 intentHash, uint256 requestedExpiry, uint256 maximumExpiry);
    error IntentExtensionRiskHookMissing(bytes32 intentHash);

    function setDepositRiskHook(
        mapping(address => mapping(uint256 => IIntentRiskHook)) storage _depositRiskHooks,
        address _escrow,
        uint256 _depositId,
        IIntentRiskHook _hook
    ) external {
        if (_escrow == address(0)) revert ZeroAddress();

        address hookAddress = address(_hook);
        if (hookAddress != address(0) && hookAddress.code.length == 0) {
            revert InvalidRiskHook(hookAddress);
        }

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }

        _depositRiskHooks[_escrow][_depositId] = _hook;
        emit DepositRiskHookSet(_escrow, _depositId, hookAddress, msg.sender);
    }

    function getRiskIntent(
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        bytes32 _intentHash
    ) external view returns (IOrchestratorV3.RiskIntentData memory riskIntent) {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        riskIntent = IOrchestratorV3.RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            postIntentHook: address(intent.postIntentHook),
            createdAt: uint64(intent.timestamp)
        });
    }

    function snapshotAndAdmit(
        mapping(address => mapping(uint256 => IIntentRiskHook)) storage _depositRiskHooks,
        mapping(bytes32 => IIntentRiskHook) storage _intentRiskHooks,
        mapping(bytes32 => bool) storage _intentRequiresPostIntentHook,
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        bytes32 _intentHash,
        uint256 _callbackGasLimit,
        uint256 _maxReturnDataSize
    ) external {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        IIntentRiskHook riskHook = _depositRiskHooks[intent.escrow][intent.depositId];
        _intentRiskHooks[_intentHash] = riskHook;

        bool requiresPostIntentHook = executeRiskAdmission(
            riskHook,
            _intentHash,
            address(intent.postIntentHook),
            _callbackGasLimit,
            _maxReturnDataSize
        );
        _intentRequiresPostIntentHook[_intentHash] = requiresPostIntentHook;
        emit IntentRiskHookSnapshotted(_intentHash, address(riskHook), requiresPostIntentHook);
    }

    function extendIntentExpiry(
        mapping(bytes32 => IOrchestratorV2.Intent) storage _intents,
        mapping(bytes32 => IIntentRiskHook) storage _intentRiskHooks,
        bytes32 _intentHash,
        uint256 _extensionSeconds,
        uint256 _maximumLifetime,
        uint256 _callbackGasLimit,
        uint256 _maxReturnDataSize
    ) external {
        IOrchestratorV2.Intent storage intent = _intents[_intentHash];
        if (intent.timestamp == 0) revert IntentNotFound(_intentHash);
        if (intent.owner != msg.sender) revert UnauthorizedCaller(msg.sender, intent.owner);
        if (_extensionSeconds == 0) revert InvalidIntentExtensionDuration(_extensionSeconds);

        IEscrowV2 escrow = IEscrowV2(intent.escrow);
        IEscrowV2.Intent memory escrowIntent = escrow.getDepositIntent(intent.depositId, _intentHash);
        if (escrowIntent.intentHash == bytes32(0)) revert IntentNotFound(_intentHash);
        if (escrowIntent.expiryTime <= block.timestamp) {
            revert IntentAlreadyExpired(_intentHash, escrowIntent.expiryTime, block.timestamp);
        }
        if (_extensionSeconds > type(uint256).max - escrowIntent.expiryTime) {
            revert InvalidIntentExtensionDuration(_extensionSeconds);
        }

        uint256 newExpiry = escrowIntent.expiryTime + _extensionSeconds;
        uint256 maximumExpiry = intent.timestamp + _maximumLifetime;
        if (newExpiry > maximumExpiry) {
            revert IntentExtensionCapExceeded(_intentHash, newExpiry, maximumExpiry);
        }

        IIntentRiskHook riskHook = _intentRiskHooks[_intentHash];
        if (address(riskHook) == address(0)) revert IntentExtensionRiskHookMissing(_intentHash);
        uint256 fee = executeRiskExtension(
            IIntentExtensionHook(address(riskHook)),
            _intentHash,
            _extensionSeconds,
            newExpiry,
            _callbackGasLimit,
            _maxReturnDataSize
        );

        escrow.extendIntentExpiry(intent.depositId, _intentHash, _extensionSeconds);
        emit IntentExpiryExtended(
            _intentHash,
            intent.owner,
            address(riskHook),
            _extensionSeconds,
            fee,
            escrowIntent.expiryTime,
            newExpiry
        );
    }

    /**
     * @notice Executes a fail-closed risk admission callback.
     * @return requiresPostIntentHook Whether settlement must use the snapshotted post-intent hook.
     */
    function executeRiskAdmission(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        address _postIntentHook,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) internal returns (bool requiresPostIntentHook) {
        if (address(_riskHook) == address(0)) return false;

        (bool success, bytes memory response) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(IIntentRiskHook.onIntentCreated, (_intentHash))
        );
        if (!success) revert RiskHookAdmissionFailed(_intentHash, address(_riskHook), response);
        if (response.length != 32) revert InvalidRiskHookResponse(address(_riskHook), response);

        requiresPostIntentHook = abi.decode(response, (bool));
        if (requiresPostIntentHook && _postIntentHook == address(0)) {
            revert RequiredPostIntentHookMissing(_intentHash);
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
     * @notice Executes a fail-closed paid-extension callback with bounded return data.
     */
    function executeRiskExtension(
        IIntentExtensionHook _riskHook,
        bytes32 _intentHash,
        uint256 _extensionSeconds,
        uint256 _newExpiry,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) internal returns (uint256 fee) {
        (bool success, bytes memory response) = callWithBoundedReturnData(
            address(_riskHook),
            _gasLimit,
            _maxReturnDataSize,
            abi.encodeCall(
                IIntentExtensionHook.onIntentExpiryExtension,
                (_intentHash, _extensionSeconds, _newExpiry)
            )
        );
        if (!success) revert RiskHookExtensionFailed(_intentHash, address(_riskHook), response);
        if (response.length != 32) revert InvalidRiskHookResponse(address(_riskHook), response);
        fee = abi.decode(response, (uint256));
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
