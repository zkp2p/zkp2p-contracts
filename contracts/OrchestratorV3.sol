// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { OrchestratorV2 } from "./OrchestratorV2.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "./interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { BoundedCall } from "./lib/BoundedCall.sol";
import { PostIntentHookExecutor } from "./lib/PostIntentHookExecutor.sol";

/**
 * @title OrchestratorV3
 * @notice Extends the V2 intent lifecycle with snapshotted depositor-selected risk callbacks.
 * @dev V2 remains the canonical lifecycle implementation. V3 adds risk admission, terminal
 *      callbacks, and recovery data for settlement callbacks that fail open.
 */
contract OrchestratorV3 is OrchestratorV2, IOrchestratorV3 {
    /* ============ Constants ============ */

    uint256 public constant MIN_RISK_CALLBACK_GAS_LIMIT = 750_000;
    uint256 public constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    /* ============ State Variables ============ */

    mapping(address => mapping(uint256 => IIntentRiskHook)) internal depositRiskHooks;
    mapping(bytes32 => IIntentRiskHook) internal intentRiskHooks;
    mapping(bytes32 => bool) public override intentRequiresPostIntentHook;
    mapping(bytes32 => IntentSettlement) internal failedIntentSettlements;

    uint256 public riskCallbackGasLimit;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a V3 orchestrator while preserving all V2 constructor dependencies.
     * @param _owner Governance owner.
     * @param _chainId Chain identifier used by existing intent signature validation.
     * @param _escrowRegistry Registry of accepted escrow contracts.
     * @param _paymentVerifierRegistry Registry of payment proof verifiers.
     * @param _relayerRegistry Existing relayer registry retained for compatibility.
     * @param _protocolFee Protocol fee in 1e18 precise units.
     * @param _protocolFeeRecipient Protocol fee recipient.
     * @param _riskCallbackGasLimit Gas forwarded to each risk callback.
     */
    constructor(
        address _owner,
        uint256 _chainId,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        address _relayerRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient,
        uint256 _riskCallbackGasLimit
    )
        OrchestratorV2(
            _owner,
            _chainId,
            _escrowRegistry,
            _paymentVerifierRegistry,
            _relayerRegistry,
            _protocolFee,
            _protocolFeeRecipient
        )
    {
        _setRiskCallbackGasLimit(_riskCallbackGasLimit);
    }

    /* ============ Guarded V2 Functions ============ */

    /**
     * @inheritdoc IOrchestratorV2
     * @dev V3 guards cancellation because it invokes an external risk callback during resolution.
     */
    function cancelIntent(
        bytes32 _intentHash
    ) public override(OrchestratorV2, IOrchestratorV2) nonReentrant {
        super.cancelIntent(_intentHash);
    }

    /**
     * @inheritdoc IOrchestratorV2
     * @dev V3 guards cleanup because it invokes an external risk callback during resolution.
     */
    function cleanupOrphanedIntents(
        bytes32[] calldata _intentHashes
    ) public override(OrchestratorV2, IOrchestratorV2) nonReentrant {
        super.cleanupOrphanedIntents(_intentHashes);
    }

    /* ============ Depositor Functions ============ */

    /**
     * @notice Sets or removes the risk hook used by future intents for one deposit.
     * @dev Existing intents keep their snapshotted hook.
     */
    function setDepositRiskHook(
        address _escrow,
        uint256 _depositId,
        IIntentRiskHook _hook
    ) external override nonReentrant {
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

        depositRiskHooks[_escrow][_depositId] = _hook;
        emit DepositRiskHookSet(_escrow, _depositId, hookAddress, msg.sender);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice Updates gas forwarded to admission and terminal risk callbacks.
     */
    function setRiskCallbackGasLimit(uint256 _gasLimit) external override onlyOwner {
        _setRiskCallbackGasLimit(_gasLimit);
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the risk hook currently selected for future deposit intents.
     */
    function getDepositRiskHook(
        address _escrow,
        uint256 _depositId
    ) external view override returns (IIntentRiskHook) {
        return depositRiskHooks[_escrow][_depositId];
    }

    /**
     * @notice Returns the immutable hook snapshot for an active intent.
     */
    function getIntentRiskHook(bytes32 _intentHash) external view override returns (IIntentRiskHook) {
        return intentRiskHooks[_intentHash];
    }

    /**
     * @notice Returns the scalar intent fields required by a risk hook without copying dynamic intent data.
     */
    function getRiskIntent(bytes32 _intentHash) external view override returns (RiskIntentData memory riskIntent) {
        Intent storage intent = intents[_intentHash];
        riskIntent = RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            postIntentHook: address(intent.postIntentHook)
        });
    }

    /**
     * @notice Returns the number of unresolved intents for an account in constant time.
     */
    function getAccountIntentCount(address _account) external view override returns (uint256) {
        return accountIntents[_account].length;
    }

    /**
     * @notice Returns recovery data for a settlement callback that failed open.
     * @dev Successful callbacks intentionally leave this record empty.
     */
    function getIntentSettlement(
        bytes32 _intentHash
    ) external view override returns (uint256 releasedAmount, uint64 settledAt) {
        IntentSettlement memory settlement = failedIntentSettlements[_intentHash];
        return (settlement.releasedAmount, settlement.settledAt);
    }

    /* ============ Internal Lifecycle Extensions ============ */

    /**
     * @notice Snapshots and executes risk admission after V2 stores the intent.
     */
    function _afterIntentSignaled(bytes32 _intentHash) internal override {
        Intent storage intent = intents[_intentHash];
        IIntentRiskHook riskHook = depositRiskHooks[intent.escrow][intent.depositId];
        intentRiskHooks[_intentHash] = riskHook;

        bool requiresPostIntentHook = BoundedCall.executeRiskAdmission(
            riskHook,
            _intentHash,
            address(intent.postIntentHook),
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        intentRequiresPostIntentHook[_intentHash] = requiresPostIntentHook;
        emit IntentRiskHookSnapshotted(_intentHash, address(riskHook), requiresPostIntentHook);
    }

    /**
     * @notice Adds V3 terminal accounting around the canonical V2 prune operation.
     */
    function _resolveIntent(
        bytes32 _intentHash,
        IntentResolution _resolution,
        uint256 _releasedAmount
    ) internal override {
        bool isSettlement = _resolution != IntentResolution.CANCELLED;
        uint64 settledAt;

        if (isSettlement) {
            settledAt = uint64(block.timestamp);
            emit IntentSettlementRecorded(_intentHash, _releasedAmount, settledAt);
        }

        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];

        super._resolveIntent(_intentHash, _resolution, _releasedAmount);
        delete intentRiskHooks[_intentHash];
        delete intentRequiresPostIntentHook[_intentHash];

        bool callbackSucceeded = BoundedCall.executeTerminalRiskCallback(
            riskHook,
            _intentHash,
            uint8(_resolution),
            _releasedAmount,
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        if (isSettlement && !callbackSucceeded) {
            failedIntentSettlements[_intentHash] = IntentSettlement({
                releasedAmount: _releasedAmount,
                settledAt: settledAt
            });
        }
    }

    /**
     * @notice Enforces deferred payout execution for manual releases that required it at admission.
     */
    function _shouldExecutePostIntentHookOnManualRelease(
        bytes32 _intentHash
    ) internal view override returns (bool) {
        bool requiresPostIntentHook = intentRequiresPostIntentHook[_intentHash];
        if (requiresPostIntentHook && address(intents[_intentHash].postIntentHook) == address(0)) {
            revert RequiredPostIntentHookMissing(_intentHash);
        }
        return requiresPostIntentHook;
    }

    /**
     * @notice Executes the V2 settlement transfer through the shared external executor.
     */
    function _collectFeesTransferFundsAndExecuteAction(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _postIntentHookData,
        address _managerFeeRecipient,
        uint256 _managerFee,
        bool _isManualRelease
    ) internal override {
        uint256 netFees = _calculateAndTransferFees(
            _token,
            _intentHash,
            _intent,
            _releaseAmount,
            _managerFeeRecipient,
            _managerFee
        );
        uint256 netAmount = _releaseAmount - netFees;
        address fundsTransferredTo = PostIntentHookExecutor.transferOrExecute(
            _token,
            _intentHash,
            _intent,
            netAmount,
            _postIntentHookData
        );

        emit IntentFulfilled(_intentHash, fundsTransferredTo, netAmount, _isManualRelease);
    }

    function _setRiskCallbackGasLimit(uint256 _gasLimit) internal {
        if (_gasLimit < MIN_RISK_CALLBACK_GAS_LIMIT) {
            revert RiskCallbackGasLimitTooLow(_gasLimit, MIN_RISK_CALLBACK_GAS_LIMIT);
        }

        riskCallbackGasLimit = _gasLimit;
        emit RiskCallbackGasLimitUpdated(_gasLimit);
    }
}
