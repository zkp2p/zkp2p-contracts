// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { AddressArrayUtils } from "./external/AddressArrayUtils.sol";
import { Bytes32ArrayUtils } from "./external/Bytes32ArrayUtils.sol";
import { IOrchestratorV3 } from "./interfaces/IOrchestratorV3.sol";
import { IReferralFee } from "./interfaces/IReferralFee.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IIntentRiskHook } from "./interfaces/IIntentRiskHook.sol";
import { IPreIntentHook } from "./interfaces/IPreIntentHook.sol";
import { IPaymentVerifier } from "./interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierRegistry } from "./interfaces/IPaymentVerifierRegistry.sol";
import { BoundedCall } from "./lib/BoundedCall.sol";
import { FeeSettlementLib } from "./lib/FeeSettlementLib.sol";
import { ReferralFeeLib } from "./lib/ReferralFeeLib.sol";

/**
 * @title OrchestratorV3
 * @notice Standalone V3 orchestrator for the ZKP2P protocol. Owns the complete intent (order)
 * lifecycle — signal, cancel, fulfill, manual release, prune, orphan cleanup — and extends it
 * with snapshotted governance-selected risk callbacks: fail-closed admission and settlement,
 * fail-open cancellation with durable recovery data.
 */
contract OrchestratorV3 is Ownable, Pausable, ReentrancyGuard, IOrchestratorV3 {

    using AddressArrayUtils for address[];
    using Bytes32ArrayUtils for bytes32[];
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using SignatureChecker for address;

    /* ============ Constants ============ */

    uint256 constant CIRCOM_PRIME_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant MAX_PROTOCOL_FEE = 5e16;      // 5% max protocol fee
    uint256 constant MAX_MANAGER_FEE = 5e16;       // 5% max manager fee

    uint256 internal constant MIN_RISK_CALLBACK_GAS_LIMIT = 750_000;
    uint256 internal constant MAX_RISK_CALLBACK_RETURN_DATA = 2_048;

    /* ============ State Variables ============ */

    uint256 immutable public chainId;              // chainId of the chain the orchestrator is deployed on

    mapping(bytes32 => Intent) internal intents;                       // Mapping of intentHashes to intent structs
    mapping(address => bytes32[]) internal accountIntents;             // Mapping of address to array of intentHashes

    // Snapshot of the minimum per-intent amount at the time of lock (signal)
    // Used to prevent fulfillments that pay out less than the deposit's min intent amount.
    mapping(bytes32 => uint256) internal intentMinAtSignal;

    // Snapshot of per-intent manager fee terms at the time of signal
    mapping(bytes32 => address) internal intentManagerFeeRecipient;
    mapping(bytes32 => uint256) internal intentManagerFee;

    // Optional pre-intent hooks configured per escrow + depositId.
    mapping(address => mapping(uint256 => IPreIntentHook)) internal depositPreIntentHooks;

    // Governance-selected risk hook; snapshotted per intent at signal.
    IIntentRiskHook public riskHook;
    mapping(bytes32 => IIntentRiskHook) internal intentRiskHooks;
    mapping(bytes32 => IntentCancellation) internal failedIntentCancellations;
    mapping(bytes32 => bool) public usedGatingSignatureDigests;

    // Contract references
    IEscrowRegistry public escrowRegistry;                              // Registry of escrow contracts
    IPaymentVerifierRegistry public  paymentVerifierRegistry;          // Registry of payment verifiers

    // Protocol fee configuration
    uint256 public protocolFee;                                     // Protocol fee taken from taker (in preciseUnits, 1e16 = 1%)
    address public protocolFeeRecipient;                            // Address that receives protocol fees

    uint256 public intentCounter;                                 // Counter for number of intents created; nonce for unique intent hashes

    uint256 public riskCallbackGasLimit;                          // Gas forwarded to each risk callback

    /* ============ Constructor ============ */

    /**
     * @notice Creates a V3 orchestrator with risk-managed intent admission.
     * @param _owner Governance owner.
     * @param _chainId Chain identifier used by intent gating signature validation.
     * @param _escrowRegistry Registry of accepted escrow contracts.
     * @param _paymentVerifierRegistry Registry of payment proof verifiers.
     * @param _protocolFee Protocol fee in 1e18 precise units.
     * @param _protocolFeeRecipient Protocol fee recipient.
     * @param _riskCallbackGasLimit Gas forwarded to each risk callback.
     */
    constructor(
        address _owner,
        uint256 _chainId,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient,
        uint256 _riskCallbackGasLimit
    )
        Ownable()
    {
        chainId = _chainId;
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        protocolFee = _protocolFee;
        protocolFeeRecipient = _protocolFeeRecipient;

        transferOwnership(_owner);

        _setRiskCallbackGasLimit(_riskCallbackGasLimit);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Signals intent to pay the depositor defined in the _depositId the _amount * deposit conversionRate off-chain at
     * their given _payeeId in order to unlock _amount of funds on-chain. Caller must provide a signature from the deposit's gating
     * service to prove their eligibility to take liquidity. This function captures and stores all values required for fullfilling
     * the intent to give strong guarantees to the buyer. Snapshots the global risk hook and executes fail-closed risk
     * admission before locking liquidity for the corresponding deposit on the escrow contract.
     *
     * @param _params                   Struct containing all the intent parameters
     */
    function signalIntent(SignalIntentParams calldata _params)
        external
        nonReentrant
        whenNotPaused
    {
        // Checks
        _validateSignalIntent(_params);
        _executeHookIfSet(depositPreIntentHooks[_params.escrow][_params.depositId], _params);

        // Effects
        bytes32 intentHash = _calculateIntentHash();
        IEscrow.Deposit memory dep = IEscrow(_params.escrow).getDeposit(_params.depositId);
        IEscrow.DepositPaymentMethodData memory depData = IEscrow(_params.escrow).getDepositPaymentMethodData(
            _params.depositId,
            _params.paymentMethod
        );

        (address managerFeeRecipient, uint256 managerFee) = IEscrowV2(_params.escrow).getManagerFee(_params.depositId);
        // Enforce manager fee cap regardless of registry implementation
        if (managerFee > MAX_MANAGER_FEE) revert FeeExceedsMaximum(managerFee, MAX_MANAGER_FEE);  // policy cap (e.g., 5%)
        intentManagerFeeRecipient[intentHash] = managerFeeRecipient;
        intentManagerFee[intentHash] = managerFee;

        intentMinAtSignal[intentHash] = dep.intentAmountRange.min;
        Intent storage storedIntent = intents[intentHash];
        storedIntent.owner = msg.sender;
        storedIntent.to = _params.to;
        storedIntent.escrow = _params.escrow;
        storedIntent.depositId = _params.depositId;
        storedIntent.amount = _params.amount;
        storedIntent.paymentMethod = _params.paymentMethod;
        storedIntent.fiatCurrency = _params.fiatCurrency;
        storedIntent.conversionRate = _params.conversionRate;
        storedIntent.payeeId = depData.payeeDetails;
        storedIntent.timestamp = block.timestamp;
        storedIntent.postIntentHook = _params.postIntentHook;
        storedIntent.data = _params.data;

        for (uint256 i = 0; i < _params.referralFees.length; ++i) {
            IReferralFee.ReferralFee calldata referralFee = _params.referralFees[i];
            storedIntent.referralFees.push(
                IReferralFee.ReferralFee({
                    recipient: referralFee.recipient,
                    fee: referralFee.fee
                })
            );
        }

        accountIntents[msg.sender].push(intentHash);
        intentCounter++;

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

        // Emit manager fee snapshot last for easier indexing
        emit IntentManagerFeeSnapshotted(intentHash, managerFeeRecipient, managerFee);

        // Snapshot and execute fail-closed risk admission for the global risk hook.
        IIntentRiskHook snapshottedRiskHook = riskHook;
        intentRiskHooks[intentHash] = snapshottedRiskHook;

        BoundedCall.executeRiskAdmission(
            snapshottedRiskHook,
            intentHash,
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        emit IntentRiskHookSnapshotted(intentHash, address(snapshottedRiskHook));

        // Interactions
        IEscrow(_params.escrow).lockFunds(_params.depositId, intentHash, _params.amount);
    }

    /**
     * @notice Only callable by the originator of the intent. Cancels an outstanding intent. Unlocks liquidity
     * for the corresponding deposit on the escrow contract.
     * @dev Guarded because cancellation invokes an external risk callback during resolution.
     *
     * @param _intentHash    Hash of intent being cancelled
     */
    function cancelIntent(bytes32 _intentHash) external nonReentrant {
        // Checks
        Intent memory intent = intents[_intentHash];

        if (intent.timestamp == 0) revert IntentNotFound(_intentHash);
        if (intent.owner != msg.sender) revert UnauthorizedCaller(msg.sender, intent.owner);

        // Effects
        _resolveCancelledIntent(_intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockFunds(intent.depositId, _intentHash);
    }

    /**
     * @notice Sets or removes the pre-intent hook for a specific deposit.
     * @dev Callable only by the deposit's depositor or delegate.
     *
     * @param _escrow       Escrow address.
     * @param _depositId    Deposit id.
     * @param _hook         Hook address (address(0) to remove).
     */
    function setDepositPreIntentHook(address _escrow, uint256 _depositId, IPreIntentHook _hook) external nonReentrant {
        _validateAndAuthorizeHookSetter(_escrow, _depositId, _hook);

        depositPreIntentHooks[_escrow][_depositId] = _hook;

        emit DepositPreIntentHookSet(_escrow, _depositId, address(_hook), msg.sender);
    }

    /**
     * @notice Anyone can submit a fulfill intent transaction, even if caller isn't the intent owner. Upon submission the
     * offchain payment proof is verified, payment details are validated, intent is removed, and escrow state is updated.
     * Settlement gives the snapshotted risk hook first refusal over gross funds, then executes the exact fee plan and
     * transfers the deposit token to the intent.to address (or post-intent hook).
     * @dev This function adds a reentrancy guard as it's calling the post intent hook contract which itself might call
     * malicious contracts.
     *
     * @param _params               Struct containing all the fulfill intent parameters
     */
    function fulfillIntent(FulfillIntentParams calldata _params) external nonReentrant whenNotPaused {
        // Checks
        Intent memory intent = intents[_params.intentHash];
        if (intent.paymentMethod == bytes32(0)) revert IntentNotFound(_params.intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);

        // Snapshot manager fee terms before pruning (pruning deletes the mappings).
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
        if (verificationResult.intentHash != _params.intentHash) revert HashMismatch(_params.intentHash, verificationResult.intentHash);

        // Enforce snapshot min-at-signal to prevent sub-min partial fulfillments
        uint256 minAtSignal = intentMinAtSignal[_params.intentHash];
        if (minAtSignal > 0 && verificationResult.releaseAmount < minAtSignal) {
            revert AmountBelowMin(verificationResult.releaseAmount, minAtSignal);
        }

        // Effects
        _pruneIntent(_params.intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(intent.depositId, _params.intentHash, verificationResult.releaseAmount, address(this));

        _collectFeesTransferFundsAndExecuteAction(
            deposit.token,
            _params.intentHash,
            intent,
            verificationResult.releaseAmount,
            _params.postIntentHookData,
            managerFeeRecipient,
            managerFee,
            false
        );
    }

    /**
     * @notice Allows depositor to release funds to the payer in case of a failed fulfill intent or because of some other arrangement
     * between the two parties. Upon submission we check to make sure the msg.sender is the depositor, the intent is removed, and
     * escrow state is updated. Manual release routes through the shared post-funds risk-settlement gate, then executes the
     * configured post-intent hook or transfers the deposit token directly to the payer when no hook is configured.
     *
     * @param _intentHash        Hash of intent to resolve by releasing the funds
     */
    function releaseFundsToPayer(bytes32 _intentHash) external nonReentrant {
        // Checks
        Intent memory intent = intents[_intentHash];
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        // Snapshot manager fee terms before pruning (pruning deletes the mappings).
        address managerFeeRecipient = intentManagerFeeRecipient[_intentHash];
        uint256 managerFee = intentManagerFee[_intentHash];

        // Effects
        _pruneIntent(_intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(intent.depositId, _intentHash, intent.amount, address(this));

        _collectFeesTransferFundsAndExecuteAction(
            deposit.token,
            _intentHash,
            intent,
            intent.amount,
            "",
            managerFeeRecipient,
            managerFee,
            true
        );
    }

    /* ============ Escrow Functions ============ */

    /**
     * @notice Only the escrow contract owns the intent can call this function. Called by escrow to prune specific
     * expired intents. Escrow leads the cleanup process.
     *
     * @param _intents   Array of intent hashes to prune
     */
    function pruneIntents(bytes32[] calldata _intents) external {
        for (uint256 i = 0; i < _intents.length; i++) {
            bytes32 intentHash = _intents[i];
            if (intentHash != bytes32(0)) {
                Intent memory intent = intents[intentHash];
                if (
                    intent.timestamp != 0 && // Only prune if intent exists on this contract; otherwise skip
                    intent.escrow == msg.sender // Ensure only the escrow that owns the intent can prune it; otherwise skip
                ) {
                    _resolveCancelledIntent(intentHash);
                }
            }
        }
    }

    /* ============ Anyone callable (External Functions) ============ */

    /**
     * @notice ANYONE: Cleans up orphaned intents that were pruned from the Escrow but not from the Orchestrator.
     * An intent is considered orphaned if it exists on the Orchestrator but no longer exists on the Escrow.
     * This can happen when Escrow._tryOrchestratorPruneIntents runs out of gas and the revert is silently caught.
     * @dev Guarded because cleanup invokes an external risk callback during resolution.
     *
     * @param _intentHashes    Array of intent hashes to check and clean up
     */
    function cleanupOrphanedIntents(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 i = 0; i < _intentHashes.length; i++) {
            bytes32 intentHash = _intentHashes[i];
            Intent memory intent = intents[intentHash];

            // Skip if intent doesn't exist on orchestrator
            if (intent.timestamp == 0) continue;

            // Check if intent still exists on the escrow
            IEscrow.Intent memory escrowIntent = IEscrow(intent.escrow).getDepositIntent(
                intent.depositId,
                intentHash
            );

            // If intent doesn't exist on escrow, it's orphaned — prune it
            if (escrowIntent.intentHash == bytes32(0)) {
                _resolveCancelledIntent(intentHash);
            }
        }
    }

    /**
     * @notice Only the exact snapshotted hook whose callback failed may clear its recovery record.
     *
     * @param _intentHash    Hash of the cancelled intent being reconciled
     */
    function acknowledgeIntentCancellation(bytes32 _intentHash) external {
        IntentCancellation memory cancellation = failedIntentCancellations[_intentHash];
        if (cancellation.cancelledAt == 0) revert IntentCancellationNotRecorded(_intentHash);
        if (msg.sender != address(cancellation.riskHook)) {
            revert UnauthorizedCancellationAcknowledger(msg.sender, address(cancellation.riskHook));
        }

        delete failedIntentCancellations[_intentHash];
        emit IntentCancellationReconciled(_intentHash, msg.sender);
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Updates the global risk hook used by future intents.
     *
     * @param _hook   New risk hook (address(0) to disable)
     */
    function setRiskHook(IIntentRiskHook _hook) external onlyOwner {
        address hookAddress = address(_hook);
        if (hookAddress != address(0) && hookAddress.code.length == 0) {
            revert InvalidRiskHook(hookAddress);
        }

        IIntentRiskHook oldHook = riskHook;
        emit RiskHookUpdated(address(oldHook), hookAddress);
        riskHook = _hook;
    }

    /**
     * @notice GOVERNANCE ONLY: Updates the escrow registry address.
     *
     * @param _escrowRegistry   New escrow registry address
     */
    function setEscrowRegistry(address _escrowRegistry) external onlyOwner {
        if (_escrowRegistry == address(0)) revert ZeroAddress();

        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        emit EscrowRegistryUpdated(_escrowRegistry);
    }

    /**
     * @notice GOVERNANCE ONLY: Updates the protocol fee. This fee is charged to takers upon a successful
     * fulfillment of an intent.
     *
     * @param _protocolFee   New protocol fee in preciseUnits (1e16 = 1%)
     */
    function setProtocolFee(uint256 _protocolFee) external onlyOwner {
        if (_protocolFee > MAX_PROTOCOL_FEE) revert FeeExceedsMaximum(_protocolFee, MAX_PROTOCOL_FEE);

        protocolFee = _protocolFee;
        emit ProtocolFeeUpdated(_protocolFee);
    }

    /**
     * @notice GOVERNANCE ONLY: Updates the protocol fee recipient address.
     *
     * @param _protocolFeeRecipient   New protocol fee recipient address
     */
    function setProtocolFeeRecipient(address _protocolFeeRecipient) external onlyOwner {
        if (_protocolFeeRecipient == address(0)) revert ZeroAddress();

        protocolFeeRecipient = _protocolFeeRecipient;
        emit ProtocolFeeRecipientUpdated(_protocolFeeRecipient);
    }

    /**
     * @notice GOVERNANCE ONLY: Updates gas forwarded to admission and terminal risk callbacks.
     *
     * @param _gasLimit   New per-callback gas allowance
     */
    function setRiskCallbackGasLimit(uint256 _gasLimit) external onlyOwner {
        _setRiskCallbackGasLimit(_gasLimit);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses intent creation and fulfillment functionality.
     *
     * Functionalities that are paused:
     * - Intent creation (signalIntent)
     * - Intent fulfillment (fulfillIntent)
     *
     * Functionalities that remain unpaused to allow users to recover funds:
     * - Intent cancellation (cancelIntent)
     * - Manual fund release by depositor (releaseFundsToPayer)
     * - Intent pruning by escrow (pruneIntents)
     * - All governance functions
     * - All view functions
     */
    function pauseOrchestrator() external onlyOwner {
        _pause();
    }

    /**
     * @notice GOVERNANCE ONLY: Restarts paused functionality for the orchestrator.
     */
    function unpauseOrchestrator() external onlyOwner {
        _unpause();
    }

    /* ============ External View Functions ============ */

    function getIntent(bytes32 _intentHash) external view returns (Intent memory) {
        return intents[_intentHash];
    }

    function getAccountIntents(address _account) external view returns (bytes32[] memory) {
        return accountIntents[_account];
    }

    function getDepositPreIntentHook(address _escrow, uint256 _depositId) external view returns (IPreIntentHook) {
        return depositPreIntentHooks[_escrow][_depositId];
    }

    function getIntentMinAtSignal(bytes32 _intentHash) external view returns (uint256) {
        return intentMinAtSignal[_intentHash];
    }

    /**
     * @notice Returns the immutable hook snapshot for an active intent.
     */
    function getIntentRiskHook(bytes32 _intentHash) external view returns (IIntentRiskHook) {
        return intentRiskHooks[_intentHash];
    }

    /**
     * @notice Returns the scalar intent fields required by a risk hook without copying dynamic intent data.
     */
    function getRiskIntent(bytes32 _intentHash) external view returns (RiskIntentData memory riskIntent) {
        Intent storage intent = intents[_intentHash];
        riskIntent = RiskIntentData({
            owner: intent.owner,
            to: intent.to,
            escrow: intent.escrow,
            depositId: intent.depositId,
            amount: intent.amount,
            paymentMethod: intent.paymentMethod,
            createdAt: uint64(intent.timestamp)
        });
    }

    /**
     * @notice Returns the liquidity-unlock timestamp for a cancellation callback that failed open.
     */
    function getIntentCancellation(bytes32 _intentHash) external view returns (uint64 cancelledAt) {
        return failedIntentCancellations[_intentHash].cancelledAt;
    }

    /* ============ Internal Functions ============ */

    /**
     * @notice Resolves a cancelled (cancel / escrow prune / orphan cleanup) intent: prunes state, then
     * executes the fail-open cancellation callback on the snapshotted risk hook. A failed callback records
     * durable recovery data keyed by the cancellation timestamp so the hook can reconcile later.
     */
    function _resolveCancelledIntent(bytes32 _intentHash) internal {
        uint64 cancelledAt = uint64(block.timestamp);
        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        _pruneIntent(_intentHash);
        delete intentRiskHooks[_intentHash];

        bool callbackSucceeded = BoundedCall.executeRiskCancellation(
            riskHook,
            _intentHash,
            riskCallbackGasLimit,
            MAX_RISK_CALLBACK_RETURN_DATA
        );
        if (!callbackSucceeded) {
            failedIntentCancellations[_intentHash] = IntentCancellation({
                cancelledAt: cancelledAt,
                riskHook: riskHook
            });
            emit IntentCancellationRecorded(_intentHash, cancelledAt);
        }
    }

    /**
     * @notice Validates an intent before it is signaled.
     */
    function _validateSignalIntent(SignalIntentParams calldata _intent) internal {
        if (_intent.to == address(0)) revert ZeroAddress();

        ReferralFeeLib.validateReferralFees(_intent.referralFees);

        if (address(_intent.postIntentHook) != address(0)) {
            if (address(_intent.postIntentHook).code.length == 0) {
                revert InvalidPostIntentHook(address(_intent.postIntentHook));
            }
        }

        // Validate escrow is whitelisted
        if (!escrowRegistry.isWhitelistedEscrow(_intent.escrow) && !escrowRegistry.isAcceptingAllEscrows()) {
            revert EscrowNotWhitelisted(_intent.escrow);
        }

        // Verify payment method is still valid in registry
        address verifier = paymentVerifierRegistry.getVerifier(_intent.paymentMethod);
        if (verifier == address(0)) revert PaymentMethodDoesNotExist(_intent.paymentMethod);

        bool isPaymentMethodActive = IEscrow(_intent.escrow).getDepositPaymentMethodActive(_intent.depositId, _intent.paymentMethod);
        if (!isPaymentMethodActive) revert PaymentMethodNotSupported(_intent.paymentMethod);

        uint256 minConversionRate = IEscrowV2(_intent.escrow).getEffectiveRate(
            _intent.depositId,
            _intent.paymentMethod,
            _intent.fiatCurrency
        );
        if (minConversionRate == 0) revert CurrencyNotSupported(_intent.paymentMethod, _intent.fiatCurrency);
        if (_intent.conversionRate < minConversionRate) revert RateBelowMinimum(_intent.conversionRate, minConversionRate);

        address intentGatingService = IEscrow(_intent.escrow).getDepositGatingService(_intent.depositId, _intent.paymentMethod);
        if (intentGatingService != address(0)) {
            // Check if signature has expired
            if (block.timestamp > _intent.signatureExpiration) {
                revert SignatureExpired(_intent.signatureExpiration, block.timestamp);
            }

            bytes32 verifierPayload = _getIntentGatingSignatureDigest(_intent, msg.sender);
            if (!_isValidIntentGatingSignature(_intent, intentGatingService, verifierPayload)) {
                revert InvalidSignature();
            }

            if (usedGatingSignatureDigests[verifierPayload]) {
                revert GatingSignatureAlreadyUsed(verifierPayload);
            }
            usedGatingSignatureDigests[verifierPayload] = true;
        }
    }

    /**
     * @notice Validates hook address and authorizes the caller as depositor or delegate.
     * @dev Validation for setDepositPreIntentHook.
     */
    function _validateAndAuthorizeHookSetter(address _escrow, uint256 _depositId, IPreIntentHook _hook) internal view {
        if (_escrow == address(0)) revert ZeroAddress();

        address hookAddress = address(_hook);
        if (hookAddress != address(0) && hookAddress.code.length == 0) {
            revert InvalidPreIntentHook(hookAddress);
        }

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }
    }

    /**
     * @notice Executes a pre-intent hook if the address is non-zero.
     * @dev Executes the deposit's configured pre-intent hook.
     */
    function _executeHookIfSet(IPreIntentHook _hook, SignalIntentParams calldata _params) internal {
        if (address(_hook) == address(0)) return;

        _hook.validateSignalIntent(
            IPreIntentHook.PreIntentContext({
                taker: msg.sender,
                escrow: _params.escrow,
                depositId: _params.depositId,
                amount: _params.amount,
                to: _params.to,
                paymentMethod: _params.paymentMethod,
                fiatCurrency: _params.fiatCurrency,
                conversionRate: _params.conversionRate,
                referralFees: _params.referralFees,
                preIntentHookData: _params.preIntentHookData
            })
        );
    }

    /**
     * @notice Calculates a unique hash for an intent using the orchestrator address and counter.
     */
    function _calculateIntentHash() internal view returns (bytes32 intentHash) {
        // Use orchestrator address + counter for global uniqueness
        // Mod with circom prime field to make sure it fits in a 254-bit field
        uint256 intermediateHash = uint256(
            keccak256(
                abi.encodePacked(
                    address(this),    // Include orchestrator address for avoiding collisions when migrating to a new orchestrator
                    // or when multiple orchestrators are deployed
                    intentCounter     // unique counter within this orchestrator
                )
            ));
        intentHash = bytes32(intermediateHash % CIRCOM_PRIME_FIELD);
    }


    /**
     * @notice Deletes an intent from storage mappings.
     */
    function _pruneIntent(bytes32 _intentHash) internal {
        Intent memory intent = intents[_intentHash];

        accountIntents[intent.owner].removeStorage(_intentHash);
        delete intents[_intentHash];
        delete intentMinAtSignal[_intentHash];
        delete intentManagerFeeRecipient[_intentHash];
        delete intentManagerFee[_intentHash];

        emit IntentPruned(_intentHash);
    }

    /** @notice Gives risk settlement first refusal over gross funds, then executes the exact fee plan on zero consumption. */
    function _collectFeesTransferFundsAndExecuteAction(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _postIntentHookData,
        address _managerFeeRecipient,
        uint256 _managerFee,
        bool _isManualRelease
    ) internal {
        IIntentRiskHook riskHook = intentRiskHooks[_intentHash];
        (address fundsTransferredTo, uint256 reportedAmount) = FeeSettlementLib.executeSettlement(
            _token,
            riskHook,
            _intentHash,
            _intent,
            _releaseAmount,
            _postIntentHookData,
            FeeSettlementLib.FeeConfig({
                protocolFeeRecipient: protocolFeeRecipient,
                protocolFee: protocolFee,
                managerFeeRecipient: _managerFeeRecipient,
                managerFee: _managerFee
            }),
            _isManualRelease,
            riskCallbackGasLimit
        );
        delete intentRiskHooks[_intentHash];

        emit IntentFulfilled(_intentHash, fundsTransferredTo, reportedAmount, _isManualRelease);
    }

    function _setRiskCallbackGasLimit(uint256 _gasLimit) internal {
        if (_gasLimit < MIN_RISK_CALLBACK_GAS_LIMIT) {
            revert RiskCallbackGasLimitTooLow(_gasLimit, MIN_RISK_CALLBACK_GAS_LIMIT);
        }

        riskCallbackGasLimit = _gasLimit;
        emit RiskCallbackGasLimitUpdated(_gasLimit);
    }

    /**
     * @notice Checks if a intent gating service signature is valid.
     */
    function _isValidIntentGatingSignature(
        SignalIntentParams calldata _intent,
        address _intentGatingService,
        bytes32 _verifierPayload
    )
        internal
        view
        returns(bool)
    {
        return _intentGatingService.isValidSignatureNow(_verifierPayload, _intent.gatingServiceSignature);
    }

    function _getIntentGatingSignatureDigest(
        SignalIntentParams calldata _intent,
        address _caller
    )
        internal
        view
        returns(bytes32)
    {
        bytes memory message = abi.encodePacked(
            address(this),
            _intent.escrow,
            _intent.depositId,
            _intent.amount,
            _caller,
            _intent.to,
            _intent.paymentMethod,
            _intent.fiatCurrency,
            _intent.conversionRate,
            ReferralFeeLib.hashReferralFees(_intent.referralFees),
            address(_intent.postIntentHook),
            keccak256(_intent.data),
            _intent.signatureExpiration,
            chainId
        );

        return keccak256(message).toEthSignedMessageHash();
    }
}
