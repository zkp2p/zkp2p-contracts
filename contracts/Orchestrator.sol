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
import { IOrchestrator } from "./interfaces/IOrchestrator.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IPostIntentHook } from "./interfaces/IPostIntentHook.sol";
import { IPaymentVerifier } from "./interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierRegistry } from "./interfaces/IPaymentVerifierRegistry.sol";
import { IPostIntentHookRegistry } from "./interfaces/IPostIntentHookRegistry.sol";
import { IRelayerRegistry } from "./interfaces/IRelayerRegistry.sol";

/**
 * @title Orchestrator
 * @notice Orchestrator contract for the ZKP2P protocol. This contract is responsible for managing the intent (order) 
 * lifecycle and orchestrating the P2P trading of fiat currency and onchain assets.
 */
contract Orchestrator is Ownable, Pausable, ReentrancyGuard, IOrchestrator {

    using AddressArrayUtils for address[];
    using Bytes32ArrayUtils for bytes32[];
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using SignatureChecker for address;


    /* ============ Constants ============ */
    uint256 internal constant PRECISE_UNIT = 1e18;
    uint256 constant CIRCOM_PRIME_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant MAX_REFERRER_FEE = 5e16;      // 5% max referrer fee
    uint256 constant MAX_PROTOCOL_FEE = 5e16;      // 5% max protocol fee

    /* ============ State Variables ============ */

    uint256 immutable public chainId;              // chainId of the chain the orchestrator is deployed on

    mapping(bytes32 => Intent) internal intents;                       // Mapping of intentHashes to intent structs
    mapping(address => bytes32[]) internal accountIntents;             // Mapping of address to array of intentHashes

    // Snapshot of the minimum per-intent amount at the time of lock (signal)
    // Used to prevent fulfillments that pay out less than the deposit's min intent amount.
    mapping(bytes32 => uint256) internal intentMinAtSignal;

    // Contract references
    IEscrowRegistry public escrowRegistry;                              // Registry of escrow contracts
    IPaymentVerifierRegistry public  paymentVerifierRegistry;          // Registry of payment verifiers
    IPostIntentHookRegistry public postIntentHookRegistry;             // Registry of post intent hooks
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
        address _postIntentHookRegistry,
        address _relayerRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient
    )
        Ownable()
    {
        chainId = _chainId;
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        postIntentHookRegistry = IPostIntentHookRegistry(_postIntentHookRegistry);
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
        whenNotPaused
    {
        // Checks
        _validateSignalIntent(_params);

        // Effects
        bytes32 intentHash = _calculateIntentHash();
        IEscrow.Deposit memory dep = IEscrow(_params.escrow).getDeposit(_params.depositId);
        IEscrow.DepositPaymentMethodData memory depData = IEscrow(_params.escrow).getDepositPaymentMethodData(
            _params.depositId,
            _params.paymentMethod
        );
        
        intentMinAtSignal[intentHash] = dep.intentAmountRange.min;
        intents[intentHash] = Intent({
            owner: msg.sender,
            to: _params.to,
            escrow: _params.escrow,
            depositId: _params.depositId,
            amount: _params.amount,
            paymentMethod: _params.paymentMethod,
            fiatCurrency: _params.fiatCurrency,
            conversionRate: _params.conversionRate,
            payeeId: depData.payeeDetails, 
            timestamp: block.timestamp,
            referrer: _params.referrer,
            referrerFee: _params.referrerFee,
            postIntentHook: _params.postIntentHook,
            data: _params.data
        });

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
            _params.postIntentHookData
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
        
        // Effects
        _pruneIntent(_intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(intent.depositId, _intentHash, intent.amount, address(this));

        _collectFeesAndTransferFunds(deposit.token, _intentHash, intent, intent.amount);
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
     * @notice GOVERNANCE ONLY: Updates the post intent hook registry address.
     *
     * @param _postIntentHookRegistry   New post intent hook registry address
     */
    function setPostIntentHookRegistry(address _postIntentHookRegistry) external onlyOwner {
        if (_postIntentHookRegistry == address(0)) revert ZeroAddress();
        
        postIntentHookRegistry = IPostIntentHookRegistry(_postIntentHookRegistry);
        emit PostIntentHookRegistryUpdated(_postIntentHookRegistry);
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

    function getIntentMinAtSignal(bytes32 _intentHash) external view returns (uint256) {
        return intentMinAtSignal[_intentHash];
    }

    /* ============ Internal Functions ============ */

    /**
     * @notice Validates an intent before it is signaled.
     */
    function _validateSignalIntent(SignalIntentParams memory _intent) internal view {
        // Check if account can have multiple intents
        bool canHaveMultipleIntents = relayerRegistry.isWhitelistedRelayer(msg.sender) || allowMultipleIntents;
        if (!canHaveMultipleIntents && accountIntents[msg.sender].length > 0) {
            revert AccountHasActiveIntent(msg.sender, accountIntents[msg.sender][0]);
        }

        if (_intent.to == address(0)) revert ZeroAddress();
        
        if (_intent.referrerFee > MAX_REFERRER_FEE) revert FeeExceedsMaximum(_intent.referrerFee, MAX_REFERRER_FEE);
        if (_intent.referrer == address(0)) {
            if (_intent.referrerFee != 0) revert InvalidReferrerFeeConfiguration();
        }

        if (address(_intent.postIntentHook) != address(0)) {
            if (!postIntentHookRegistry.isWhitelistedHook(address(_intent.postIntentHook))) {
                revert PostIntentHookNotWhitelisted(address(_intent.postIntentHook));
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
        
        uint256 minConversionRate = IEscrow(_intent.escrow).getDepositCurrencyMinRate(
            _intent.depositId, _intent.paymentMethod, _intent.fiatCurrency
        );
        if (minConversionRate == 0) revert CurrencyNotSupported(_intent.paymentMethod, _intent.fiatCurrency);
        if (_intent.conversionRate < minConversionRate) revert RateBelowMinimum(_intent.conversionRate, minConversionRate);

        address intentGatingService = IEscrow(_intent.escrow).getDepositGatingService(_intent.depositId, _intent.paymentMethod);
        if (intentGatingService != address(0)) {
            // Check if signature has expired
            if (block.timestamp > _intent.signatureExpiration) {
                revert SignatureExpired(_intent.signatureExpiration, block.timestamp);
            }

            if (!_isValidIntentGatingSignature(_intent, intentGatingService)) {
                revert InvalidSignature();
            }
        }
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

        emit IntentPruned(_intentHash);
    }

    /**
     * @notice Calculates and transfers fees to the protocol fee recipient and referrer.
     */
    function _calculateAndTransferFees(
        IERC20 _token,
        Intent memory _intent, 
        uint256 _releaseAmount
    ) internal returns (uint256 netFees) {
        uint256 protocolFeeAmount;
        uint256 referrerFeeAmount; 

        // Calculate protocol fee (taken from taker) - based on release amount
        if (protocolFeeRecipient != address(0) && protocolFee > 0) {
            protocolFeeAmount = (_releaseAmount * protocolFee) / PRECISE_UNIT;
            _token.safeTransfer(protocolFeeRecipient, protocolFeeAmount);
        }
        
        // Calculate referrer fee (taken from taker) - based on release amount
        if (_intent.referrer != address(0) && _intent.referrerFee > 0) {
            referrerFeeAmount = (_releaseAmount * _intent.referrerFee) / PRECISE_UNIT;
            _token.safeTransfer(_intent.referrer, referrerFeeAmount);
        }

        netFees = protocolFeeAmount + referrerFeeAmount;
    }

    /**
     * @notice Transfers funds to the intent recipient. Called by manual release.
     */
    function _collectFeesAndTransferFunds(
        IERC20 _token, 
        bytes32 _intentHash, 
        Intent memory _intent,
        uint256 _releaseAmount
    ) internal {
        uint256 netFees = _calculateAndTransferFees(_token, _intent, _releaseAmount);
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
        bytes memory _postIntentHookData
    ) internal {
        uint256 netFees = _calculateAndTransferFees(_token, _intent, _releaseAmount);
        uint256 netAmount = _releaseAmount - netFees;

        address fundsTransferredTo = _intent.to;
        if (address(_intent.postIntentHook) != address(0)) {
            // Snapshot balance to enforce exact consumption by the hook
            uint256 preBalance = _token.balanceOf(address(this));

            // Grant exact allowance to the post-intent hook using SafeERC20 with zero-before-set
            _token.safeApprove(address(_intent.postIntentHook), 0);
            _token.safeApprove(address(_intent.postIntentHook), netAmount);
            _intent.postIntentHook.execute(_intent, netAmount, _postIntentHookData);
            
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
        SignalIntentParams memory _intent, 
        address _intentGatingService
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
            _intent.to, 
            _intent.paymentMethod, 
            _intent.fiatCurrency, 
            _intent.conversionRate, 
            _intent.signatureExpiration,
            chainId
        );

        bytes32 verifierPayload = keccak256(message).toEthSignedMessageHash();
        return _intentGatingService.isValidSignatureNow(verifierPayload, _intent.gatingServiceSignature);
    }
}
