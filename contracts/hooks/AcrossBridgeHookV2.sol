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
 * @notice Unified Across post-intent hook that supports explicit route modes:
 *         1) bridge-only flow via SpokePool.depositNow, and
 *         2) origin swap + bridge flow via SpokePoolPeriphery.swapAndBridge.
 * @dev All commitments MUST be encoded as HookCommitment(mode, modeData).
 */
contract AcrossBridgeHookV2 is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    enum RouteMode {
        BRIDGE_ONLY,       // 0
        SWAP_AND_BRIDGE    // 1
    }

    enum FallbackReason {
        OUTPUT_BELOW_MINIMUM,       // 0
        BRIDGE_CALL_FAILED,         // 1
        SWAP_AND_BRIDGE_CALL_FAILED // 2
    }

    /**
     * @notice Bridge commitment payload for RouteMode.BRIDGE_ONLY.
     */
    struct BridgeCommitment {
        uint256 destinationChainId;
        bytes32 outputToken;
        bytes32 recipient;
        uint256 minOutputAmount;
    }

    /**
     * @notice Envelope format for V2 route commitments.
     */
    struct HookCommitment {
        RouteMode mode;
        bytes modeData;
    }

    /**
     * @notice Swap+bridge commitment payload for RouteMode.SWAP_AND_BRIDGE.
     */
    // NOTE: intentionally uses BridgeCommitment for modeData to keep commitment fields
    // identical across BRIDGE_ONLY and SWAP_AND_BRIDGE modes.

    /**
     * @notice Bridge-only fulfill data format.
     */
    struct AcrossFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
        uint32 fillDeadlineOffset;
        bytes32 exclusiveRelayer;
        uint32 exclusivityParameter;
    }

    /**
     * @notice Swap+bridge fulfill data for RouteMode.SWAP_AND_BRIDGE.
     */
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

    event ExchangeAllowedUpdated(address indexed exchange, bool allowed);
    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(bytes32 recipient);
    error InvalidOutputToken(bytes32 outputToken);
    error InvalidRouteMode(uint8 mode);
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
        address _spokePoolPeriphery
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
    }

    function setExchangeAllowed(address _exchange, bool _allowed) external onlyOwner {
        if (_exchange == address(0)) revert ZeroAddress();
        allowedExchanges[_exchange] = _allowed;
        emit ExchangeAllowedUpdated(_exchange, _allowed);
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

    function _executeBridgeOnly(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData,
        bytes memory _bridgeCommitmentData
    ) internal {
        BridgeCommitment memory commitment = abi.decode(_bridgeCommitmentData, (BridgeCommitment));
        AcrossFulfillData memory fulfillData = abi.decode(_fulfillIntentData, (AcrossFulfillData));

        _validateCommonCommitment(
            commitment.destinationChainId,
            commitment.outputToken,
            commitment.recipient
        );

        inputToken.safeTransferFrom(orchestrator, address(this), _amountNetFees);

        bool bridgeViable = fulfillData.outputAmount >= commitment.minOutputAmount;
        if (bridgeViable) {
            inputToken.safeApprove(address(spokePool), 0);
            inputToken.safeApprove(address(spokePool), _amountNetFees);

            try spokePool.depositNow(
                _toBytes32(address(this)),
                commitment.recipient,
                _toBytes32(address(inputToken)),
                commitment.outputToken,
                _amountNetFees,
                fulfillData.outputAmount,
                commitment.destinationChainId,
                fulfillData.exclusiveRelayer,
                fulfillData.fillDeadlineOffset,
                fulfillData.exclusivityParameter,
                ""
            ) {
                inputToken.safeApprove(address(spokePool), 0);
                emit AcrossBridgeInitiated(
                    fulfillData.intentHash,
                    commitment.destinationChainId,
                    commitment.outputToken,
                    commitment.recipient,
                    _amountNetFees,
                    fulfillData.outputAmount,
                    fulfillData.fillDeadlineOffset,
                    fulfillData.exclusiveRelayer,
                    fulfillData.exclusivityParameter
                );
                return;
            } catch {
                inputToken.safeApprove(address(spokePool), 0);
            }
        }

        inputToken.safeTransfer(_intent.to, _amountNetFees);
        emit FallbackTransfer(
            fulfillData.intentHash,
            _intent.to,
            _amountNetFees,
            bridgeViable ? FallbackReason.BRIDGE_CALL_FAILED : FallbackReason.OUTPUT_BELOW_MINIMUM
        );
    }

    function _executeSwapAndBridge(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData,
        bytes memory _swapCommitmentData
    ) internal {
        BridgeCommitment memory commitment = abi.decode(_swapCommitmentData, (BridgeCommitment));
        SwapAndBridgeFulfillData memory fulfillData = abi.decode(_fulfillIntentData, (SwapAndBridgeFulfillData));

        _validateCommonCommitment(
            commitment.destinationChainId,
            commitment.outputToken,
            commitment.recipient
        );

        if (fulfillData.bridgeInputToken == address(0)) {
            revert InvalidBridgeInputToken(fulfillData.bridgeInputToken);
        }
        if (!allowedExchanges[fulfillData.exchange]) {
            revert ExchangeNotAllowed(fulfillData.exchange);
        }
        if (fulfillData.transferType > uint8(IAcrossSpokePoolPeriphery.TransferType.Permit2Approval)) {
            revert InvalidTransferType(fulfillData.transferType);
        }
        if (fulfillData.minExpectedInputTokenAmount == 0) {
            revert InvalidMinExpectedInputTokenAmount();
        }

        inputToken.safeTransferFrom(orchestrator, address(this), _amountNetFees);

        bool bridgeViable = fulfillData.outputAmount >= commitment.minOutputAmount;
        if (bridgeViable) {
            inputToken.safeApprove(address(spokePoolPeriphery), 0);
            inputToken.safeApprove(address(spokePoolPeriphery), _amountNetFees);

            IAcrossSpokePoolPeriphery.SwapAndDepositData memory swapAndDepositData = IAcrossSpokePoolPeriphery
                .SwapAndDepositData({
                    submissionFees: IAcrossSpokePoolPeriphery.Fees({ amount: 0, recipient: address(0) }),
                    depositData: IAcrossSpokePoolPeriphery.BaseDepositData({
                        inputToken: fulfillData.bridgeInputToken,
                        outputToken: commitment.outputToken,
                        outputAmount: fulfillData.outputAmount,
                        depositor: address(this),
                        recipient: commitment.recipient,
                        destinationChainId: commitment.destinationChainId,
                        exclusiveRelayer: fulfillData.exclusiveRelayer,
                        quoteTimestamp: fulfillData.quoteTimestamp,
                        fillDeadline: fulfillData.fillDeadline,
                        exclusivityParameter: fulfillData.exclusivityParameter,
                        message: fulfillData.message
                    }),
                    swapToken: address(inputToken),
                    exchange: fulfillData.exchange,
                    transferType: IAcrossSpokePoolPeriphery.TransferType(fulfillData.transferType),
                    swapTokenAmount: _amountNetFees,
                    minExpectedInputTokenAmount: fulfillData.minExpectedInputTokenAmount,
                    routerCalldata: fulfillData.routerCalldata,
                    enableProportionalAdjustment: fulfillData.enableProportionalAdjustment,
                    spokePool: address(spokePool),
                    nonce: 0
                });

            try spokePoolPeriphery.swapAndBridge(swapAndDepositData) {
                inputToken.safeApprove(address(spokePoolPeriphery), 0);
                emit AcrossSwapAndBridgeInitiated(
                    fulfillData.intentHash,
                    commitment.destinationChainId,
                    commitment.outputToken,
                    commitment.recipient,
                    _amountNetFees,
                    fulfillData.outputAmount,
                    fulfillData.minExpectedInputTokenAmount,
                    fulfillData.quoteTimestamp,
                    fulfillData.fillDeadline,
                    fulfillData.exclusiveRelayer,
                    fulfillData.exclusivityParameter,
                    fulfillData.exchange
                );
                return;
            } catch {
                inputToken.safeApprove(address(spokePoolPeriphery), 0);
            }
        }

        inputToken.safeTransfer(_intent.to, _amountNetFees);
        emit FallbackTransfer(
            fulfillData.intentHash,
            _intent.to,
            _amountNetFees,
            bridgeViable ? FallbackReason.SWAP_AND_BRIDGE_CALL_FAILED : FallbackReason.OUTPUT_BELOW_MINIMUM
        );
    }

    function _validateCommonCommitment(
        uint256 _destinationChainId,
        bytes32 _outputToken,
        bytes32 _recipient
    ) internal pure {
        if (_destinationChainId == 0) {
            revert InvalidDestinationChainId(_destinationChainId);
        }
        if (_recipient == bytes32(0)) {
            revert InvalidRecipient(_recipient);
        }
        if (_outputToken == bytes32(0)) {
            revert InvalidOutputToken(_outputToken);
        }
    }

    function _decodeCommitment(bytes memory _rawData) internal pure returns (RouteMode, bytes memory) {
        HookCommitment memory commitmentEnvelope = abi.decode(_rawData, (HookCommitment));
        uint8 mode = uint8(commitmentEnvelope.mode);
        if (mode > uint8(RouteMode.SWAP_AND_BRIDGE)) {
            revert InvalidRouteMode(mode);
        }
        return (commitmentEnvelope.mode, commitmentEnvelope.modeData);
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
