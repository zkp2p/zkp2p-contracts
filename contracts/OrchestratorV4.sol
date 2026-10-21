//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { AddressArrayUtils } from "./external/AddressArrayUtils.sol";
import { Bytes32ArrayUtils } from "./external/Bytes32ArrayUtils.sol";
import { IOrchestratorV4 } from "./interfaces/IOrchestratorV4.sol";
import { IReferralFee } from "./interfaces/IReferralFee.sol";
import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowV2 } from "./interfaces/IEscrowV2.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IWhitelistPolicy } from "./interfaces/IWhitelistPolicy.sol";
import { IIntentSettlementPolicy } from "./interfaces/IIntentSettlementPolicy.sol";
import { IPaymentVerifierV2 } from "./interfaces/IPaymentVerifierV2.sol";
import { IPaymentVerifierRegistry } from "./interfaces/IPaymentVerifierRegistry.sol";
import { IRelayerRegistry } from "./interfaces/IRelayerRegistry.sol";
import { ReferralFeeLib } from "./lib/ReferralFeeLib.sol";

/**
 * @title OrchestratorV4
 * @notice Standalone V4 orchestrator for the ZKP2P protocol. Owns the complete intent (order)
 * lifecycle — signal, cancel, fulfill, manual release, prune, orphan cleanup — and extends it
 * with a governance-selected settlement policy and deferred settlement.
 * @dev Intent keeps V3 field order with the intent hooks removed and the hook data replaced by payerCommitment,
 * then appends takerWhitelisted and arbitrator.
 */
