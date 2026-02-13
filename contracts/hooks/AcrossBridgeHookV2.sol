// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAcrossSpokePool } from "../external/Interfaces/IAcrossSpokePool.sol";
import { IAcrossSpokePoolPeriphery } from "../external/Interfaces/IAcrossSpokePoolPeriphery.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";

/**
 * @title AcrossBridgeHookV2
 * @notice Post-intent hook that executes Across routing with optional swap-and-bridge.
 * @dev Trust model:
 * - BRIDGE_ONLY mode follows the same behavior and risk profile as AcrossBridgeHook.
 * - SWAP_AND_BRIDGE mode adds an additional trust dependency on an allowlisted
 *   exchange and the configured Across spokePoolPeriphery.
 * - If swap-and-bridge execution reverts or fails pre-checks, funds will always
 *   fall back to a direct transfer of the net input amount back to intent.to.
 * - Worst-case outcome is same as V1 fallback: user receives base input token (USDC)
 *   on the source chain.
 */
contract AcrossBridgeHookV2 is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    enum RouteMode {
        BRIDGE_ONLY,
        SWAP_AND_BRIDGE
    }

    enum FallbackReason {
        OUTPUT_BELOW_MINIMUM,
        BRIDGE_CALL_FAILED,
        SWAP_AND_BRIDGE_CALL_FAILED
    }

    struct BridgeCommitment {
        uint256 destinationChainId;
        bytes32 outputToken;
        bytes32 recipient;
        uint256 minOutputAmount;
    }

    struct HookCommitment {
        RouteMode mode;
        bytes modeData;
    }

    struct AcrossFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
        uint32 fillDeadlineOffset;
        bytes32 exclusiveRelayer;
        uint32 exclusivityParameter;
    }

    struct SwapAndBridgeFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
        address bridgeInputToken;
        address exchange;
        uint8 transferType;
        uint256 minExpectedInputTokenAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        bytes32 exclusiveRelayer;
        uint32 exclusivityParameter;
        bytes routerCalldata;
        bool enableProportionalAdjustment;
        bytes message;
    }

    struct BridgeExecutionParams {
        uint256 amountNetFees;
        address recipient;
        BridgeCommitment commitment;
        AcrossFulfillData fulfillData;
        bool isViable;
    }

    struct SwapExecutionParams {
        uint256 amountNetFees;
        address recipient;
        BridgeCommitment commitment;
        SwapAndBridgeFulfillData fulfillData;
        bool isViable;
    }

    event AcrossBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    );

    event AcrossSwapAndBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 minExpectedInputTokenAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter,
        address exchange
    );

    event FallbackTransfer(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        FallbackReason reason
    );
    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidRouteMode(uint8 mode);
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(bytes32 recipient);
    error InvalidOutputToken(bytes32 outputToken);
    error InvalidBridgeInputToken(address bridgeInputToken);
    error ExchangeNotAllowed(address exchange);
    error InvalidTransferType(uint8 transferType);
    error InvalidMinExpectedInputTokenAmount();
    error NativeTransferFailed(address to, uint256 amount);

    IERC20 public immutable inputToken;
    address public immutable orchestrator;
    IAcrossSpokePool public immutable spokePool;
    IAcrossSpokePoolPeriphery public immutable spokePoolPeriphery;
    mapping(address => bool) public allowedExchanges;

    constructor(
        address _inputToken,
        address _orchestrator,
        address _spokePool,
        address _spokePoolPeriphery,
        address[] memory _allowedExchanges
    ) Ownable() {
        if (
            _inputToken == address(0) ||
            _orchestrator == address(0) ||
            _spokePool == address(0) ||
            _spokePoolPeriphery == address(0)
        ) {
            revert ZeroAddress();
        }

        inputToken = IERC20(_inputToken);
        orchestrator = _orchestrator;
        spokePool = IAcrossSpokePool(_spokePool);
        spokePoolPeriphery = IAcrossSpokePoolPeriphery(_spokePoolPeriphery);

        for (uint256 i = 0; i < _allowedExchanges.length; i++) {
            if (_allowedExchanges[i] == address(0)) {
                revert ZeroAddress();
            }
            allowedExchanges[_allowedExchanges[i]] = true;
        }
    }

    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external override {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender);

        (RouteMode mode, bytes memory modeData) = _decodeCommitment(_intent.data);
        if (mode == RouteMode.BRIDGE_ONLY) {
            _executeBridgeOnly(_intent, _amountNetFees, _fulfillIntentData, modeData);
            return;
        }
        if (mode == RouteMode.SWAP_AND_BRIDGE) {
            _executeSwapAndBridge(_intent, _amountNetFees, _fulfillIntentData, modeData);
            return;
        }

        revert InvalidRouteMode(uint8(mode));
    }

    function rescueERC20(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(0) || _to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(_to, _amount);
        emit RescueERC20(_token, _to, _amount);
    }

    function rescueNative(address payable _to, uint256 _amount) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        (bool success, ) = _to.call{ value: _amount }("");
        if (!success) revert NativeTransferFailed(_to, _amount);
        emit RescueNative(_to, _amount);
    }

    receive() external payable {}

    function _decodeCommitment(bytes memory _rawData) internal pure returns (RouteMode, bytes memory) {
        HookCommitment memory commitmentEnvelope = abi.decode(_rawData, (HookCommitment));
        uint8 mode = uint8(commitmentEnvelope.mode);
        if (mode > uint8(RouteMode.SWAP_AND_BRIDGE)) {
            revert InvalidRouteMode(mode);
        }
        return (commitmentEnvelope.mode, commitmentEnvelope.modeData);
    }

    function _executeBridgeOnly(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData,
        bytes memory _bridgeCommitmentData
    ) internal {
        BridgeExecutionParams memory execution = _buildBridgeExecutionParams(
            _intent,
            _amountNetFees,
            _bridgeCommitmentData,
            _fulfillIntentData
        );

        inputToken.safeTransferFrom(orchestrator, address(this), execution.amountNetFees);

        if (execution.isViable && _attemptBridgeDeposit(execution)) {
            return;
        }

        _fallbackBridgeTransfer(
            execution,
            execution.isViable
                ? FallbackReason.BRIDGE_CALL_FAILED
                : FallbackReason.OUTPUT_BELOW_MINIMUM
        );
    }

    function _attemptBridgeDeposit(BridgeExecutionParams memory _execution) internal returns (bool) {
        inputToken.safeApprove(address(spokePool), 0);
        inputToken.safeApprove(address(spokePool), _execution.amountNetFees);

        try spokePool.depositNow(
            _toBytes32(address(this)),
            _execution.commitment.recipient,
            _toBytes32(address(inputToken)),
            _execution.commitment.outputToken,
            _execution.amountNetFees,
            _execution.fulfillData.outputAmount,
            _execution.commitment.destinationChainId,
            _execution.fulfillData.exclusiveRelayer,
            _execution.fulfillData.fillDeadlineOffset,
            _execution.fulfillData.exclusivityParameter,
            ""
        ) {
            inputToken.safeApprove(address(spokePool), 0);
            _emitAcrossBridgeInitiated(_execution);
            return true;
        } catch {
            inputToken.safeApprove(address(spokePool), 0);
            return false;
        }
    }

    function _emitAcrossBridgeInitiated(BridgeExecutionParams memory _execution) internal {
        emit AcrossBridgeInitiated(
            _execution.fulfillData.intentHash,
            _execution.commitment.destinationChainId,
            _execution.commitment.outputToken,
            _execution.commitment.recipient,
            _execution.amountNetFees,
            _execution.fulfillData.outputAmount,
            _execution.fulfillData.fillDeadlineOffset,
            _execution.fulfillData.exclusiveRelayer,
            _execution.fulfillData.exclusivityParameter
        );
    }

    function _executeSwapAndBridge(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData,
        bytes memory _swapCommitmentData
    ) internal {
        SwapExecutionParams memory execution = _buildSwapExecutionParams(
            _intent,
            _amountNetFees,
            _swapCommitmentData,
            _fulfillIntentData
        );
        _validateSwapData(execution.fulfillData);

        inputToken.safeTransferFrom(orchestrator, address(this), execution.amountNetFees);

        if (execution.isViable && _attemptSwapAndBridge(execution)) {
            return;
        }

        _fallbackSwapTransfer(
            execution,
            execution.isViable
                ? FallbackReason.SWAP_AND_BRIDGE_CALL_FAILED
                : FallbackReason.OUTPUT_BELOW_MINIMUM
        );
    }

    function _attemptSwapAndBridge(SwapExecutionParams memory _execution) internal returns (bool) {
        IAcrossSpokePoolPeriphery.SwapAndDepositData memory swapAndDepositData;
        _setSwapAndDepositData(
            _execution,
            address(inputToken),
            address(spokePool),
            swapAndDepositData
        );

        inputToken.safeApprove(address(spokePoolPeriphery), 0);
        inputToken.safeApprove(address(spokePoolPeriphery), _execution.amountNetFees);

        try spokePoolPeriphery.swapAndBridge(swapAndDepositData) {
            inputToken.safeApprove(address(spokePoolPeriphery), 0);
            _emitAcrossSwapAndBridgeInitiated(_execution);
            return true;
        } catch {
            inputToken.safeApprove(address(spokePoolPeriphery), 0);
            return false;
        }
    }

    function _emitAcrossSwapAndBridgeInitiated(
        SwapExecutionParams memory _execution
    ) internal {
        emit AcrossSwapAndBridgeInitiated(
            _execution.fulfillData.intentHash,
            _execution.commitment.destinationChainId,
            _execution.commitment.outputToken,
            _execution.commitment.recipient,
            _execution.amountNetFees,
            _execution.fulfillData.outputAmount,
            _execution.fulfillData.minExpectedInputTokenAmount,
            _execution.fulfillData.quoteTimestamp,
            _execution.fulfillData.fillDeadline,
            _execution.fulfillData.exclusiveRelayer,
            _execution.fulfillData.exclusivityParameter,
            _execution.fulfillData.exchange
        );
    }

    function _fallbackBridgeTransfer(
        BridgeExecutionParams memory _execution,
        FallbackReason _reason
    ) internal {
        inputToken.safeTransfer(_execution.recipient, _execution.amountNetFees);
        emit FallbackTransfer(
            _execution.fulfillData.intentHash,
            _execution.recipient,
            _execution.amountNetFees,
            _reason
        );
    }

    function _fallbackSwapTransfer(
        SwapExecutionParams memory _execution,
        FallbackReason _reason
    ) internal {
        inputToken.safeTransfer(_execution.recipient, _execution.amountNetFees);
        emit FallbackTransfer(
            _execution.fulfillData.intentHash,
            _execution.recipient,
            _execution.amountNetFees,
            _reason
        );
    }

    function _buildBridgeExecutionParams(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes memory _bridgeCommitmentData,
        bytes calldata _fulfillIntentData
    ) internal pure returns (BridgeExecutionParams memory execution) {
        execution.recipient = _intent.to;
        execution.amountNetFees = _amountNetFees;
        execution.commitment = abi.decode(_bridgeCommitmentData, (BridgeCommitment));
        execution.fulfillData = abi.decode(_fulfillIntentData, (AcrossFulfillData));
        _validateCommonCommitment(
            execution.commitment.destinationChainId,
            execution.commitment.outputToken,
            execution.commitment.recipient
        );
        execution.isViable = _isBridgeViable(
            execution.fulfillData.outputAmount,
            execution.commitment.minOutputAmount
        );
    }

    function _buildSwapExecutionParams(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes memory _swapCommitmentData,
        bytes calldata _fulfillIntentData
    ) internal pure returns (SwapExecutionParams memory execution) {
        execution.recipient = _intent.to;
        execution.amountNetFees = _amountNetFees;
        execution.commitment = abi.decode(_swapCommitmentData, (BridgeCommitment));
        execution.fulfillData = abi.decode(_fulfillIntentData, (SwapAndBridgeFulfillData));
        _validateCommonCommitment(
            execution.commitment.destinationChainId,
            execution.commitment.outputToken,
            execution.commitment.recipient
        );
        execution.isViable = _isBridgeViable(
            execution.fulfillData.outputAmount,
            execution.commitment.minOutputAmount
        );
    }

    function _validateSwapData(SwapAndBridgeFulfillData memory _fulfillData) internal view {
        if (_fulfillData.bridgeInputToken == address(0)) {
            revert InvalidBridgeInputToken(_fulfillData.bridgeInputToken);
        }
        if (!allowedExchanges[_fulfillData.exchange]) {
            revert ExchangeNotAllowed(_fulfillData.exchange);
        }
        if (_fulfillData.transferType > uint8(IAcrossSpokePoolPeriphery.TransferType.Permit2Approval)) {
            revert InvalidTransferType(_fulfillData.transferType);
        }
        if (_fulfillData.minExpectedInputTokenAmount == 0) {
            revert InvalidMinExpectedInputTokenAmount();
        }
    }

    function _setSwapAndDepositData(
        SwapExecutionParams memory _execution,
        address _swapToken,
        address _spokePool,
        IAcrossSpokePoolPeriphery.SwapAndDepositData memory _swapData
    ) internal view {
        _swapData.submissionFees = IAcrossSpokePoolPeriphery.Fees({ amount: 0, recipient: address(0) });
        _swapData.depositData = IAcrossSpokePoolPeriphery.BaseDepositData({
            inputToken: _execution.fulfillData.bridgeInputToken,
            outputToken: _execution.commitment.outputToken,
            outputAmount: _execution.fulfillData.outputAmount,
            depositor: address(this),
            recipient: _execution.commitment.recipient,
            destinationChainId: _execution.commitment.destinationChainId,
            exclusiveRelayer: _execution.fulfillData.exclusiveRelayer,
            quoteTimestamp: _execution.fulfillData.quoteTimestamp,
            fillDeadline: _execution.fulfillData.fillDeadline,
            exclusivityParameter: _execution.fulfillData.exclusivityParameter,
            message: _execution.fulfillData.message
        });
        _swapData.swapToken = _swapToken;
        _swapData.exchange = _execution.fulfillData.exchange;
        _swapData.transferType = IAcrossSpokePoolPeriphery.TransferType(_execution.fulfillData.transferType);
        _swapData.swapTokenAmount = _execution.amountNetFees;
        _swapData.minExpectedInputTokenAmount = _execution.fulfillData.minExpectedInputTokenAmount;
        _swapData.routerCalldata = _execution.fulfillData.routerCalldata;
        _swapData.enableProportionalAdjustment = _execution.fulfillData.enableProportionalAdjustment;
        _swapData.spokePool = _spokePool;
        _swapData.nonce = 0;
    }

    function _validateCommonCommitment(
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient
    ) internal pure {
        if (destinationChainId == 0) {
            revert InvalidDestinationChainId(destinationChainId);
        }
        if (recipient == bytes32(0)) {
            revert InvalidRecipient(recipient);
        }
        if (outputToken == bytes32(0)) {
            revert InvalidOutputToken(outputToken);
        }
    }

    function _isBridgeViable(uint256 outputAmount, uint256 minOutputAmount) internal pure returns (bool) {
        return outputAmount >= minOutputAmount;
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
