// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { OrchestratorV2 } from "./OrchestratorV2.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IOrchestratorV2 } from "./interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { IPostIntentHookV2 } from "./interfaces/IPostIntentHookV2.sol";
import { IReferralFee } from "./interfaces/IReferralFee.sol";
import { IPaymentVerifier } from "./interfaces/IPaymentVerifier.sol";

/**
 * @title OrchestratorV3
 * @notice V2-compatible intent lifecycle with mandatory, snapshotted depositor-selected risk callbacks.
 * @dev The Intent struct and existing intent events remain unchanged. Risk hook selection and manual-release
 *      settlement requirements live in separate mappings so downstream consumers retain the V2 data model.
 *      A depositor-selected hook is trusted policy for that deposit and can reject admission.
 */
contract OrchestratorV3 is OrchestratorV2, IOrchestratorV3 {
    using SafeERC20 for IERC20;

    /* ============ Constants ============ */

    uint256 public constant MIN_RISK_CALLBACK_GAS_LIMIT = 100_000;
    uint256 public constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    /* ============ State Variables ============ */

    mapping(address => mapping(uint256 => IIntentRiskHook)) internal depositRiskHooks;
    mapping(bytes32 => IIntentRiskHook) internal intentRiskHooks;
    mapping(bytes32 => bool) public override intentRequiresPostIntentHook;
    mapping(bytes32 => uint256) internal intentSettlementAmounts;
    mapping(bytes32 => uint64) internal intentSettlementTimestamps;

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

    /* ============ External Functions ============ */

    /**
     * @notice Signals an intent using the existing V2 data model and then invokes risk admission.
     * @dev The complete intent and hook snapshot are readable during onIntentCreated. Any admission
     *      failure reverts the entire transaction, including escrow locking and stake reservation.
     */
    function signalIntent(
        SignalIntentParams calldata _params
    ) public override(OrchestratorV2, IOrchestratorV2) nonReentrant whenNotPaused {
        // Checks
        _validateSignalIntent(_params);
        _executeHookIfSet(depositPreIntentHooks[_params.escrow][_params.depositId], _params);
        _executeHookIfSet(depositWhitelistHooks[_params.escrow][_params.depositId], _params);

        // Effects
        bytes32 intentHash = _calculateIntentHash();
        IEscrow.Deposit memory deposit = IEscrow(_params.escrow).getDeposit(_params.depositId);
        IEscrow.DepositPaymentMethodData memory depositData = IEscrow(_params.escrow).getDepositPaymentMethodData(
            _params.depositId,
            _params.paymentMethod
        );

        (address managerFeeRecipient, uint256 managerFee) = IEscrowV2(_params.escrow).getManagerFee(_params.depositId);
        if (managerFee > MAX_MANAGER_FEE) revert FeeExceedsMaximum(managerFee, MAX_MANAGER_FEE);
        intentManagerFeeRecipient[intentHash] = managerFeeRecipient;
        intentManagerFee[intentHash] = managerFee;
        intentMinAtSignal[intentHash] = deposit.intentAmountRange.min;

        Intent storage storedIntent = intents[intentHash];
        storedIntent.owner = msg.sender;
        storedIntent.to = _params.to;
        storedIntent.escrow = _params.escrow;
        storedIntent.depositId = _params.depositId;
        storedIntent.amount = _params.amount;
        storedIntent.paymentMethod = _params.paymentMethod;
        storedIntent.fiatCurrency = _params.fiatCurrency;
        storedIntent.conversionRate = _params.conversionRate;
        storedIntent.payeeId = depositData.payeeDetails;
        storedIntent.timestamp = block.timestamp;
        storedIntent.postIntentHook = _params.postIntentHook;
        storedIntent.data = _params.data;

        for (uint256 feeIndex = 0; feeIndex < _params.referralFees.length; feeIndex++) {
            IReferralFee.ReferralFee calldata referralFee = _params.referralFees[feeIndex];
            storedIntent.referralFees.push(
                IReferralFee.ReferralFee({ recipient: referralFee.recipient, fee: referralFee.fee })
            );
        }

        accountIntents[msg.sender].push(intentHash);
        intentCounter++;

        IIntentRiskHook riskHook = depositRiskHooks[_params.escrow][_params.depositId];
        intentRiskHooks[intentHash] = riskHook;

        emit IntentSignaled(
            intentHash,
            _params.escrow,
            _params.depositId,
            _params.paymentMethod,
            msg.sender,
            _params.to,
            _params.amount,
            _params.fiatCurrency,
            _params.conversionRate,
            block.timestamp
        );
        emit IntentManagerFeeSnapshotted(intentHash, managerFeeRecipient, managerFee);

        // Interactions
        bool requiresPostIntentHook = _executeRiskAdmission(riskHook, intentHash);
        intentRequiresPostIntentHook[intentHash] = requiresPostIntentHook;
        emit IntentRiskHookSnapshotted(intentHash, address(riskHook), requiresPostIntentHook);

        IEscrow(_params.escrow).lockFunds(_params.depositId, intentHash, _params.amount);
    }

    /**
     * @notice Cancels an intent and attempts conservative risk cleanup before deleting lifecycle state.
     */
    function cancelIntent(bytes32 _intentHash) public override(OrchestratorV2, IOrchestratorV2) nonReentrant {
        Intent memory intent = intents[_intentHash];
        if (intent.timestamp == 0) revert IntentNotFound(_intentHash);
        if (intent.owner != msg.sender) revert UnauthorizedCaller(msg.sender, intent.owner);

        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        _pruneIntentV3(_intentHash);
        _executeTerminalRiskCallback(
            riskHook,
            _intentHash,
            abi.encodeCall(IIntentRiskHook.onIntentCancelled, (_intentHash)),
            IIntentRiskHook.onIntentCancelled.selector
        );

        IEscrow(intent.escrow).unlockFunds(intent.depositId, _intentHash);
    }

    /**
     * @notice Fulfills a verified intent and records the exact released amount with its snapshotted risk hook.
     */
    function fulfillIntent(
        FulfillIntentParams calldata _params
    ) public override(OrchestratorV2, IOrchestratorV2) nonReentrant whenNotPaused {
        // Checks
        Intent memory intent = intents[_params.intentHash];
        if (intent.paymentMethod == bytes32(0)) revert IntentNotFound(_params.intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        address managerFeeRecipient = intentManagerFeeRecipient[_params.intentHash];
        uint256 managerFee = intentManagerFee[_params.intentHash];

        address verifier = paymentVerifierRegistry.getVerifier(intent.paymentMethod);
        if (verifier == address(0)) revert PaymentMethodDoesNotExist(intent.paymentMethod);

        IPaymentVerifier.PaymentVerificationResult memory verificationResult = IPaymentVerifier(verifier).verifyPayment(
            IPaymentVerifier.VerifyPaymentData({
                intentHash: _params.intentHash,
                paymentProof: _params.paymentProof,
                data: _params.verificationData
            })
        );
        if (!verificationResult.success) revert PaymentVerificationFailed();
        if (verificationResult.intentHash != _params.intentHash) {
            revert HashMismatch(_params.intentHash, verificationResult.intentHash);
        }

        uint256 minAtSignal = intentMinAtSignal[_params.intentHash];
        if (minAtSignal > 0 && verificationResult.releaseAmount < minAtSignal) {
            revert AmountBelowMin(verificationResult.releaseAmount, minAtSignal);
        }

        // Effects and mandatory risk accounting
        _recordIntentSettlement(_params.intentHash, verificationResult.releaseAmount);
        IIntentRiskHook riskHook = intentRiskHooks[_params.intentHash];
        _pruneIntentV3(_params.intentHash);
        _executeTerminalRiskCallback(
            riskHook,
            _params.intentHash,
            abi.encodeCall(
                IIntentRiskHook.onIntentFulfilled,
                (_params.intentHash, verificationResult.releaseAmount)
            ),
            IIntentRiskHook.onIntentFulfilled.selector
        );

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(
            intent.depositId,
            _params.intentHash,
            verificationResult.releaseAmount,
            address(this)
        );

        _collectFeesTransferFundsAndExecuteAction(
            deposit.token,
            _params.intentHash,
            intent,
            verificationResult.releaseAmount,
            _params.postIntentHookData,
            managerFeeRecipient,
            managerFee
        );
    }

    /**
     * @notice Manually releases escrowed funds and enforces a required deferred-payout settlement action.
     */
    function releaseFundsToPayer(bytes32 _intentHash)
        public
        override(OrchestratorV2, IOrchestratorV2)
        nonReentrant
    {
        // Checks
        Intent memory intent = intents[_intentHash];
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        address managerFeeRecipient = intentManagerFeeRecipient[_intentHash];
        uint256 managerFee = intentManagerFee[_intentHash];
        bool requiresPostIntentHook = intentRequiresPostIntentHook[_intentHash];

        // Effects and mandatory risk accounting
        _recordIntentSettlement(_intentHash, intent.amount);
        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        _pruneIntentV3(_intentHash);
        _executeTerminalRiskCallback(
            riskHook,
            _intentHash,
            abi.encodeCall(IIntentRiskHook.onIntentReleased, (_intentHash, intent.amount)),
            IIntentRiskHook.onIntentReleased.selector
        );

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(
            intent.depositId,
            _intentHash,
            intent.amount,
            address(this)
        );

        if (requiresPostIntentHook) {
            _collectFeesAndExecuteRequiredAction(
                deposit.token,
                _intentHash,
                intent,
                intent.amount,
                managerFeeRecipient,
                managerFee
            );
        } else {
            _collectFeesAndTransferFunds(
                deposit.token,
                _intentHash,
                intent,
                intent.amount,
                managerFeeRecipient,
                managerFee
            );
        }
    }

    /* ============ Escrow and Cleanup Functions ============ */

    /**
     * @notice Prunes intents owned by the calling escrow and attempts cancellation risk cleanup.
     */
    function pruneIntents(
        bytes32[] calldata _intentHashes
    ) public override(OrchestratorV2, IOrchestratorV2) {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            bytes32 intentHash = _intentHashes[intentIndex];
            if (intentHash == bytes32(0)) continue;

            Intent memory intent = intents[intentHash];
            if (intent.timestamp == 0 || intent.escrow != msg.sender) continue;

            IIntentRiskHook riskHook = intentRiskHooks[intentHash];
            _pruneIntentV3(intentHash);
            _executeTerminalRiskCallback(
                riskHook,
                intentHash,
                abi.encodeCall(IIntentRiskHook.onIntentCancelled, (intentHash)),
                IIntentRiskHook.onIntentCancelled.selector
            );
        }
    }

    /**
     * @notice Cleans escrow-orphaned intents and conservatively attempts cancellation risk cleanup.
     */
    function cleanupOrphanedIntents(
        bytes32[] calldata _intentHashes
    ) public override(OrchestratorV2, IOrchestratorV2) nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            bytes32 intentHash = _intentHashes[intentIndex];
            Intent memory intent = intents[intentHash];
            if (intent.timestamp == 0) continue;

            IEscrow.Intent memory escrowIntent = IEscrow(intent.escrow).getDepositIntent(
                intent.depositId,
                intentHash
            );
            if (escrowIntent.intentHash != bytes32(0)) continue;

            IIntentRiskHook riskHook = intentRiskHooks[intentHash];
            _pruneIntentV3(intentHash);
            _executeTerminalRiskCallback(
                riskHook,
                intentHash,
                abi.encodeCall(IIntentRiskHook.onIntentCancelled, (intentHash)),
                IIntentRiskHook.onIntentCancelled.selector
            );
        }
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
     * @notice Returns durable settlement data used to reconcile a failed terminal risk callback.
     */
    function getIntentSettlement(
        bytes32 _intentHash
    ) external view override returns (uint256 releasedAmount, uint64 settledAt) {
        return (intentSettlementAmounts[_intentHash], intentSettlementTimestamps[_intentHash]);
    }

    /* ============ Internal Functions ============ */

    function _executeRiskAdmission(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash
    ) internal returns (bool requiresPostIntentHook) {
        if (address(_riskHook) == address(0)) return false;

        (bool success, bytes memory response, uint256 responseSize) = _callRiskHook(
            address(_riskHook),
            abi.encodeCall(IIntentRiskHook.onIntentCreated, (_intentHash))
        );
        if (!success) revert RiskHookAdmissionFailed(_intentHash, address(_riskHook), response);
        if (responseSize != 32) revert InvalidRiskHookResponse(address(_riskHook), response);

        requiresPostIntentHook = abi.decode(response, (bool));
        if (requiresPostIntentHook && address(intents[_intentHash].postIntentHook) == address(0)) {
            revert RequiredPostIntentHookMissing(_intentHash);
        }
    }

    function _executeTerminalRiskCallback(
        IIntentRiskHook _riskHook,
        bytes32 _intentHash,
        bytes memory _callData,
        bytes4 _selector
    ) internal {
        if (address(_riskHook) == address(0)) return;

        (bool success, bytes memory revertData,) = _callRiskHook(address(_riskHook), _callData);
        if (!success) {
            emit RiskHookCallbackFailed(_intentHash, address(_riskHook), _selector, revertData);
        }
    }

    function _recordIntentSettlement(bytes32 _intentHash, uint256 _releasedAmount) internal {
        uint64 settledAt = uint64(block.timestamp);
        intentSettlementAmounts[_intentHash] = _releasedAmount;
        intentSettlementTimestamps[_intentHash] = settledAt;
        emit IntentSettlementRecorded(_intentHash, _releasedAmount, settledAt);
    }

    function _callRiskHook(
        address _riskHook,
        bytes memory _callData
    ) internal returns (bool success, bytes memory returnData, uint256 returnDataSize) {
        uint256 callbackGasLimit = riskCallbackGasLimit;
        uint256 maximumCopySize = MAX_RISK_CALLBACK_RETURN_DATA;

        assembly ("memory-safe") {
            success := call(
                callbackGasLimit,
                _riskHook,
                0,
                add(_callData, 0x20),
                mload(_callData),
                0,
                0
            )
            returnDataSize := returndatasize()

            let copySize := returnDataSize
            if gt(copySize, maximumCopySize) { copySize := maximumCopySize }

            returnData := mload(0x40)
            mstore(returnData, copySize)
            returndatacopy(add(returnData, 0x20), 0, copySize)
            mstore(
                0x40,
                add(add(returnData, 0x20), and(add(copySize, 0x1f), not(0x1f)))
            )
        }
    }

    function _pruneIntentV3(bytes32 _intentHash) internal {
        _pruneIntent(_intentHash);
        delete intentRiskHooks[_intentHash];
        delete intentRequiresPostIntentHook[_intentHash];
    }

    function _collectFeesAndExecuteRequiredAction(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent,
        uint256 _releaseAmount,
        address _managerFeeRecipient,
        uint256 _managerFee
    ) internal {
        if (address(_intent.postIntentHook) == address(0)) revert RequiredPostIntentHookMissing(_intentHash);

        uint256 netFees = _calculateAndTransferFees(
            _token,
            _intentHash,
            _intent,
            _releaseAmount,
            _managerFeeRecipient,
            _managerFee
        );
        uint256 netAmount = _releaseAmount - netFees;
        uint256 preBalance = _token.balanceOf(address(this));

        _token.safeApprove(address(_intent.postIntentHook), 0);
        _token.safeApprove(address(_intent.postIntentHook), netAmount);

        _intent.postIntentHook.execute(
            IPostIntentHookV2.HookExecutionContext({
                intentHash: _intentHash,
                token: address(_token),
                executableAmount: netAmount,
                intent: IPostIntentHookV2.HookIntentContext({
                    owner: _intent.owner,
                    to: _intent.to,
                    escrow: _intent.escrow,
                    depositId: _intent.depositId,
                    amount: _intent.amount,
                    timestamp: _intent.timestamp,
                    paymentMethod: _intent.paymentMethod,
                    fiatCurrency: _intent.fiatCurrency,
                    conversionRate: _intent.conversionRate,
                    payeeId: _intent.payeeId,
                    signalHookData: _intent.data
                })
            }),
            ""
        );

        uint256 postBalance = _token.balanceOf(address(this));
        require(postBalance <= preBalance, "PostIntentHook: unexpected balance increase");
        require(preBalance - postBalance == netAmount, "PostIntentHook: must pull exact netAmount");
        _token.safeApprove(address(_intent.postIntentHook), 0);

        emit IntentFulfilled(_intentHash, address(_intent.postIntentHook), netAmount, true);
    }

    function _setRiskCallbackGasLimit(uint256 _gasLimit) internal {
        if (_gasLimit < MIN_RISK_CALLBACK_GAS_LIMIT) {
            revert RiskCallbackGasLimitTooLow(_gasLimit, MIN_RISK_CALLBACK_GAS_LIMIT);
        }

        riskCallbackGasLimit = _gasLimit;
        emit RiskCallbackGasLimitUpdated(_gasLimit);
    }
}
