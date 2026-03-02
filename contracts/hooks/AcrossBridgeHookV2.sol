// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAcrossSpokePool } from "../external/Interfaces/IAcrossSpokePool.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPostIntentHookV2 } from "../interfaces/IPostIntentHookV2.sol";

/**
 * @title AcrossBridgeHookV2
 * @notice V2 post-intent hook that bridges tokens into Across SpokePool using committed destination params.
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
contract AcrossBridgeHookV2 is IPostIntentHookV2, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Enums ============ */

    /**
     * @notice Reason codes for fallback transfer when bridge cannot be initiated.
     * @dev Used in FallbackTransfer event for gas-efficient reason tracking.
     */
    enum FallbackReason {
        OUTPUT_BELOW_MINIMUM,  // outputAmount < minOutputAmount (price moved unfavorably)
        BRIDGE_CALL_FAILED     // spokePool.depositNow() reverted
    }

    /* ============ Structs ============ */

    /**
     * @notice Commitment stored in intent signalHookData at signalIntent time.
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
     *      exclusiveRelayer and exclusivityParameter should come from Across suggested-fees API
     *      to ensure deposits are prioritized by relayers.
     * @param outputAmount Amount of tokens to receive on destination chain
     * @param fillDeadlineOffset Seconds from current time until fill deadline
     * @param exclusiveRelayer Address (as bytes32) of the exclusive relayer from Across API
     * @param exclusivityParameter Seconds of exclusivity for the exclusive relayer
     */
    struct AcrossFulfillData {
        uint256 outputAmount;
        uint32 fillDeadlineOffset;
        bytes32 exclusiveRelayer;
        uint32 exclusivityParameter;
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
     * @param exclusiveRelayer Address of the exclusive relayer (bytes32 for cross-chain compatibility)
     * @param exclusivityParameter Seconds of exclusivity for the exclusive relayer
     */
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

    /**
     * @notice Emitted when bridge cannot be initiated and funds are transferred directly to recipient.
     * @dev This is a graceful degradation - user receives funds on source chain instead of destination.
     * @param intentHash Hash of the intent being fulfilled
     * @param recipient Address receiving the fallback transfer (intent.to)
     * @param amount Amount transferred to recipient
     * @param reason Why the bridge could not be initiated
     */
    event FallbackTransfer(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        FallbackReason reason
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedOrchestratorCaller(address caller);
    error InvalidFulfillHookDataLength(uint256 dataLength);
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidRecipient(bytes32 recipient);
    error InvalidOutputToken(bytes32 outputToken);
    /// @dev Reverts fulfillIntent if outputAmount < minOutputAmount. For volatile assets,
    ///      this can occur if price dropped between signalIntent and fulfillIntent.
    error NativeTransferFailed(address to, uint256 amount);

    /* ============ State Variables ============ */

    IERC20 public immutable inputToken;
    IOrchestratorRegistry public immutable orchestratorRegistry;
    IAcrossSpokePool public immutable spokePool;
    uint256 private constant ACROSS_FULFILL_DATA_LENGTH = 128;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new AcrossBridgeHookV2 instance.
     * @param _inputToken Token address to bridge (recommended: stablecoins like USDC)
     * @param _orchestratorRegistry Registry of authorized orchestrators that may invoke this hook
     * @param _spokePool Across SpokePool address on this chain
     */
    constructor(address _inputToken, address _orchestratorRegistry, address _spokePool) Ownable() {
        if (_inputToken == address(0) || _orchestratorRegistry == address(0) || _spokePool == address(0)) {
            revert ZeroAddress();
        }

        inputToken = IERC20(_inputToken);
        orchestratorRegistry = IOrchestratorRegistry(_orchestratorRegistry);
        spokePool = IAcrossSpokePool(_spokePool);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Executes the hook by depositing tokens into Across SpokePool using depositNow.
     * @dev Destination params are taken from the commitment; fulfill data only supplies JIT fields.
     *      Uses depositNow which automatically uses current block timestamp, eliminating timing issues.
     *
     *      FALLBACK BEHAVIOR: If the bridge cannot be initiated (due to price movement causing
     *      outputAmount < minOutputAmount, or if the SpokePool call reverts), funds are transferred
     *      directly to intent.to on the source chain instead of reverting. This ensures the user
     *      always receives their funds after making an off-chain payment, preventing permanent loss.
     *
     * @param _ctx Hook execution context passed by OrchestratorV2 (includes commitment in intent.signalHookData)
     * @param _fulfillHookData ABI-encoded AcrossFulfillData
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata _fulfillHookData
    ) external override {
        address callingOrchestrator = msg.sender;
        if (!orchestratorRegistry.isOrchestrator(callingOrchestrator)) revert UnauthorizedOrchestratorCaller(callingOrchestrator);
        if (_fulfillHookData.length != ACROSS_FULFILL_DATA_LENGTH) {
            revert InvalidFulfillHookDataLength(_fulfillHookData.length);
        }

        BridgeCommitment memory commitment = abi.decode(_ctx.intent.signalHookData, (BridgeCommitment));
        AcrossFulfillData memory fulfillData = abi.decode(_fulfillHookData, (AcrossFulfillData));

        // Validate non-price parameters (these should always revert if invalid)
        _validateNonPriceCommitment(commitment);

        // Pull tokens from calling Orchestrator first (before any fallback logic)
        inputToken.safeTransferFrom(callingOrchestrator, address(this), _ctx.executableAmount);

        // Check if bridge is viable based on price
        bool bridgeViable = _isBridgeViable(fulfillData, commitment.minOutputAmount);

        if (bridgeViable) {
            // Set approval for bridge attempt
            inputToken.safeApprove(address(spokePool), 0);
            inputToken.safeApprove(address(spokePool), _ctx.executableAmount);

            // Try bridge deposit - use try-catch for graceful degradation
            try spokePool.depositNow(
                _toBytes32(address(this)),         // depositor
                commitment.recipient,              // recipient (already bytes32)
                _toBytes32(address(inputToken)),   // inputToken
                commitment.outputToken,            // outputToken (already bytes32)
                _ctx.executableAmount,
                fulfillData.outputAmount,
                commitment.destinationChainId,
                fulfillData.exclusiveRelayer,      // from Across suggested-fees API
                fulfillData.fillDeadlineOffset,
                fulfillData.exclusivityParameter,  // from Across suggested-fees API
                ""                                 // message
            ) {
                // Bridge succeeded - reset approval and emit success event
                inputToken.safeApprove(address(spokePool), 0);
                emit AcrossBridgeInitiated(
                    _ctx.intentHash,
                    commitment.destinationChainId,
                    commitment.outputToken,
                    commitment.recipient,
                    _ctx.executableAmount,
                    fulfillData.outputAmount,
                    fulfillData.fillDeadlineOffset,
                    fulfillData.exclusiveRelayer,
                    fulfillData.exclusivityParameter
                );
                return;
            } catch {
                // Bridge call failed - reset approval and fall through to fallback
                inputToken.safeApprove(address(spokePool), 0);
            }
        }

        // Fallback: transfer to intent.to on source chain
        // This ensures user receives funds even if bridge fails
        inputToken.safeTransfer(_ctx.intent.to, _ctx.executableAmount);
        emit FallbackTransfer(
            _ctx.intentHash,
            _ctx.intent.to,
            _ctx.executableAmount,
            bridgeViable ? FallbackReason.BRIDGE_CALL_FAILED : FallbackReason.OUTPUT_BELOW_MINIMUM
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
     * @dev Validates non-price bridge commitment parameters. These are structural requirements
     *      that should always revert if invalid (no fallback possible).
     * @param commitment The bridge commitment containing destination parameters
     */
    function _validateNonPriceCommitment(BridgeCommitment memory commitment) internal pure {
        if (commitment.destinationChainId == 0) {
            revert InvalidDestinationChainId(commitment.destinationChainId);
        }
        if (commitment.recipient == bytes32(0)) {
            revert InvalidRecipient(commitment.recipient);
        }
        if (commitment.outputToken == bytes32(0)) {
            revert InvalidOutputToken(commitment.outputToken);
        }
    }

    /**
     * @dev Checks if the bridge output amount meets the minimum requirement.
     *      Unlike structural validation, this returns a bool for graceful degradation.
     * @param fulfillData The fulfill data containing output amount
     * @param minOutputAmount The minimum acceptable output amount from commitment
     * @return True if outputAmount >= minOutputAmount, false otherwise
     */
    function _isBridgeViable(
        AcrossFulfillData memory fulfillData,
        uint256 minOutputAmount
    ) internal pure returns (bool) {
        return fulfillData.outputAmount >= minOutputAmount;
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
