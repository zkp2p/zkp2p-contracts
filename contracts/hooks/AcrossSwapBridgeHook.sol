// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAcrossSpokePoolPeriphery } from "../external/Interfaces/IAcrossSpokePoolPeriphery.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";

/**
 * @title AcrossSwapBridgeHook
 * @notice Post-intent hook that executes Across swap-and-bridge flow using committed destination and route params.
 * @dev This follows the legacy permission model: only `Orchestrator` may call execute, while fulfill intent
 * calldata is permissionless upstream and therefore not tied to a trusted fulfiller identity.
 *
 * Practical effect: route execution fields and both minimum guards are committed in `signalIntent`; a permissionless
 * fulfiller can only influence runtime `outputAmount` at fulfill time. Any non-viable path falls back to local transfer.
 */
contract AcrossSwapBridgeHook is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    enum FallbackReason {
        OUTPUT_BELOW_MINIMUM,
        BRIDGE_CALL_FAILED
    }

    /**
     * @notice Commitment stored at signalIntent for deterministic execution.
     * @dev All route selection and slippage limits are pre-committed from API quote at signal time.
     * @param destinationChainId Destination chain ID for destination transfer.
     * @param outputToken Destination output token (bytes32 for cross-chain compatibility).
     * @param recipient Destination recipient (bytes32 for cross-chain compatibility).
     * @param minOutputAmount Minimum destination output amount user allows at fulfill time.
     * @param exchange Swap venue used by Across quote response.
     * @param transferType SpokePoolPeriphery transfer type for swap token movement.
     * @param minExpectedInputTokenAmount Minimum source input token amount required by Across route quote.
     * @param quoteTimestamp Quote timestamp from Across suggested route.
     * @param fillDeadline Fill deadline from Across route.
     * @param exclusiveRelayer Exclusive relayer (optional) from Across route.
     * @param exclusivityParameter Exclusivity window for route.
     * @param routerCalldata Encoded swap route calldata from Across.
     * @param enableProportionalAdjustment Optional route-level adjustment flag.
     * @param message Optional route metadata message.
     */
    struct AcrossSwapBridgeCommitment {
        uint256 destinationChainId;
        bytes32 outputToken;
        bytes32 recipient;
        uint256 minOutputAmount;
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

    /**
     * @notice Fulfillment data provided at fulfill time.
     * @dev `outputAmount` is expected to come from the API-provided route output and is intentionally
     *      the only route-dependent value accepted from fulfiller calldata.
     */
    struct AcrossSwapBridgeFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
    }

    event AcrossSwapBridgeInitiated(
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
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(bytes32 recipient);
    error InvalidOutputToken(bytes32 outputToken);
    error InvalidExchange(address exchange);
    error InvalidTransferType(uint8 transferType);
    error InvalidMinExpectedInputTokenAmount();
    error InvalidMinOutputAmount(uint256 minOutputAmount);
    error NativeTransferFailed(address to, uint256 amount);

    IERC20 public immutable inputToken;
    address public immutable orchestrator;
    IAcrossSpokePoolPeriphery public immutable spokePoolPeriphery;
    address public immutable spokePool;

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
        spokePool = _spokePool;
        spokePoolPeriphery = IAcrossSpokePoolPeriphery(_spokePoolPeriphery);
    }

    /**
     * @notice Execute swap-and-bridge for a fulfilled intent.
     * @param _intent The fulfilled intent and committed swap-and-bridge fields.
     * @param _amountNetFees Amount unlocked by Orchestrator after protocol/referrer fees.
     * @param _fulfillIntentData ABI-encoded `AcrossSwapBridgeFulfillData`.
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external override {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender);

        AcrossSwapBridgeCommitment memory commitment = abi.decode(_intent.data, (AcrossSwapBridgeCommitment));
        AcrossSwapBridgeFulfillData memory fulfillData = abi.decode(
            _fulfillIntentData,
            (AcrossSwapBridgeFulfillData)
        );
        // Fulfill-time control is intentionally limited to `outputAmount` only:
        // all route selection and slippage bounds are pre-committed via `_intent.data`.

        _validateNonPriceCommitment(commitment);

        inputToken.safeTransferFrom(orchestrator, address(this), _amountNetFees);

        bool bridgeViable = _isBridgeViable(fulfillData.outputAmount, commitment.minOutputAmount);
        if (bridgeViable) {
            inputToken.safeApprove(address(spokePoolPeriphery), 0);
            inputToken.safeApprove(address(spokePoolPeriphery), _amountNetFees);

            try spokePoolPeriphery.swapAndBridge(_buildSwapAndDepositData(commitment, fulfillData, _amountNetFees)) {
                inputToken.safeApprove(address(spokePoolPeriphery), 0);
                emit AcrossSwapBridgeInitiated(
                    fulfillData.intentHash,
                    commitment.destinationChainId,
                    commitment.outputToken,
                    commitment.recipient,
                    _amountNetFees,
                    fulfillData.outputAmount,
                    commitment.minExpectedInputTokenAmount,
                    commitment.quoteTimestamp,
                    commitment.fillDeadline,
                    commitment.exclusiveRelayer,
                    commitment.exclusivityParameter,
                    commitment.exchange
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
            bridgeViable ? FallbackReason.BRIDGE_CALL_FAILED : FallbackReason.OUTPUT_BELOW_MINIMUM
        );
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

    function _isBridgeViable(uint256 outputAmount, uint256 minOutputAmount) internal pure returns (bool) {
        return outputAmount >= minOutputAmount;
    }

    function _validateNonPriceCommitment(AcrossSwapBridgeCommitment memory commitment) internal pure {
        if (commitment.destinationChainId == 0) {
            revert InvalidDestinationChainId(commitment.destinationChainId);
        }
        if (commitment.recipient == bytes32(0)) {
            revert InvalidRecipient(commitment.recipient);
        }
        if (commitment.outputToken == bytes32(0)) {
            revert InvalidOutputToken(commitment.outputToken);
        }
        if (commitment.minOutputAmount == 0) {
            revert InvalidMinOutputAmount(commitment.minOutputAmount);
        }
        if (commitment.exchange == address(0)) {
            revert InvalidExchange(commitment.exchange);
        }
        if (commitment.transferType > uint8(IAcrossSpokePoolPeriphery.TransferType.Permit2Approval)) {
            revert InvalidTransferType(commitment.transferType);
        }
        if (commitment.minExpectedInputTokenAmount == 0) {
            revert InvalidMinExpectedInputTokenAmount();
        }
    }

    function _buildSwapAndDepositData(
        AcrossSwapBridgeCommitment memory commitment,
        AcrossSwapBridgeFulfillData memory fulfillData,
        uint256 amountNetFees
    ) internal view returns (IAcrossSpokePoolPeriphery.SwapAndDepositData memory) {
        return IAcrossSpokePoolPeriphery.SwapAndDepositData({
            submissionFees: IAcrossSpokePoolPeriphery.Fees({ amount: 0, recipient: address(0) }),
            depositData: IAcrossSpokePoolPeriphery.BaseDepositData({
                inputToken: address(inputToken),
                outputToken: commitment.outputToken,
                outputAmount: fulfillData.outputAmount,
                depositor: address(this),
                recipient: commitment.recipient,
                destinationChainId: commitment.destinationChainId,
                exclusiveRelayer: commitment.exclusiveRelayer,
                quoteTimestamp: commitment.quoteTimestamp,
                fillDeadline: commitment.fillDeadline,
                exclusivityParameter: commitment.exclusivityParameter,
                message: commitment.message
            }),
            swapToken: address(inputToken),
            exchange: commitment.exchange,
            transferType: IAcrossSpokePoolPeriphery.TransferType(commitment.transferType),
            swapTokenAmount: amountNetFees,
            minExpectedInputTokenAmount: commitment.minExpectedInputTokenAmount,
            routerCalldata: commitment.routerCalldata,
            enableProportionalAdjustment: commitment.enableProportionalAdjustment,
            spokePool: spokePool,
            nonce: 0
        });
    }
}
