// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAcrossSpokePool } from "../external/Interfaces/IAcrossSpokePool.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";

/**
 * @title AcrossBridgeHook
 * @notice Post-intent hook that deposits USDC into Across SpokePool using committed destination params.
 */
contract AcrossBridgeHook is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Structs ============ */

    /// @notice Commitment stored in intent.data at signalIntent time.
    struct BridgeCommitment {
        uint256 destinationChainId;
        address outputToken;
        address recipient;
        uint256 minOutputAmount;
    }

    /// @notice JIT data supplied at fulfillIntent time.
    struct AcrossFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
    }

    /* ============ Events ============ */

    event AcrossBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        address outputToken,
        address recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(address recipient);
    error InvalidOutputToken(address outputToken);
    error OutputBelowMinimum(uint256 outputAmount, uint256 minimum);
    error QuoteTimestampOutOfRange(uint32 quoteTimestamp);
    error FillDeadlineOutOfRange(uint32 fillDeadline);
    error NativeTransferFailed(address to, uint256 amount);

    /* ============ State Variables ============ */

    IERC20 public immutable inputToken;
    address public immutable orchestrator;
    IAcrossSpokePool public immutable spokePool;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new AcrossBridgeHook instance.
     * @param _inputToken USDC token address on this chain
     * @param _orchestrator Orchestrator that invokes this hook
     * @param _spokePool Across SpokePool address on this chain
     */
    constructor(address _inputToken, address _orchestrator, address _spokePool) Ownable() {
        if (_inputToken == address(0) || _orchestrator == address(0) || _spokePool == address(0)) {
            revert ZeroAddress();
        }

        inputToken = IERC20(_inputToken);
        orchestrator = _orchestrator;
        spokePool = IAcrossSpokePool(_spokePool);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Executes the hook by depositing USDC into Across SpokePool.
     * @dev Destination params are taken from the commitment; fulfill data only supplies JIT fields.
     * @param _intent Intent data passed by Orchestrator (includes commitment in intent.data)
     * @param _amountNetFees Net USDC amount after fees
     * @param _fulfillIntentData ABI-encoded AcrossFulfillData
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external override {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender);

        BridgeCommitment memory commitment = abi.decode(_intent.data, (BridgeCommitment));
        AcrossFulfillData memory fulfillData = abi.decode(_fulfillIntentData, (AcrossFulfillData));

        _validateCommitment(commitment, fulfillData);
        _validateTiming(fulfillData.quoteTimestamp, fulfillData.fillDeadline);

        _deposit(
            commitment.recipient,
            commitment.outputToken,
            commitment.destinationChainId,
            _amountNetFees,
            fulfillData.outputAmount,
            fulfillData.quoteTimestamp,
            fulfillData.fillDeadline
        );

        _emitBridgeInitiated(
            fulfillData.intentHash,
            commitment.destinationChainId,
            commitment.outputToken,
            commitment.recipient,
            _amountNetFees,
            fulfillData.outputAmount,
            fulfillData.quoteTimestamp,
            fulfillData.fillDeadline
        );
    }

    /**
     * @notice Rescues ERC20 tokens sent to this contract.
     * @param _token Token address to rescue
     * @param _to Recipient address for rescued tokens
     * @param _amount Amount to rescue
     */
    function rescueERC20(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(0) || _to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(_to, _amount);
        emit RescueERC20(_token, _to, _amount);
    }

    /**
     * @notice Rescues native tokens sent to this contract.
     * @param _to Recipient address for rescued native tokens
     * @param _amount Amount to rescue
     */
    function rescueNative(address payable _to, uint256 _amount) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        (bool success, ) = _to.call{ value: _amount }("");
        if (!success) revert NativeTransferFailed(_to, _amount);
        emit RescueNative(_to, _amount);
    }

    receive() external payable {}

    /* ============ Internal Functions ============ */

    function _validateCommitment(
        BridgeCommitment memory commitment,
        AcrossFulfillData memory fulfillData
    ) internal pure {
        if (commitment.destinationChainId == 0) {
            revert InvalidDestinationChainId(commitment.destinationChainId);
        }
        if (commitment.recipient == address(0)) {
            revert InvalidRecipient(commitment.recipient);
        }
        if (commitment.outputToken == address(0)) {
            revert InvalidOutputToken(commitment.outputToken);
        }

        if (fulfillData.outputAmount < commitment.minOutputAmount) {
            revert OutputBelowMinimum(fulfillData.outputAmount, commitment.minOutputAmount);
        }
    }

    function _validateTiming(uint32 quoteTimestamp, uint32 fillDeadline) internal view {
        uint256 current = spokePool.getCurrentTime();
        uint256 quoteBuffer = spokePool.depositQuoteTimeBuffer();
        uint256 fillBuffer = spokePool.fillDeadlineBuffer();

        // quoteTimestamp must be within +/- quoteBuffer of current time
        if (quoteTimestamp > current + quoteBuffer || current > uint256(quoteTimestamp) + quoteBuffer) {
            revert QuoteTimestampOutOfRange(quoteTimestamp);
        }

        if (fillDeadline < current || fillDeadline > current + fillBuffer) {
            revert FillDeadlineOutOfRange(fillDeadline);
        }
    }

    function _deposit(
        address recipient,
        address outputToken,
        uint256 destinationChainId,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline
    ) internal {
        inputToken.safeTransferFrom(orchestrator, address(this), inputAmount);

        inputToken.safeApprove(address(spokePool), 0);
        inputToken.safeApprove(address(spokePool), inputAmount);

        spokePool.depositV3(
            address(this),
            recipient,
            address(inputToken),
            outputToken,
            inputAmount,
            outputAmount,
            destinationChainId,
            address(0),
            quoteTimestamp,
            fillDeadline,
            0,
            ""
        );

        inputToken.safeApprove(address(spokePool), 0);
    }

    function _emitBridgeInitiated(
        bytes32 intentHash,
        uint256 destinationChainId,
        address outputToken,
        address recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline
    ) internal {
        emit AcrossBridgeInitiated(
            intentHash,
            destinationChainId,
            outputToken,
            recipient,
            inputAmount,
            outputAmount,
            quoteTimestamp,
            fillDeadline
        );
    }

}
