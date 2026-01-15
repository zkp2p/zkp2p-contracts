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
 * @notice Post-intent hook that bridges tokens into Across SpokePool using committed destination params.
 *
 * @dev IMPORTANT: This hook is designed for stablecoin-to-stablecoin bridging only.
 *
 * NOT RECOMMENDED for volatile assets (ETH, WBTC, etc.) because:
 * - The `minOutputAmount` is committed at signalIntent time
 * - The actual `outputAmount` is provided at fulfillIntent time
 * - If the asset price drops between signal and fulfill, the minOutputAmount check will fail
 * - Since the user has already made an off-chain fiat payment tied to this intent,
 *   a reverted fulfillIntent leaves them unable to unlock escrowed funds
 *
 * For stablecoin-to-stablecoin routes (e.g., USDC on Base -> USDC on Arbitrum), the price
 * is stable and minOutputAmount checks will reliably pass.
 *
 * @dev Uses depositNow which accepts bytes32 addresses for cross-chain compatibility.
 * This enables bridging to both EVM chains (addresses left-padded to bytes32) and
 * non-EVM chains like Solana (native 32-byte addresses).
 */
contract AcrossBridgeHook is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Structs ============ */

    /**
     * @notice Commitment stored in intent.data at signalIntent time.
     * @dev Uses bytes32 for outputToken and recipient to support both EVM and Solana addresses.
     *      For EVM addresses, use _toBytes32(address) to left-pad to bytes32.
     *      For Solana addresses, use the native 32-byte public key directly.
     *      For stablecoin-to-stablecoin routes, set minOutputAmount close to expected output (e.g., 99.5%).
     *      For volatile assets, this check may fail if price moves unfavorably between signal and fulfill.
     * @param destinationChainId The chain ID of the destination chain
     * @param outputToken Token address on destination chain (bytes32 for Solana compatibility)
     * @param recipient Recipient address on destination chain (bytes32 for Solana compatibility)
     * @param minOutputAmount Minimum tokens to receive on destination chain
     */
    struct BridgeCommitment {
        uint256 destinationChainId;
        bytes32 outputToken;
        bytes32 recipient;
        uint256 minOutputAmount;
    }

    /**
     * @notice JIT data supplied at fulfillIntent time.
     * @dev fillDeadlineOffset is seconds from current block timestamp until fill deadline expires.
     *      Typical values range from 1800 (30 min) to 21600 (6 hours) depending on route.
     * @param intentHash Hash of the intent being fulfilled
     * @param outputAmount Amount of tokens to receive on destination chain
     * @param fillDeadlineOffset Seconds from current time until fill deadline
     */
    struct AcrossFulfillData {
        bytes32 intentHash;
        uint256 outputAmount;
        uint32 fillDeadlineOffset;
    }

    /* ============ Events ============ */

    /**
     * @notice Emitted when a bridge deposit is initiated via Across.
     * @param intentHash Hash of the fulfilled intent
     * @param destinationChainId Target chain for the bridged tokens
     * @param outputToken Token address on destination (bytes32 for cross-chain compatibility)
     * @param recipient Recipient address on destination (bytes32 for cross-chain compatibility)
     * @param inputAmount Amount of input tokens deposited
     * @param outputAmount Amount of output tokens to receive
     * @param fillDeadlineOffset Offset in seconds for fill deadline
     */
    event AcrossBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 fillDeadlineOffset
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(bytes32 recipient);
    error InvalidOutputToken(bytes32 outputToken);
    /// @dev Reverts fulfillIntent if outputAmount < minOutputAmount. For volatile assets,
    ///      this can occur if price dropped between signalIntent and fulfillIntent.
    error OutputBelowMinimum(uint256 outputAmount, uint256 minimum);
    error NativeTransferFailed(address to, uint256 amount);

    /* ============ State Variables ============ */

    IERC20 public immutable inputToken;
    address public immutable orchestrator;
    IAcrossSpokePool public immutable spokePool;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new AcrossBridgeHook instance.
     * @param _inputToken Token address to bridge (recommended: stablecoins like USDC)
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
     * @notice Executes the hook by depositing USDC into Across SpokePool using depositNow.
     * @dev Destination params are taken from the commitment; fulfill data only supplies JIT fields.
     *      Uses depositNow which automatically uses current block timestamp, eliminating timing issues.
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

        _deposit(
            commitment.recipient,
            commitment.outputToken,
            commitment.destinationChainId,
            _amountNetFees,
            fulfillData.outputAmount,
            fulfillData.fillDeadlineOffset
        );

        emit AcrossBridgeInitiated(
            fulfillData.intentHash,
            commitment.destinationChainId,
            commitment.outputToken,
            commitment.recipient,
            _amountNetFees,
            fulfillData.outputAmount,
            fulfillData.fillDeadlineOffset
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

    /**
     * @dev Validates bridge commitment parameters. The minOutputAmount check is critical:
     *      - For stablecoins: safe to set tight (e.g., 99.5% of input)
     *      - For volatile assets: may revert if price dropped since signalIntent
     * @param commitment The bridge commitment containing destination parameters
     * @param fulfillData The fulfill data containing output amount
     */
    function _validateCommitment(
        BridgeCommitment memory commitment,
        AcrossFulfillData memory fulfillData
    ) internal pure {
        if (commitment.destinationChainId == 0) {
            revert InvalidDestinationChainId(commitment.destinationChainId);
        }
        if (commitment.recipient == bytes32(0)) {
            revert InvalidRecipient(commitment.recipient);
        }
        if (commitment.outputToken == bytes32(0)) {
            revert InvalidOutputToken(commitment.outputToken);
        }

        if (fulfillData.outputAmount < commitment.minOutputAmount) {
            revert OutputBelowMinimum(fulfillData.outputAmount, commitment.minOutputAmount);
        }
    }

    /**
     * @dev Deposits tokens into the Across SpokePool using depositNow.
     * @param recipient Recipient address on destination chain (bytes32)
     * @param outputToken Token address on destination chain (bytes32)
     * @param destinationChainId Target chain ID
     * @param inputAmount Amount of input tokens to bridge
     * @param outputAmount Amount of output tokens to receive
     * @param fillDeadlineOffset Seconds from now until fill deadline
     */
    function _deposit(
        bytes32 recipient,
        bytes32 outputToken,
        uint256 destinationChainId,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 fillDeadlineOffset
    ) internal {
        inputToken.safeTransferFrom(orchestrator, address(this), inputAmount);

        inputToken.safeApprove(address(spokePool), 0);
        inputToken.safeApprove(address(spokePool), inputAmount);

        spokePool.depositNow(
            _toBytes32(address(this)),  // depositor
            recipient,                   // recipient (already bytes32)
            _toBytes32(address(inputToken)), // inputToken
            outputToken,                 // outputToken (already bytes32)
            inputAmount,
            outputAmount,
            destinationChainId,
            bytes32(0),                  // exclusiveRelayer (none)
            fillDeadlineOffset,          // fill deadline offset from now
            0,                           // exclusivityParameter
            ""                           // message
        );

        inputToken.safeApprove(address(spokePool), 0);
    }

    /**
     * @dev Converts an address to bytes32 by left-padding with zeros.
     *      Used for EVM addresses when calling depositNow.
     * @param addr The address to convert
     * @return The address as bytes32 (left-padded)
     */
    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