contract OrchestratorV4 is ERC165, Ownable, Pausable, ReentrancyGuard, IOrchestratorV4 {

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

    // Snapshot of per-intent manager fee terms at the time of signal
    mapping(bytes32 => address) internal intentManagerFeeRecipient;
    mapping(bytes32 => uint256) internal intentManagerFee;

    // Governance-selected settlement policy applied at settlement.
    IIntentSettlementPolicy public settlementPolicy;

    // Contract references
    IEscrowRegistry public escrowRegistry;                              // Registry of escrow contracts
    IPaymentVerifierRegistry public  paymentVerifierRegistry;          // Registry of payment verifiers
    IWhitelistPolicy public immutable whitelistPolicy;
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
        address _protocolFeeRecipient,
        IWhitelistPolicy _whitelistPolicy
    )
        Ownable()
    {
        chainId = _chainId;
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        protocolFee = _protocolFee;
        protocolFeeRecipient = _protocolFeeRecipient;
        whitelistPolicy = _whitelistPolicy;

        transferOwnership(_owner);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Signals intent to pay the depositor defined in the _depositId the _amount * deposit conversionRate off-chain at 
     * their given _payeeId in order to unlock _amount of funds on-chain. Caller must provide a signature from the deposit's gating
     * service to prove their eligibility to take liquidity. This function captures and stores all values required for fullfilling
     * the intent to give strong guarantees to the buyer. Checks whitelist admission and records whether the taker was
     * whitelisted, and the arbitrator of the group the taker signals through, before locking liquidity for the
     * corresponding deposit on the escrow contract.
     *
     * @param _params                   Struct containing all the intent parameters
     */
    function signalIntent(SignalIntentParams calldata _params)
        external
        nonReentrant
        whenNotPaused
    {
        // Checks
        (bool takerWhitelisted, address arbitrator) = _validateSignalIntent(_params);

        // Effects
        bytes32 intentHash = _calculateIntentHash();
        IEscrow.DepositPaymentMethodData memory depData = IEscrow(_params.escrow).getDepositPaymentMethodData(
            _params.depositId,
            _params.paymentMethod
        );

        (address managerFeeRecipient, uint256 managerFee) = IEscrowV2(_params.escrow).getManagerFee(_params.depositId);
        // Enforce manager fee cap regardless of registry implementation
        if (managerFee > MAX_MANAGER_FEE) revert FeeExceedsMaximum(managerFee, MAX_MANAGER_FEE);  // policy cap (e.g., 5%)
        intentManagerFeeRecipient[intentHash] = managerFeeRecipient;
        intentManagerFee[intentHash] = managerFee;

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
        storedIntent.payerCommitment = _params.payerCommitment;
        storedIntent.takerWhitelisted = takerWhitelisted;
        storedIntent.arbitrator = arbitrator;

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
     * @notice Only callable by the originator or the arbitrator of the intent. Cancels an outstanding intent. Unlocks
     * liquidity for the corresponding deposit on the escrow contract.
     *
     * @param _intentHash    Hash of intent being cancelled
     */
    function cancelIntent(bytes32 _intentHash) external nonReentrant {
        // Checks
        Intent memory intent = intents[_intentHash];
        
        if (intent.timestamp == 0) revert IntentNotFound(_intentHash);
        if (intent.owner != msg.sender && intent.arbitrator != msg.sender) revert UnauthorizedCaller(msg.sender, intent.owner);

        // Effects
        _pruneIntent(_intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockFunds(intent.depositId, _intentHash);
    }

    /**
     * @notice Anyone can submit a fulfill intent transaction, even if caller isn't the intent owner. Upon submission the
     * offchain payment proof is verified, payment details are validated, intent is removed, and escrow state is updated.
     * Settlement unlocks escrow funds, transfers fees, notifies the current settlement policy (fail-closed),
     * and transfers the net payout to intent.to or the deferral vault.
     * @dev Signed settlement data is forwarded opaquely to the current policy.
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
        
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory verificationResult, bytes memory settlementData) = IPaymentVerifierV2(verifier).verifyPayment(
            IPaymentVerifierV2.VerifyPaymentData({
                intentHash: _params.intentHash,
                paymentProof: _params.paymentProof,
                data: _params.verificationData
            })
        );
        if (!verificationResult.success) revert PaymentVerificationFailed();
        if (verificationResult.intentHash != _params.intentHash) revert HashMismatch(_params.intentHash, verificationResult.intentHash);

        // Effects
        _pruneIntent(_params.intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(intent.depositId, _params.intentHash, verificationResult.releaseAmount, address(this));

        _collectFeesTransferFundsAndExecuteAction(
            deposit.token, 
            _params.intentHash, 
            intent, 
            verificationResult.releaseAmount,
            settlementData,
            managerFeeRecipient,
            managerFee,
            address(0),
            deposit.depositor
        );
    }

    /**
     * @notice Allows depositor or the intent's arbitrator to release funds to the payer in case of a failed fulfill intent, a
     * dispute ruling, or some other arrangement between the two parties. Upon submission we check to make sure the msg.sender
     * is the depositor or arbitrator, the intent is removed, and escrow state is updated. Manual release pays the recipient
     * directly without calling the settlement policy.
     *
     * @param _intentHash        Hash of intent to resolve by releasing the funds
     * @param _releaseAmount     Amount to release; the depositor must release the full intent amount, the arbitrator
     *                           may release less and the rest returns to the deposit
     */
    function releaseFundsToPayer(bytes32 _intentHash, uint256 _releaseAmount) external nonReentrant {
        // Checks
        Intent memory intent = intents[_intentHash];
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        IEscrow.Deposit memory deposit = IEscrow(intent.escrow).getDeposit(intent.depositId);
        if (msg.sender != intent.arbitrator) {
            if (msg.sender != deposit.depositor) revert UnauthorizedCaller(msg.sender, deposit.depositor);
            // Releasing less would end the intent early and cut off the taker's proof.
            if (_releaseAmount < intent.amount) revert PartialReleaseRequiresArbitrator(_releaseAmount, intent.amount);
        }

        // Snapshot manager fee terms before pruning (pruning deletes the mappings).
        address managerFeeRecipient = intentManagerFeeRecipient[_intentHash];
        uint256 managerFee = intentManagerFee[_intentHash];
        
        // Effects
        _pruneIntent(_intentHash);

        // Interactions
        IEscrow(intent.escrow).unlockAndTransferFunds(intent.depositId, _intentHash, _releaseAmount, address(this));

        _collectFeesTransferFundsAndExecuteAction(
            deposit.token,
            _intentHash,
            intent,
            _releaseAmount,
            "",
            managerFeeRecipient,
            managerFee,
            msg.sender,
            deposit.depositor
        );
    }

    /**
     * @notice Only callable by the intent's arbitrator. Extends the intent's expiry for free, e.g. while a dispute is
     * reviewed. The escrow must let this orchestrator extend (on EscrowV2, as the deposit's intent guardian) and caps
     * the intent's total lifetime.
     *
     * @param _intentHash        Hash of intent to extend
     * @param _additionalTime    Seconds to add to the intent's expiry
     */
    function extendIntent(bytes32 _intentHash, uint256 _additionalTime) external {
        Intent storage intent = intents[_intentHash];
        if (intent.arbitrator != msg.sender) revert UnauthorizedCaller(msg.sender, intent.arbitrator);

        IEscrow(intent.escrow).extendIntentExpiry(intent.depositId, _intentHash, _additionalTime);
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
                _pruneIntent(intentHash);
            }
        }
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Updates the global settlement policy.
     * @dev Applies to every later settlement, including open intents. The zero address disables protection.
     *
     * @param _policy   New global settlement policy
     */
    function setSettlementPolicy(IIntentSettlementPolicy _policy) external onlyOwner {
        address previousPolicy = address(settlementPolicy);
        settlementPolicy = _policy;
        emit SettlementPolicyUpdated(previousPolicy, address(_policy));
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
     * - Manual fund release by depositor or arbitrator (releaseFundsToPayer)
     * - Intent extension by arbitrator (extendIntent)
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

    /// @notice Reports ERC-165 and IOrchestratorV4 support.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IOrchestratorV4).interfaceId || super.supportsInterface(interfaceId);
    }

    function getIntent(bytes32 _intentHash) external view returns (Intent memory) {
        return intents[_intentHash];
    }

    function getAccountIntents(address _account) external view returns (bytes32[] memory) {
        return accountIntents[_account];
    }

    /* ============ Internal Functions ============ */

    /**
     * @notice Validates an intent before it is signaled and returns the arbitrator of the group it names.
     */
    function _validateSignalIntent(SignalIntentParams calldata _intent)
        internal
        view
        returns (bool takerWhitelisted, address arbitrator)
    {
        // Check if account can have multiple intents
        bool canHaveMultipleIntents = relayerRegistry.isWhitelistedRelayer(msg.sender) || allowMultipleIntents;
        if (!canHaveMultipleIntents && accountIntents[msg.sender].length > 0) {
            revert AccountHasActiveIntent(msg.sender, accountIntents[msg.sender][0]);
        }

        if (_intent.to == address(0)) revert ZeroAddress();
        
        ReferralFeeLib.validateReferralFees(_intent.referralFees);

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

        // With the whitelist off, anyone may signal and groupId is ignored; a group taker gets its group's arbitrator.
        takerWhitelisted = whitelistPolicy.enabled(_intent.escrow, _intent.depositId, _intent.paymentMethod);
        if (takerWhitelisted) {
            if (!whitelistPolicy.isTakerWhitelisted(
                _intent.escrow, _intent.depositId, _intent.paymentMethod, msg.sender, _intent.groupId
            )) {
                revert TakerNotWhitelisted(_intent.escrow, _intent.depositId, _intent.paymentMethod, msg.sender);
            }
            if (_intent.groupId != bytes32(0)) (,,,,, arbitrator) = whitelistPolicy.groupRegistry().getGroup(_intent.groupId);
        }

        address intentGatingService = IEscrow(_intent.escrow).getDepositGatingService(_intent.depositId, _intent.paymentMethod);
        // Only a gating service can vouch that the committed payer IDs belong to the taker.
        if (_intent.payerCommitment.length != 0 && intentGatingService == address(0)) {
            revert PayerCommitmentRequiresGatingService();
        }
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
     * @notice Transfers fees, notifies the current settlement policy of settlement (fail-closed), then routes the
     * executable remainder to the deferral vault or directly to the recipient.
     * @dev A reverting settlement policy aborts the entire settlement, including the preceding fee transfers.
     * The settlement policy receives the depositor captured before escrow unlock and no token allowance.
     * Manual releases and whitelisted takers settle without calling the policy.
     */
    function _collectFeesTransferFundsAndExecuteAction(
        IERC20 _token,
        bytes32 _intentHash,
        Intent memory _intent,
        uint256 _releaseAmount,
        bytes memory _settlementData,
        address _managerFeeRecipient,
        uint256 _managerFee,
        address _releasedBy,
        address _depositor
    ) internal {
        IIntentSettlementPolicy policy = settlementPolicy;

        uint256 netFees = _calculateAndTransferFees(_token, _intentHash, _intent, _releaseAmount, _managerFeeRecipient, _managerFee);
        uint256 netAmount = _releaseAmount - netFees;

        address vault;
        IIntentSettlementPolicy.SettlementContext memory context;
        if (address(policy) != address(0) && _releasedBy == address(0) && !_intent.takerWhitelisted) {
            context = IIntentSettlementPolicy.SettlementContext({
                intentHash: _intentHash,
                token: address(_token),
                depositor: _depositor,
                taker: _intent.owner,
                recipient: _intent.to,
                paymentMethod: _intent.paymentMethod,
                releaseAmount: _releaseAmount,
                netAmount: netAmount,
                settlementData: _settlementData
            });
            vault = policy.settleIntent(context);
        }

        address fundsTransferredTo = _intent.to;
        if (vault != address(0)) {
            _token.safeTransfer(vault, netAmount);
            policy.onDeferredPayoutFunded(context);
            emit IntentPayoutDeferred(_intentHash, _intent.to, vault, netAmount);
            fundsTransferredTo = vault;
        } else {
            // Otherwise transfer directly to the intent recipient
            _token.safeTransfer(_intent.to, netAmount);
        }

        emit IntentFulfilled(
            _intentHash, 
            fundsTransferredTo, 
            netAmount, 
            _releasedBy
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
            chainId,
            _intent.payerCommitment // Last and variable-length; empty keeps O3's message byte for byte
        );

        bytes32 verifierPayload = keccak256(message).toEthSignedMessageHash();
        return _intentGatingService.isValidSignatureNow(verifierPayload, _intent.gatingServiceSignature);
    }
}
