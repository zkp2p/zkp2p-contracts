// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ITokenMessengerV2 } from "../external/Interfaces/ITokenMessengerV2.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../interfaces/IPostIntentHook.sol";

/**
 * @title CctpBridgeHook
 * @notice Post-intent hook that burns USDC via CCTP v2 TokenMessenger on the source chain.
 */
contract CctpBridgeHook is IPostIntentHook, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Structs ============ */

    /// @notice Commitment stored in intent.data at signalIntent time.
    struct CctpBridgeCommitment {
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint32 minFinalityThreshold;
    }

    /// @notice JIT data supplied at fulfillIntent time (event indexing only).
    struct CctpFulfillData {
        bytes32 intentHash;
    }

    /* ============ Events ============ */

    event CctpBridgeInitiated(
        bytes32 indexed intentHash,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller);
    error InvalidDestinationDomain(uint32 destinationDomain);
    error InvalidRecipient(bytes32 mintRecipient);
    error InvalidFinalityThreshold(uint32 minFinalityThreshold);
    error MaxFeeAboveAmount(uint256 maxFee, uint256 amount);
    error NativeTransferFailed(address to, uint256 amount);

    /* ============ Constants ============ */

    uint32 internal constant FINALITY_THRESHOLD_CONFIRMED = 1000;
    uint32 internal constant FINALITY_THRESHOLD_FINALIZED = 2000;

    /* ============ State Variables ============ */

    IERC20 public immutable inputToken;
    address public immutable orchestrator;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable sourceDomain;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new CctpBridgeHook instance.
     * @param _inputToken USDC token address on this chain
     * @param _orchestrator Orchestrator that invokes this hook
     * @param _tokenMessenger CCTP v2 TokenMessenger address on this chain
     * @param _sourceDomain CCTP domain ID for this chain
     */
    constructor(
        address _inputToken,
        address _orchestrator,
        address _tokenMessenger,
        uint32 _sourceDomain
    ) Ownable() {
        if (_inputToken == address(0) || _orchestrator == address(0) || _tokenMessenger == address(0)) {
            revert ZeroAddress();
        }
        if (_sourceDomain == 0) {
            revert InvalidDestinationDomain(_sourceDomain);
        }

        inputToken = IERC20(_inputToken);
        orchestrator = _orchestrator;
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
        sourceDomain = _sourceDomain;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Executes the hook by burning USDC via CCTP v2 TokenMessenger.
     * @dev Destination params are taken from the commitment; fulfill data only supplies JIT fields.
     * @param _intent Intent data passed by Orchestrator (includes commitment in intent.data)
     * @param _amountNetFees Net USDC amount after fees
     * @param _fulfillIntentData ABI-encoded CctpFulfillData
     */
    function execute(
        IOrchestrator.Intent memory _intent,
        uint256 _amountNetFees,
        bytes calldata _fulfillIntentData
    ) external override {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender);

        CctpBridgeCommitment memory commitment = abi.decode(_intent.data, (CctpBridgeCommitment));
        CctpFulfillData memory fulfillData = abi.decode(_fulfillIntentData, (CctpFulfillData));

        _validateCommitment(commitment);

        uint256 maxFee = tokenMessenger.getMinFeeAmount(_amountNetFees);
        if (maxFee > _amountNetFees) {
            revert MaxFeeAboveAmount(maxFee, _amountNetFees);
        }

        inputToken.safeTransferFrom(orchestrator, address(this), _amountNetFees);

        inputToken.safeApprove(address(tokenMessenger), 0);
        inputToken.safeApprove(address(tokenMessenger), _amountNetFees);

        tokenMessenger.depositForBurn(
            _amountNetFees,
            commitment.destinationDomain,
            commitment.mintRecipient,
            address(inputToken),
            commitment.destinationCaller,
            maxFee,
            commitment.minFinalityThreshold
        );

        inputToken.safeApprove(address(tokenMessenger), 0);

        emit CctpBridgeInitiated(
            fulfillData.intentHash,
            commitment.destinationDomain,
            commitment.mintRecipient,
            _amountNetFees,
            maxFee,
            commitment.minFinalityThreshold
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

    function _validateCommitment(CctpBridgeCommitment memory commitment) internal view {
        if (commitment.destinationDomain == 0 || commitment.destinationDomain == sourceDomain) {
            revert InvalidDestinationDomain(commitment.destinationDomain);
        }
        if (commitment.mintRecipient == bytes32(0)) {
            revert InvalidRecipient(commitment.mintRecipient);
        }
        if (
            commitment.minFinalityThreshold != FINALITY_THRESHOLD_CONFIRMED &&
            commitment.minFinalityThreshold != FINALITY_THRESHOLD_FINALIZED
        ) {
            revert InvalidFinalityThreshold(commitment.minFinalityThreshold);
        }
    }
}
