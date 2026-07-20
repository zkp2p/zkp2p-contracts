// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { OrchestratorV2 } from "./OrchestratorV2.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "./interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { BoundedCall } from "./lib/BoundedCall.sol";
import { FeeSettlementLib } from "./lib/FeeSettlementLib.sol";
import { OrchestratorV3FeeLib } from "./lib/OrchestratorV3FeeLib.sol";
import { OrchestratorV3RiskLib } from "./lib/OrchestratorV3RiskLib.sol";
import { OrchestratorV3Validation } from "./lib/OrchestratorV3Validation.sol";

/**
 * @title OrchestratorV3
 * @notice Extends the V2 intent lifecycle with snapshotted depositor-selected risk callbacks.
 * @dev V2 remains the canonical lifecycle implementation. V3 adds risk admission, terminal
 *      settlement, and durable recovery data for cancellation callbacks that fail open.
 */
contract OrchestratorV3 is OrchestratorV2, IOrchestratorV3 {

    /* ============ Constants ============ */

    uint256 public constant MIN_RISK_CALLBACK_GAS_LIMIT = 750_000;
    uint256 public constant MAX_RISK_CALLBACK_GAS_LIMIT = 2_000_000;
    uint256 public constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    /* ============ State Variables ============ */

    mapping(address => mapping(uint256 => IIntentRiskHook)) internal depositRiskHooks;
    mapping(bytes32 => IIntentRiskHook) internal intentRiskHooks;
    mapping(bytes32 => uint256) internal intentGatingNonces;
    mapping(bytes32 => OrchestratorV3FeeLib.IntentFeeSnapshot) internal intentFeeSnapshots;
    mapping(bytes32 => IntentCancellation) internal failedIntentCancellations;

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
        OrchestratorV3Validation.validateConstructor(
            _chainId,
            _escrowRegistry,
            _paymentVerifierRegistry,
            _relayerRegistry,
            _protocolFee,
            _protocolFeeRecipient
        );
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
        OrchestratorV3RiskLib.setDepositRiskHook(depositRiskHooks, _escrow, _depositId, _hook);
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

    /** @notice Returns the current single-use gating nonce for one taker and deposit scope. */
    function getIntentGatingNonce(
        address _taker,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod
    ) external view override returns (uint256) {
        return OrchestratorV3Validation.intentGatingNonce(
            intentGatingNonces,
            _taker,
            _escrow,
            _depositId,
            _paymentMethod
        );
    }

    /** @notice Returns the unprefixed message hash the gating service must sign. */
    function getIntentGatingMessageHash(
        SignalIntentParams calldata _params,
        address _taker
    ) external view override returns (bytes32) {
        return OrchestratorV3Validation.currentIntentGatingMessageHash(
            intentGatingNonces,
            _params,
            _taker,
            address(this),
            chainId
        );
    }

    /** @notice Returns the effective aggregate fee rate snapshotted for an unresolved intent. */
    function getIntentTotalFeeRate(bytes32 _intentHash) external view override returns (uint256) {
        return intentFeeSnapshots[_intentHash].totalFeeRate;
    }

    /**
     * @notice Returns the scalar intent fields required by a risk hook without copying dynamic intent data.
     */
    function getRiskIntent(bytes32 _intentHash) external view override returns (RiskIntentData memory riskIntent) {
        return OrchestratorV3RiskLib.getRiskIntent(intents, _intentHash);
    }

    /** @notice Returns the number of unresolved intents for an account in constant time. */
    function getAccountIntentCount(address _account) external view override returns (uint256) {
        return accountIntents[_account].length;
    }

    /**
     * @notice Returns the liquidity-unlock timestamp for a cancellation callback that failed open.
     */
    function getIntentCancellation(bytes32 _intentHash) external view override returns (uint64 cancelledAt) {
        return failedIntentCancellations[_intentHash].cancelledAt;
    }

    /* ============ Internal Lifecycle Extensions ============ */

    /** @dev Consumes one nonce before validating the gating service authorization. */
    function _validateIntentGatingAuthorization(
        SignalIntentParams calldata _params,
        address _intentGatingService,
        address _caller
    ) internal override {
        OrchestratorV3Validation.validateAndConsumeIntentGatingAuthorization(
            intentGatingNonces,
            _params,
            _intentGatingService,
            _caller,
            address(this),
            chainId
        );
    }

    /**
     * @notice Snapshots and executes risk admission after V2 stores the intent.
     */
    function _afterIntentSignaled(bytes32 _intentHash) internal override {
        OrchestratorV3FeeLib.snapshotIntentFees(
            intentFeeSnapshots,
            intents,
            intentManagerFeeRecipient,
            intentManagerFee,
            _intentHash,
            protocolFeeRecipient,
            protocolFee
        );

        Intent storage intent = intents[_intentHash];
        IIntentRiskHook riskHook = depositRiskHooks[intent.escrow][intent.depositId];
        intentRiskHooks[_intentHash] = riskHook;

        BoundedCall.executeRiskAdmission(
            riskHook,
            _intentHash,
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        emit IntentRiskHookSnapshotted(_intentHash, address(riskHook));
    }

    /**
     * @notice Adds V3 terminal accounting around the canonical V2 prune operation.
     */
    function _resolveIntent(
        bytes32 _intentHash,
        IntentResolution _resolution,
        uint256 _releasedAmount
    ) internal override {
        if (_resolution != IntentResolution.CANCELLED) {
            super._resolveIntent(_intentHash, _resolution, _releasedAmount);
            return;
        }

        uint64 cancelledAt = uint64(block.timestamp);
        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        super._resolveIntent(_intentHash, _resolution, _releasedAmount);
        delete intentRiskHooks[_intentHash];
        delete intentFeeSnapshots[_intentHash];

        bool callbackSucceeded = BoundedCall.executeRiskCancellation(
            riskHook,
            _intentHash,
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        if (!callbackSucceeded) {
            failedIntentCancellations[_intentHash] = IntentCancellation({ cancelledAt: cancelledAt });
            emit IntentCancellationRecorded(_intentHash, cancelledAt);
        }
    }

    /**
     * @notice Routes every manual release through the shared post-funds risk-settlement gate.
     */
    function _shouldExecuteSettlementHookOnManualRelease(
        bytes32
    ) internal pure override returns (bool) {
        return true;
    }

    /** @notice Gives risk settlement first refusal over gross funds, then executes the exact fee plan on zero consumption. */
    function _collectFeesTransferFundsAndExecuteAction(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _settlementHookData,
        address _managerFeeRecipient,
        uint256 _managerFee,
        bool _isManualRelease
    ) internal override {
        OrchestratorV3FeeLib.IntentFeeSnapshot memory feeSnapshot = intentFeeSnapshots[_intentHash];
        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        (address fundsTransferredTo, uint256 netAmount) = FeeSettlementLib.executeSettlement(
            _token,
            riskHook,
            _intentHash,
            _intent,
            _releaseAmount,
            _settlementHookData,
            FeeSettlementLib.FeeConfig({
                protocolFeeRecipient: feeSnapshot.protocolFeeRecipient,
                protocolFee: feeSnapshot.protocolFeeRate,
                managerFeeRecipient: _managerFeeRecipient,
                managerFee: _managerFee
            }),
            _isManualRelease,
            riskCallbackGasLimit
        );
        delete intentRiskHooks[_intentHash];
        delete intentFeeSnapshots[_intentHash];

        emit IntentFulfilled(_intentHash, fundsTransferredTo, netAmount, _isManualRelease);
    }

    function _setRiskCallbackGasLimit(uint256 _gasLimit) internal {
        if (_gasLimit < MIN_RISK_CALLBACK_GAS_LIMIT) {
            revert RiskCallbackGasLimitTooLow(_gasLimit, MIN_RISK_CALLBACK_GAS_LIMIT);
        }
        if (_gasLimit > MAX_RISK_CALLBACK_GAS_LIMIT) {
            revert RiskCallbackGasLimitTooHigh(_gasLimit, MAX_RISK_CALLBACK_GAS_LIMIT);
        }

        riskCallbackGasLimit = _gasLimit;
        emit RiskCallbackGasLimitUpdated(_gasLimit);
    }
}
