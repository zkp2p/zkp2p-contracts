//SPDX-License-Identifier: MIT

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
import { IOrchestratorV2 } from "./interfaces/IOrchestratorV2.sol";
import { IReferralFee } from "./interfaces/IReferralFee.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IPostIntentHookV2 } from "./interfaces/IPostIntentHookV2.sol";
import { IPreIntentHook } from "./interfaces/IPreIntentHook.sol";
import { IPaymentVerifier } from "./interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierRegistry } from "./interfaces/IPaymentVerifierRegistry.sol";
import { IRelayerRegistry } from "./interfaces/IRelayerRegistry.sol";
import { ReferralFeeLib } from "./lib/ReferralFeeLib.sol";

/**
 * @title OrchestratorV2
 * @notice Orchestrator contract for the ZKP2P protocol. This contract is responsible for managing the intent (order) 
 * lifecycle and orchestrating the P2P trading of fiat currency and onchain assets.
 */
contract OrchestratorV2 is Ownable, Pausable, ReentrancyGuard, IOrchestratorV2 {

    using AddressArrayUtils for address[];
    using Bytes32ArrayUtils for bytes32[];
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using SignatureChecker for address;


    /* ============ Constants ============ */
    uint256 internal constant PRECISE_UNIT = 1e18;
    uint256 constant CIRCOM_PRIME_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant MAX_PROTOCOL_FEE = 5e16;      // 5% max protocol fee
    uint256 constant MAX_MANAGER_FEE = 5e16;       // 5% max manager fee

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

    // Dedicated whitelist hooks configured per escrow + depositId.
    mapping(address => mapping(uint256 => IPreIntentHook)) internal depositWhitelistHooks;

    // Contract references
    IEscrowRegistry public escrowRegistry;                              // Registry of escrow contracts
    IPaymentVerifierRegistry public  paymentVerifierRegistry;          // Registry of payment verifiers
    IRelayerRegistry public relayerRegistry;                           // Registry of relayers

    // Protocol fee configuration
    uint256 public protocolFee;                                     // Protocol fee taken from taker (in preciseUnits, 1e16 = 1%)
    address public protocolFeeRecipient;                            // Address that receives protocol fees

    bool public allowMultipleIntents;                               // Whether to allow multiple intents per account

    uint256 public intentCounter;                                 // Counter for number of intents created; nonce for unique intent hashes

    /* ============ Constructor ============ */
    constructor(
        address _owner,
        uint256 _chainId,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        address _relayerRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient
    )
        Ownable()
    {
        chainId = _chainId;
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        protocolFee = _protocolFee;
        protocolFeeRecipient = _protocolFeeRecipient;

        transferOwnership(_owner);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Signals intent to pay the depositor defined in the _depositId the _amount * deposit conversionRate off-chain at 
     * their given _payeeId in order to unlock _amount of funds on-chain. Caller must provide a signature from the deposit's gating
     * service to prove their eligibility to take liquidity. This function captures and stores all values required for fullfilling
     * the intent to give strong guarantees to the buyer. Locks liquidity for the corresponding deposit on the escrow contract.
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
        _executeHookIfSet(depositWhitelistHooks[_params.escrow][_params.depositId], _params);

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

        // Interactions
        IEscrow(_params.escrow).lockFunds(_params.depositId, intentHash, _params.amount);
    }

    /**
     * @notice Only callable by the originator of the intent. Cancels an outstanding intent. Unlocks liquidity
     * for the corresponding deposit on the escrow contract.
     *
     * @param _intentHash    Hash of intent being cancelled
     */
    function cancelIntent(bytes32 _intentHash) external {
        // Checks
        Intent memory intent = intents[_intentHash];
        
        if (intent.timestamp == 0) revert IntentNotFound(_intentHash);
        if (intent.owner != msg.sender) revert UnauthorizedCaller(msg.sender, intent.owner);

        // Effects
        _pruneIntent(_intentHash);

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
     * @notice Sets or removes the whitelist hook for a specific deposit.
     * @dev Callable only by the deposit's depositor or delegate. The whitelist hook is a
     * dedicated slot separate from the generic pre-intent hook, enabling private orderbook
     * functionality without occupying the generic hook slot.
     *
     * @param _escrow       Escrow address.
     * @param _depositId    Deposit id.
     * @param _hook         Hook address (address(0) to remove).
     */
    function setDepositWhitelistHook(address _escrow, uint256 _depositId, IPreIntentHook _hook) external nonReentrant {
        _validateAndAuthorizeHookSetter(_escrow, _depositId, _hook);

        depositWhitelistHooks[_escrow][_depositId] = _hook;

        emit DepositWhitelistHookSet(_escrow, _depositId, address(_hook), msg.sender);
    }

    /**
     * @notice Anyone can submit a fulfill intent transaction, even if caller isn't the intent owner. Upon submission the
     * offchain payment proof is verified, payment details are validated, intent is removed, and escrow state is updated.
     * Deposit token is transferred to the intent.to address.
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
            managerFee
        );
    }

    /**
     * @notice Allows depositor to release funds to the payer in case of a failed fulfill intent or because of some other arrangement
     * between the two parties. Upon submission we check to make sure the msg.sender is the depositor, the intent is removed, and 
     * escrow state is updated. Deposit token is transferred to the payer.
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

        _collectFeesAndTransferFunds(deposit.token, _intentHash, intent, intent.amount, managerFeeRecipient, managerFee);
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
                    _pruneIntent(intentHash);
                }
            }
        }
    }

    /* ============ Anyone callable (External Functions) ============ */

    /**
     * @notice ANYONE: Cleans up orphaned intents that were pruned from the Escrow but not from the Orchestrator.
     * An intent is considered orphaned if it exists on the Orchestrator but no longer exists on the Escrow.
     * This can happen when Escrow._tryOrchestratorPruneIntents runs out of gas and the revert is silently caught.
     *
     * @param _intentHashes    Array of intent hashes to check and clean up
     */
    function cleanupOrphanedIntents(bytes32[] calldata _intentHashes) external {
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
                _pruneIntent(intentHash);
            }
        }
    }

    /* ============ Governance Functions ============ */

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
     * @notice GOVERNANCE ONLY: Sets whether all accounts can signal multiple intents.
     *
     * @param _allowMultiple   True to allow all accounts to signal multiple intents, false to restrict to whitelisted relayers only
     */
    function setAllowMultipleIntents(bool _allowMultiple) external onlyOwner {
        allowMultipleIntents = _allowMultiple;
        
        emit AllowMultipleIntentsUpdated(_allowMultiple);
    }

    /**
     * @notice GOVERNANCE ONLY: Updates the relayer registry address.
     *
     * @param _relayerRegistry   New relayer registry address
     */
    function setRelayerRegistry(address _relayerRegistry) external onlyOwner {
        if (_relayerRegistry == address(0)) revert ZeroAddress();
        
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        emit RelayerRegistryUpdated(_relayerRegistry);
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

    function getDepositWhitelistHook(address _escrow, uint256 _depositId) external view returns (IPreIntentHook) {
        return depositWhitelistHooks[_escrow][_depositId];
    }

    function getIntentMinAtSignal(bytes32 _intentHash) external view returns (uint256) {
        return intentMinAtSignal[_intentHash];
    }

    /* ============ Internal Functions ============ */

    /**
     * @notice Validates an intent before it is signaled.
     */
    function _validateSignalIntent(SignalIntentParams calldata _intent) internal view {
        // Check if account can have multiple intents
        bool canHaveMultipleIntents = relayerRegistry.isWhitelistedRelayer(msg.sender) || allowMultipleIntents;
        if (!canHaveMultipleIntents && accountIntents[msg.sender].length > 0) {
            revert AccountHasActiveIntent(msg.sender, accountIntents[msg.sender][0]);
        }

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

            if (!_isValidIntentGatingSignature(_intent, intentGatingService, msg.sender)) {
                revert InvalidSignature();
            }
        }
    }

    /**
     * @notice Validates hook address and authorizes the caller as depositor or delegate.
     * @dev Shared validation for setDepositPreIntentHook and setDepositWhitelistHook.
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
     * @dev Shared by both the generic pre-intent hook and the dedicated whitelist hook.
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

    /**
     * @notice Calculates and transfers fees to the protocol fee recipient and referrer.
     */
    function _calculateAndTransferFees(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent, 
        uint256 _releaseAmount,
        address _managerFeeRecipient,
        uint256 _managerFee
    ) internal returns (uint256 netFees) {
        uint256 protocolFeeAmount;
        uint256 referralFeeAmount;
        uint256 managerFeeAmount;

        // Calculate protocol fee (taken from taker) - based on release amount
        if (protocolFeeRecipient != address(0) && protocolFee > 0) {
            protocolFeeAmount = (_releaseAmount * protocolFee) / PRECISE_UNIT;
            _token.safeTransfer(protocolFeeRecipient, protocolFeeAmount);
        }
        
        // Calculate referral fees (taken from taker) - based on release amount
        for (uint256 i = 0; i < _intent.referralFees.length; ++i) {
            IReferralFee.ReferralFee memory referralFee = _intent.referralFees[i];
            uint256 feeAmount = (_releaseAmount * referralFee.fee) / PRECISE_UNIT;
            referralFeeAmount += feeAmount;
            _token.safeTransfer(referralFee.recipient, feeAmount);
            emit IntentReferralFeeDistributed(_intentHash, referralFee.recipient, feeAmount);
        }

        // Calculate manager fee (taken from taker) - based on release amount
        if (_managerFeeRecipient != address(0) && _managerFee > 0) {
            managerFeeAmount = (_releaseAmount * _managerFee) / PRECISE_UNIT;
            _token.safeTransfer(_managerFeeRecipient, managerFeeAmount);
        }

        netFees = protocolFeeAmount + referralFeeAmount + managerFeeAmount;
    }

    /**
     * @notice Transfers funds to the intent recipient. Called by manual release.
     */
    function _collectFeesAndTransferFunds(
        IERC20 _token, 
        bytes32 _intentHash, 
        Intent memory _intent,
        uint256 _releaseAmount,
        address _managerFeeRecipient,
        uint256 _managerFee
    ) internal {
        uint256 netFees = _calculateAndTransferFees(
            _token,
            _intentHash,
            _intent,
            _releaseAmount,
            _managerFeeRecipient,
            _managerFee
        );
        uint256 netAmount = _releaseAmount - netFees;

        _token.safeTransfer(_intent.to, netAmount);

        emit IntentFulfilled(
            _intentHash, 
            _intent.to, 
            netAmount, 
            true
        );
    }

    /**
     * @notice Handles fee calculations and transfers, then executes any post-intent hooks if present. Called by fulfillIntent.
     */
    function _collectFeesTransferFundsAndExecuteAction(
        IERC20 _token, 
        bytes32 _intentHash, 
        Intent memory _intent, 
        uint256 _releaseAmount,
        bytes memory _postIntentHookData,
        address _managerFeeRecipient,
        uint256 _managerFee
    ) internal {
        uint256 netFees = _calculateAndTransferFees(
            _token,
            _intentHash,
            _intent,
            _releaseAmount,
            _managerFeeRecipient,
            _managerFee
        );
        uint256 netAmount = _releaseAmount - netFees;

        address fundsTransferredTo = _intent.to;
        if (address(_intent.postIntentHook) != address(0)) {
            // Snapshot balance to enforce exact consumption by the hook
            uint256 preBalance = _token.balanceOf(address(this));

            // Grant exact allowance to the post-intent hook using SafeERC20 with zero-before-set
            _token.safeApprove(address(_intent.postIntentHook), 0);
            _token.safeApprove(address(_intent.postIntentHook), netAmount);
            IPostIntentHookV2.HookExecutionContext memory hookCtx = IPostIntentHookV2.HookExecutionContext({
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
            });
            _intent.postIntentHook.execute(hookCtx, _postIntentHookData);
            
            // Enforce that the hook pulled exactly netAmount to prevent stranded funds
            uint256 postBalance = _token.balanceOf(address(this));
            require(postBalance <= preBalance, "PostIntentHook: unexpected balance increase");
            uint256 spent = preBalance - postBalance;
            require(spent == netAmount, "PostIntentHook: must pull exact netAmount");

            // Reset allowance to prevent residual balance drainage (and fail closed on non-standard ERC20s)
            _token.safeApprove(address(_intent.postIntentHook), 0);

            fundsTransferredTo = address(_intent.postIntentHook);
        } else {
            // Otherwise transfer directly to the intent recipient
            _token.safeTransfer(_intent.to, netAmount);
        }

        emit IntentFulfilled(
            _intentHash, 
            fundsTransferredTo, 
            netAmount, 
            false
        );
    }

    /**
     * @notice Checks if a intent gating service signature is valid.
     */
    function _isValidIntentGatingSignature(
        SignalIntentParams calldata _intent,
        address _intentGatingService,
        address _caller
    )
        internal
        view
        returns(bool)
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
            _intent.signatureExpiration,
            chainId
        );

        bytes32 verifierPayload = keccak256(message).toEthSignedMessageHash();
        return _intentGatingService.isValidSignatureNow(verifierPayload, _intent.gatingServiceSignature);
    }
}
