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
import { StringArrayUtils } from "./external/StringArrayUtils.sol";
import { Uint256ArrayUtils } from "./external/Uint256ArrayUtils.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IOrchestrator } from "./interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "./interfaces/IPostIntentHook.sol";
import { IPaymentVerifier } from "./interfaces/IPaymentVerifier.sol";
import { IPaymentVerifierRegistry } from "./interfaces/IPaymentVerifierRegistry.sol";
import { IPostIntentHookRegistry } from "./interfaces/IPostIntentHookRegistry.sol";
import { IRelayerRegistry } from "./interfaces/IRelayerRegistry.sol";

/**
 * @title Escrow
 * @notice Escrows deposits and manages deposit lifecycle.
 */
contract Escrow is Ownable, Pausable, ReentrancyGuard, IEscrow {

    using AddressArrayUtils for address[];
    using Bytes32ArrayUtils for bytes32[];
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using SignatureChecker for address;
    using StringArrayUtils for string[];
    using Uint256ArrayUtils for uint256[];

    /* ============ Constants ============ */
    uint256 internal constant PRECISE_UNIT = 1e18;
    uint256 internal constant MAX_DUST_THRESHOLD = 1e6;            // 1 USDC
    uint256 internal constant MAX_TOTAL_INTENT_EXPIRATION_PERIOD = 86400 * 5; // 5 days
    uint256 internal constant PRUNE_ALL_EXPIRED_INTENTS = type(uint256).max;
    
    /* ============ State Variables ============ */

    IOrchestrator public orchestrator;                               // Address of the orchestrator contract
    IPaymentVerifierRegistry public paymentVerifierRegistry;         // Address of the payment verifier registry contract
    uint256 immutable public chainId;                                // chainId of the chain the escrow is deployed on

    mapping(address => uint256[]) internal accountDeposits;          // Mapping of address to depositIds

    // Mapping of depositId to verifier address to deposit's verification data. A single deposit can support multiple payment 
    // services. Each payment service has it's own verification data which includes the payee details hash and the data used for 
    // payment verification.
    // Example: Deposit 1 => Venmo => payeeDetails: 0x123, data: 0x456
    //                    => Revolut => payeeDetails: 0x789, data: 0xabc
    mapping(uint256 => mapping(bytes32 => DepositPaymentMethodData)) internal depositPaymentMethodData;
    mapping(uint256 => bytes32[]) internal depositPaymentMethods;          // Handy mapping to get all payment methods for a deposit
    mapping(uint256 => mapping(bytes32 => bool)) internal depositPaymentMethodActive; // Handy mapping for checking if a payment method is active for a deposit
    // Track if a payment method has ever been listed for this deposit (to avoid array contains checks and duplicates in depositPaymentMethods)
    mapping(uint256 => mapping(bytes32 => bool)) internal depositPaymentMethodListed;
    
    // Mapping of depositId to verifier address to mapping of fiat currency to min conversion rate. Each payment service can support
    // multiple currencies. Depositor can specify list of currencies and min conversion rates for each payment service.
    // Example: Deposit 1 => Venmo => USD: 1e18
    //                    => Revolut => USD: 1e18, EUR: 1.2e18, SGD: 1.5e18
    mapping(uint256 => mapping(bytes32 => mapping(bytes32 => uint256))) internal depositCurrencyMinRate;
    mapping(uint256 => mapping(bytes32 => bytes32[])) internal depositCurrencies; // Handy mapping to get all currencies for a deposit and verifier
    // Do not need to track if a currency is active; if it's min rate is 0 then it's not active
    // Track if a currency code has ever been listed for this deposit+paymentMethod (avoid contains scans and duplicates in depositCurrencies)
    mapping(uint256 => mapping(bytes32 => mapping(bytes32 => bool))) internal depositCurrencyListed;

    mapping(uint256 => Deposit) internal deposits;                          // Mapping of depositIds to deposit structs
    mapping(uint256 => bytes32[]) internal depositIntentHashes;             // Mapping of depositId to array of intentHashes
    mapping(uint256 => mapping(bytes32 => Intent)) internal depositIntents; // Mapping of depositId to intentHash to intent

    uint256 public depositCounter;          // Counter for depositIds
    
    address public dustRecipient;           // Address that receives dust
    uint256 public dustThreshold;           // Amount below which deposits are considered dust and can be closed
    uint256 public maxIntentsPerDeposit;    // Maximum active intents per deposit (suggested to keep below 100 to prevent deposit withdraw DOS)
    uint256 public intentExpirationPeriod;  // Time period after which an intent expires

    /* ============ Modifiers ============ */

    /**
     * @notice Modifier to check if caller is depositor or their delegate for a specific deposit
     * @param _depositId The deposit ID to check authorization for
     */
    modifier onlyDepositorOrDelegate(uint256 _depositId) {
        Deposit storage deposit = deposits[_depositId];
        if (!(deposit.depositor == msg.sender || 
            (deposit.delegate != address(0) && deposit.delegate == msg.sender))) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }
        _;
    }

    /**
     * @notice Modifier to restrict access to orchestrator-only functions
     */
    modifier onlyOrchestrator() {
        if (msg.sender != address(orchestrator)) revert UnauthorizedCaller(msg.sender, address(orchestrator));
        _;
    }

    /* ============ Constructor ============ */
    constructor(
        address _owner,
        uint256 _chainId,
        address _paymentVerifierRegistry,
        address _dustRecipient,
        uint256 _dustThreshold,
        uint256 _maxIntentsPerDeposit,
        uint256 _intentExpirationPeriod
    )
        Ownable()
    {
        chainId = _chainId;
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        dustRecipient = _dustRecipient;
        dustThreshold = _dustThreshold;
        maxIntentsPerDeposit = _maxIntentsPerDeposit;
        intentExpirationPeriod = _intentExpirationPeriod;

        transferOwnership(_owner);
    }

    /* ============ Deposit Owner Only (External Functions) ============ */

    /**
     * @notice Creates a deposit entry by locking liquidity in the escrow contract that can be taken by signaling intents. This function will 
     * not add to previous deposits. Every deposit has it's own unique identifier. User must approve the contract to transfer the deposit amount
     * of deposit token. Every deposit specifies the payment methods it supports by specifying their verification data, supported currencies and 
     * their min conversion rates for each payment method. Optionally, a delegate to manage the deposit can be specified.
     * Note that the order of the payment methods, verification data, and currency data must match.
     */
    function createDeposit(CreateDepositParams calldata _params) external whenNotPaused {
        // Checks
        if (_params.intentAmountRange.min == 0) revert ZeroMinValue();
        if (_params.intentAmountRange.min > _params.intentAmountRange.max) { 
            revert InvalidRange(_params.intentAmountRange.min, _params.intentAmountRange.max);
        }
        if (_params.amount < _params.intentAmountRange.min) {
            revert AmountBelowMin(_params.amount, _params.intentAmountRange.min);
        }
        
        // Effects
        uint256 depositId = depositCounter++;
        accountDeposits[msg.sender].push(depositId);
        deposits[depositId] = Deposit({
            depositor: msg.sender,
            delegate: _params.delegate,
            token: _params.token,
            intentAmountRange: _params.intentAmountRange,
            acceptingIntents: true,
            remainingDeposits: _params.amount,
            outstandingIntentAmount: 0,
            intentGuardian: _params.intentGuardian,
            retainOnEmpty: _params.retainOnEmpty
        });

        emit DepositReceived(
            depositId, 
            msg.sender, 
            _params.token,
            _params.amount,
            _params.intentAmountRange, 
            _params.delegate, 
            _params.intentGuardian
        );

        _addPaymentMethodsToDeposit(depositId, _params.paymentMethods, _params.paymentMethodData, _params.currencies);

        // Interactions
        _params.token.safeTransferFrom(msg.sender, address(this), _params.amount);
    }

    /**
     * @notice Adds additional funds to an existing deposit. Any EOA or contract can add funds.
     * The funds will be added to the remaining deposits amount, making it available for new intents.
     *
     * @param _depositId    The deposit ID to add funds to
     * @param _amount       The amount of tokens to add
     */
    function addFunds(uint256 _depositId, uint256 _amount)
        external
        whenNotPaused
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (_amount == 0) revert ZeroValue();
        
        // Effects
        deposit.remainingDeposits += _amount;
        
        emit DepositFundsAdded(_depositId, msg.sender, _amount);
        
        // Interactions
        deposit.token.safeTransferFrom(msg.sender, address(this), _amount);
    }

    /**
     * @notice Removes funds from an existing deposit. Only the depositor can remove funds. If the amount to remove is greater
     * than the remaining deposits, then expired intents will be pruned to reclaim liquidity. If the remaining deposits is less than
     * the min intent amount, then the deposit will be marked as not accepting intents. 
     *
     * @param _depositId    The deposit ID to remove funds from
     * @param _amount       The amount of tokens to remove
     */
    function removeFunds(uint256 _depositId, uint256 _amount)
        external
        nonReentrant
        whenNotPaused
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);
        if (_amount == 0) revert ZeroValue();
        
        // Effects
        bytes32[] memory expiredIntents = _reclaimLiquidityIfNecessary(deposit, _depositId, _amount);
        if (deposit.remainingDeposits < _amount) {
            revert InsufficientDepositLiquidity(_depositId, deposit.remainingDeposits, _amount);
        }

        deposit.remainingDeposits -= _amount;
        _handleAcceptingIntentsState(_depositId);

        emit DepositWithdrawn(_depositId, msg.sender, _amount);
        
        // Interactions
        deposit.token.safeTransfer(msg.sender, _amount);

        // Prune intents on the orchestrator
        if (expiredIntents.length > 0) {
            _tryOrchestratorPruneIntents(expiredIntents);
        }
    }

    /**
     * @notice Depositor is returned all remaining deposits and any outstanding intents that are expired. Only the depositor can withdraw. 
     * If an intent is not expired then those funds will not be returned. Deposit is marked as to not accept new intents and the funds
     * locked due to intents can be withdrawn once they expire by calling this function again. Deposit will be deleted as long as there are
     * no more outstanding intents.
     *
     * @param _depositId   DepositId the depositor is attempting to withdraw
     */
    function withdrawDeposit(uint256 _depositId) external nonReentrant {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        // Effects
        bytes32[] memory expiredIntents = _reclaimLiquidityIfNecessary(deposit, _depositId, PRUNE_ALL_EXPIRED_INTENTS);

        uint256 returnAmount = deposit.remainingDeposits;
        IERC20 token = deposit.token;
        delete deposit.remainingDeposits;
        delete deposit.acceptingIntents;

        emit DepositWithdrawn(_depositId, deposit.depositor, returnAmount);

        _closeDepositIfNecessary(_depositId, deposit);
        
        // Interactions
        token.safeTransfer(msg.sender, returnAmount);

        // Prune intents on the orchestrator
        if (expiredIntents.length > 0) {
            _tryOrchestratorPruneIntents(expiredIntents);
        }
    }

    /* ============ Deposit Delegate management ============ */

    /**
     * @notice Allows depositor to set a delegate address that can manage a specific deposit
     *
     * @param _depositId    The deposit ID
     * @param _delegate     The address to set as delegate (address(0) to remove delegate)
     */
    
    function setDelegate(uint256 _depositId, address _delegate) external whenNotPaused {
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);
        if (_delegate == address(0)) revert ZeroAddress();
        
        deposit.delegate = _delegate;
        
        emit DepositDelegateSet(_depositId, msg.sender, _delegate);
    }

    /**
     * @notice Allows depositor to remove the delegate for a specific deposit
     *
     * @param _depositId    The deposit ID
     */
    function removeDelegate(uint256 _depositId) external whenNotPaused {
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);
        if (deposit.delegate == address(0)) revert DelegateNotFound(_depositId);
        
        delete deposit.delegate;
        
        emit DepositDelegateRemoved(_depositId, msg.sender);
    }

    /* ============ Deposit Owner OR Delegate Only (External Functions) ============ */

    /**
     * @notice Only callable by the depositor/delegate for a deposit. Allows depositor/delegate to update the min conversion rate for a 
     * currency for a payment verifier provided the currency was previously listed (otherwise use addCurrenciesToDepositPaymentMethod). 
     * Since intent's store the conversion rate at the time of intent, changing the min conversion rate will not affect any intents that 
     * have already been signaled.
     *
     * @param _depositId                The deposit ID
     * @param _paymentMethod            The payment method to update the min conversion rate for
     * @param _fiatCurrency             The fiat currency code to update the min conversion rate for
     * @param _newMinConversionRate     The new min conversion rate. Must be greater than 0.
     */
    function setCurrencyMinRate(
        uint256 _depositId, 
        bytes32 _paymentMethod, 
        bytes32 _fiatCurrency, 
        uint256 _newMinConversionRate
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        // Allow reactivation from 0 if currency was previously listed
        if (!depositCurrencyListed[_depositId][_paymentMethod][_fiatCurrency]) {
            revert CurrencyNotSupported(_paymentMethod, _fiatCurrency);
        }
        if (_newMinConversionRate == 0) revert ZeroConversionRate();

        depositCurrencyMinRate[_depositId][_paymentMethod][_fiatCurrency] = _newMinConversionRate;

        emit DepositMinConversionRateUpdated(_depositId, _paymentMethod, _fiatCurrency, _newMinConversionRate);
    }

    /**
     * @notice Allows depositor to update the intent amount range for a deposit. Since intent's are already created within the
     * previous intent amount range, changing the intent amount range will not affect any intents that have already been signaled.
     *
     * @param _depositId                The deposit ID
     * @param _intentAmountRange        The new intent amount range
     */
    function setIntentRange(
        uint256 _depositId, 
        Range calldata _intentAmountRange
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        Deposit storage deposit = deposits[_depositId];
        if (_intentAmountRange.min == 0) revert ZeroMinValue();
        if (_intentAmountRange.min > _intentAmountRange.max) revert InvalidRange(_intentAmountRange.min, _intentAmountRange.max);

        deposit.intentAmountRange = _intentAmountRange;
        
        _handleAcceptingIntentsState(_depositId);

        emit DepositIntentAmountRangeUpdated(_depositId, _intentAmountRange);
    }

    /**
     * @notice Allows depositor to add a new payment verifier and its associated currencies to an existing deposit.
     * @dev WARNING: Adding excessive payment methods or currencies may cause withdrawal to exceed gas limits. Depositors
     * can remove entries individually if needed. Recommended: <10 payment methods, <50 currencies each.
     *
     * @param _depositId             The deposit ID
     * @param _paymentMethods        The payment methods to add
     * @param _paymentMethodData     The payment verification data for the payment methods
     * @param _currencies            The currencies for the payment methods
     */
    function addPaymentMethods(
        uint256 _depositId,
        bytes32[] calldata _paymentMethods,
        DepositPaymentMethodData[] calldata _paymentMethodData,
        Currency[][] calldata _currencies
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        _addPaymentMethodsToDeposit(_depositId, _paymentMethods, _paymentMethodData, _currencies);
    }

    /**
     * @notice Allows depositor or delegate to toggle a payment method's active state without removing it.
     * This function allows depositor to remove an existing payment verifier from a deposit by setting active to false. The
     * deposit and currencies data is not deleted immediately and instead deferred to when the deposit is fully closed.
     * NOTE: This function does not delete the payment method data to allow existing intents to be fulfilled.
     *
     * @param _depositId     The deposit ID
     * @param _paymentMethod The payment method
     * @param _isActive      New active state
     */
    function setPaymentMethodActive(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bool _isActive
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        if (!depositPaymentMethodListed[_depositId][_paymentMethod]) revert PaymentMethodNotListed(_depositId, _paymentMethod);
        if (depositPaymentMethodActive[_depositId][_paymentMethod] == _isActive) {
            revert DepositAlreadyInState(_depositId, _isActive);
        }
        depositPaymentMethodActive[_depositId][_paymentMethod] = _isActive;
        emit DepositPaymentMethodActiveUpdated(_depositId, _paymentMethod, _isActive);
    }

    /**
     * @notice Allows depositor to add a new currencies to an existing verifier for a deposit.
     * @dev WARNING: Adding excessive currencies may cause withdrawal to exceed gas limits. Depositors
     * can remove entries individually if needed. Recommended: <50 currencies per payment method.
     *
     * @param _depositId             The deposit ID
     * @param _paymentMethod         The payment method
     * @param _currencies            The currencies to add (code and conversion rate)
     */
    function addCurrencies(
        uint256 _depositId,
        bytes32 _paymentMethod,
        Currency[] calldata _currencies
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        if (!depositPaymentMethodActive[_depositId][_paymentMethod]) revert PaymentMethodNotActive(_depositId, _paymentMethod);
        
        for (uint256 i = 0; i < _currencies.length; i++) {
            _addCurrencyToDeposit(
                _depositId, 
                _paymentMethod, 
                _currencies[i].code, 
                _currencies[i].minConversionRate
            );
        }
    }

    /**
     * @notice Allows depositor to deactivate a currency from a verifier for a deposit. The currency is deactivated.
     *
     * @param _depositId             The deposit ID
     * @param _paymentMethod         The payment method
     * @param _currencyCode          The currency code to deactivate
     */
    function deactivateCurrency(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )   
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        if (!depositPaymentMethodActive[_depositId][_paymentMethod]) revert PaymentMethodNotActive(_depositId, _paymentMethod);
        if (!depositCurrencyListed[_depositId][_paymentMethod][_currencyCode]) revert CurrencyNotFound(_paymentMethod, _currencyCode);
        
        depositCurrencyMinRate[_depositId][_paymentMethod][_currencyCode] = 0;

        emit DepositMinConversionRateUpdated(_depositId, _paymentMethod, _currencyCode, 0);
    }

    /**
     * @notice Allows depositor or delegateto set the accepting intents state for a deposit.
     *
     * @param _depositId             The deposit ID
     * @param _acceptingIntents      The new accepting intents state
     */
    function setAcceptingIntents(
        uint256 _depositId, 
        bool _acceptingIntents
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        Deposit storage deposit = deposits[_depositId];
        if (deposit.acceptingIntents == _acceptingIntents) revert DepositAlreadyInState(_depositId, _acceptingIntents);

        // If accepting intents, check if there is enough liquidity to accept the minimum intent amount
        if (
            _acceptingIntents && 
            deposit.remainingDeposits < deposit.intentAmountRange.min
        ) revert InsufficientDepositLiquidity(_depositId, deposit.remainingDeposits, deposit.intentAmountRange.min);
        
        
        deposit.acceptingIntents = _acceptingIntents;
        emit DepositAcceptingIntentsUpdated(_depositId, _acceptingIntents);
    }

    /**
     * @notice Allows depositor or delegate to set the retain-on-empty behavior for a deposit. When true, the deposit
     * will not auto-close or sweep dust when empty; config (payment methods, currencies, rate etc) stays for reuse.
     *
     * @param _depositId        The deposit ID
     * @param _retainOnEmpty    New retain-on-empty flag value
     */
    function setRetainOnEmpty(
        uint256 _depositId,
        bool _retainOnEmpty
    )
        external
        whenNotPaused
        onlyDepositorOrDelegate(_depositId)
    {
        Deposit storage deposit = deposits[_depositId];
        if (deposit.retainOnEmpty == _retainOnEmpty) revert DepositAlreadyInState(_depositId, _retainOnEmpty);
        
        deposit.retainOnEmpty = _retainOnEmpty;
        
        emit DepositRetainOnEmptyUpdated(_depositId, _retainOnEmpty);
    }

    /* ============ Anyone callable (External Functions) ============ */

    /**
     * @notice ANYONE: Can be called by anyone to clean up expired intents.
     * 
     * @param _depositId The deposit ID to prune expired intents for
     */
    function pruneExpiredIntents(uint256 _depositId) external nonReentrant {
        // Checks, Effects
        bytes32[] memory expiredIntents = _reclaimLiquidityIfNecessary(
            deposits[_depositId], 
            _depositId, 
            PRUNE_ALL_EXPIRED_INTENTS     // Prune all expired intents
        );

        // Interactions
        if (expiredIntents.length > 0) {
            _tryOrchestratorPruneIntents(expiredIntents);
        }
    }

    /* ============ Orchestrator-Only Locking and Unlocking Functions ============ */

    /**
     * @notice ORCHESTRATOR ONLY: Locks funds for an intent with expiry time. Only callable by orchestrator.
     * Places a lock on the deposit, stores lock amount along with it's expiry timestamp for unlocking later.
     * 
     * @param _depositId The deposit ID to lock funds from
     * @param _amount The amount to lock
     * @param _intentHash The intent hash this intent corresponds to
     */
    function lockFunds(
        uint256 _depositId, 
        bytes32 _intentHash,
        uint256 _amount
    ) 
        external
        nonReentrant
        onlyOrchestrator 
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (!deposit.acceptingIntents) revert DepositNotAcceptingIntents(_depositId);
        if (_amount < deposit.intentAmountRange.min) revert AmountBelowMin(_amount, deposit.intentAmountRange.min);
        if (_amount > deposit.intentAmountRange.max) revert AmountAboveMax(_amount, deposit.intentAmountRange.max);
        // Prevent duplicate intent hashes which can corrupt liquidity accounting
        if (depositIntents[_depositId][_intentHash].intentHash != bytes32(0)) {
            revert IntentAlreadyExists(_depositId, _intentHash);
        }
        
        // Effects
        // Check if we need to reclaim expired liquidity first; if so, then reclaims and updates the deposit state
        bytes32[] memory expiredIntents = _reclaimLiquidityIfNecessary(deposit, _depositId, _amount);
    
        // Check if we have enough liquidity after reclaiming expired liquidity
        if (deposit.remainingDeposits < _amount) {
            revert InsufficientDepositLiquidity(_depositId, deposit.remainingDeposits, _amount);
        }

        // Check if we exceeded the maximum number of intents after expiring intents and adding the new intent
        uint256 newIntentCount = depositIntentHashes[_depositId].length + 1;
        if (newIntentCount > maxIntentsPerDeposit) {
            revert MaxIntentsExceeded(_depositId, newIntentCount, maxIntentsPerDeposit);
        }
        
        // Update deposit state due to the new intent
        deposit.remainingDeposits -= _amount;
        deposit.outstandingIntentAmount += _amount;
        
        depositIntentHashes[_depositId].push(_intentHash);
        uint256 expiryTime = block.timestamp + intentExpirationPeriod;
        depositIntents[_depositId][_intentHash] = Intent({
            intentHash: _intentHash,
            amount: _amount,
            timestamp: block.timestamp,
            expiryTime: expiryTime
        });
        
        emit FundsLocked(_depositId, _intentHash, _amount, expiryTime);

        // Interactions
        if (expiredIntents.length > 0) {
            _tryOrchestratorPruneIntents(expiredIntents);
        }
    }

    /**
     * @notice ORCHESTRATOR ONLY: Unlocks funds from a cancelled intent by removing the specific intent. 
     * Releases the lock on deposit liquidity and adds it back to the deposit.
     * 
     * @param _depositId The deposit ID to unlock funds from
     * @param _intentHash The intent hash to find and remove the intent for
     */
    function unlockFunds(uint256 _depositId, bytes32 _intentHash) 
        external 
        nonReentrant
        onlyOrchestrator 
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        Intent memory intent = depositIntents[_depositId][_intentHash];

        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (intent.intentHash == bytes32(0)) revert IntentNotFound(_intentHash);

        // Effects
        deposit.remainingDeposits += intent.amount;
        deposit.outstandingIntentAmount -= intent.amount;

        _pruneIntent(_depositId, _intentHash);

        emit FundsUnlocked(_depositId, _intentHash, intent.amount);
    }

    /**
     * @notice ORCHESTRATOR ONLY: Unlocks and transfers funds from a fulfilled intent by removing the specific intent.
     * Only callable by orchestrator. Releases the lock on deposlit liquidity and transfers out partial/full locked
     * amount to the given to address.
     * 
     * @param _depositId The deposit ID to transfer from
     * @param _intentHash The intent hash to find and remove the intent for
     * @param _transferAmount The amount to actually transfer (may be less than intent amount)
     * @param _to The address to transfer to (orchestrator)
     */
    function unlockAndTransferFunds(
        uint256 _depositId, 
        bytes32 _intentHash,
        uint256 _transferAmount, 
        address _to
    ) 
        external 
        nonReentrant
        onlyOrchestrator 
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        Intent memory intent = depositIntents[_depositId][_intentHash];
        
        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (intent.intentHash == bytes32(0)) revert IntentNotFound(_intentHash);
        if (_transferAmount == 0) revert ZeroValue();
        if (_transferAmount > intent.amount) revert AmountExceedsAvailable(_transferAmount, intent.amount);
        
        // Effects
        deposit.outstandingIntentAmount -= intent.amount;
        
        // If this is a partial release, return the unused portion to remainingDeposits
        if (_transferAmount < intent.amount) {
            deposit.remainingDeposits += (intent.amount - _transferAmount);
        }

        _pruneIntent(_depositId, _intentHash);
        
        IERC20 token = deposit.token;
        _closeDepositIfNecessary(_depositId, deposit);
        
        emit FundsUnlockedAndTransferred(
            _depositId, _intentHash, intent.amount, _transferAmount, _to
        );

        // Interactions
        token.safeTransfer(_to, _transferAmount);
    }

    /* ============ Intent Guardian Only (External Functions) ============ */

    /**
     * @notice INTENT GUARDIAN ONLY: Extends the expiry time of an existing intent. Only callable by intent guardian.
     * This function reverts if the total intent expiry period is greater than the maximum allowed to prevent griefing
     * by extending the intent expiry period indefinitely.
     * 
     * @param _depositId The deposit ID containing the intent
     * @param _intentHash The intent hash to extend expiry for
     * @param _additionalTime The additional time to extend the expiry by
     */
    function extendIntentExpiry(
        uint256 _depositId, 
        bytes32 _intentHash,
        uint256 _additionalTime
    ) 
        external 
    {
        // Checks
        Deposit storage deposit = deposits[_depositId];
        Intent storage intent = depositIntents[_depositId][_intentHash];
        
        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (intent.intentHash == bytes32(0)) revert IntentNotFound(_intentHash);
        if (deposit.intentGuardian != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.intentGuardian);
        if (_additionalTime == 0) revert ZeroValue();
        if (intent.expiryTime + _additionalTime > intent.timestamp + MAX_TOTAL_INTENT_EXPIRATION_PERIOD) {
            revert AmountAboveMax(_additionalTime, MAX_TOTAL_INTENT_EXPIRATION_PERIOD);
        }
        
        // Effects
        intent.expiryTime += _additionalTime;
        
        emit IntentExpiryExtended(_depositId, _intentHash, intent.expiryTime);
    }

    /* ============ Governance Functions ============ */
    
    /**
     * @notice GOVERNANCE ONLY: Sets the orchestrator contract address. Only callable by owner.
     *
     * @param _orchestrator The orchestrator contract address
     */
    function setOrchestrator(address _orchestrator) external onlyOwner {
        if (_orchestrator == address(0)) revert ZeroAddress();
        
        orchestrator = IOrchestrator(_orchestrator);
        emit OrchestratorUpdated(_orchestrator);
    }

    /**
     * @notice GOVERNANCE ONLY: Updates the payment verifier registry address.
     *
     * @param _paymentVerifierRegistry   New payment verifier registry address
     */
    function setPaymentVerifierRegistry(address _paymentVerifierRegistry) external onlyOwner {
        if (_paymentVerifierRegistry == address(0)) revert ZeroAddress();
        
        paymentVerifierRegistry = IPaymentVerifierRegistry(_paymentVerifierRegistry);
        emit PaymentVerifierRegistryUpdated(_paymentVerifierRegistry);
    }

    /** 
     * @notice GOVERNANCE ONLY: Sets the dust recipient address.
     *
     * @param _dustRecipient The new dust recipient address
     */
    function setDustRecipient(address _dustRecipient) external onlyOwner {
        if (_dustRecipient == address(0)) revert ZeroAddress();
        
        dustRecipient = _dustRecipient;
        emit DustRecipientUpdated(_dustRecipient);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets the dust threshold below which deposits can be closed automatically.
     *
     * @param _dustThreshold The new dust threshold amount
     */
    function setDustThreshold(uint256 _dustThreshold) external onlyOwner {
        if (_dustThreshold > MAX_DUST_THRESHOLD) revert AmountAboveMax(_dustThreshold, MAX_DUST_THRESHOLD);
        
        dustThreshold = _dustThreshold;
        emit DustThresholdUpdated(_dustThreshold);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets the maximum number of active intents per deposit.
     *
     * @param _maxIntentsPerDeposit The new maximum number of active intents per deposit
     */
    function setMaxIntentsPerDeposit(uint256 _maxIntentsPerDeposit) external onlyOwner {
        if (_maxIntentsPerDeposit == 0) revert ZeroValue();
        
        maxIntentsPerDeposit = _maxIntentsPerDeposit;
        emit MaxIntentsPerDepositUpdated(_maxIntentsPerDeposit);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets the intent expiration period.
     *
     * @param _intentExpirationPeriod The new intent expiration period in seconds
     */
    function setIntentExpirationPeriod(uint256 _intentExpirationPeriod) external onlyOwner {
        if (_intentExpirationPeriod == 0) revert ZeroValue();
        
        intentExpirationPeriod = _intentExpirationPeriod;
        emit IntentExpirationPeriodUpdated(_intentExpirationPeriod);
    }

    /**
     * @notice GOVERNANCE ONLY: Pauses deposit modifications and new deposit creation.
     * 
     * Functionalities that are paused:
     * - Deposit creation (createDeposit)
     * - Adding/removing funds to deposits (addFunds, removeFunds)
     * - Updating deposit parameters (conversion rates, intent ranges, accepting intents state)
     * - Adding/removing payment methods and currencies
     *
     * Functionalities that remain unpaused to allow users to rescue funds:
     * - Full deposit withdrawal (withdrawDeposit)
     * - Expired intent pruning (pruneExpiredIntentsAndReclaimLiquidity)
     * - Orchestrator operations (lockFunds, unlockFunds, unlockAndTransferFunds)
     * - Intent expiry extensions by guardian
     * - All view functions
     */
    function pauseEscrow() external onlyOwner {
        _pause();
    }

    /**
     * @notice GOVERNANCE ONLY: Restarts paused functionality for the escrow.
     */
    function unpauseEscrow() external onlyOwner {
        _unpause();
    }

    /* ============ External View Functions ============ */

    function getDeposit(uint256 _depositId) external view returns (Deposit memory) {
        return deposits[_depositId];
    }

    function getDepositIntentHashes(uint256 _depositId) external view returns (bytes32[] memory) {
        return depositIntentHashes[_depositId];
    }

    function getDepositIntent(uint256 _depositId, bytes32 _intentHash) external view returns (Intent memory) {
        return depositIntents[_depositId][_intentHash];
    }

    function getDepositPaymentMethods(uint256 _depositId) external view returns (bytes32[] memory) {
        return depositPaymentMethods[_depositId];
    }

    function getDepositCurrencies(uint256 _depositId, bytes32 _paymentMethod) external view returns (bytes32[] memory) {
        return depositCurrencies[_depositId][_paymentMethod];
    }

    function getDepositCurrencyMinRate(uint256 _depositId, bytes32 _paymentMethod, bytes32 _currencyCode) external view returns (uint256) {
        return depositCurrencyMinRate[_depositId][_paymentMethod][_currencyCode];
    }

    function getDepositCurrencyListed(uint256 _depositId, bytes32 _paymentMethod, bytes32 _currencyCode) external view returns (bool) {
        return depositCurrencyListed[_depositId][_paymentMethod][_currencyCode];
    }

    function getDepositPaymentMethodListed(uint256 _depositId, bytes32 _paymentMethod) external view returns (bool) {
        return depositPaymentMethodListed[_depositId][_paymentMethod];
    }

    function getDepositPaymentMethodData(uint256 _depositId, bytes32 _paymentMethod) external view returns (DepositPaymentMethodData memory) {
        return depositPaymentMethodData[_depositId][_paymentMethod];
    }

    function getDepositPaymentMethodActive(uint256 _depositId, bytes32 _paymentMethod) external view returns (bool) {
        return depositPaymentMethodActive[_depositId][_paymentMethod];
    }

    function getDepositGatingService(uint256 _depositId, bytes32 _paymentMethod) external view returns (address) {
        return depositPaymentMethodData[_depositId][_paymentMethod].intentGatingService;
    }

    function getAccountDeposits(address _account) external view returns (uint256[] memory) {
        return accountDeposits[_account];
    }
    
    function getExpiredIntents(uint256 _depositId) external view returns (bytes32[] memory expiredIntents, uint256 reclaimableAmount) {
        return _getExpiredIntents(_depositId);
    }


    /* ============ Internal Functions ============ */

    /**
     * @notice Cycles through all intents currently open on a deposit and sees if any have expired. If they have expired
     * the outstanding amounts are summed and returned alongside the intentHashes.
     * Note: This function compacts the expired intents array to remove any empty slots.
     */
    function _getExpiredIntents(
        uint256 _depositId
    )
        internal
        view
        returns(bytes32[] memory expiredIntents, uint256 reclaimableAmount)
    {
        bytes32[] memory intentHashes = depositIntentHashes[_depositId];
        bytes32[] memory verboseExpiredIntents = new bytes32[](intentHashes.length);
        uint256 numExpiredIntents = 0;

        for (uint256 i = 0; i < intentHashes.length; ++i) {
            Intent memory intent = depositIntents[_depositId][intentHashes[i]];
            if (intent.expiryTime < block.timestamp) {
                verboseExpiredIntents[i] = intentHashes[i];
                reclaimableAmount += intent.amount;
                numExpiredIntents++;
            }
        }

        // Compact the expired intents array
        expiredIntents = new bytes32[](numExpiredIntents);
        uint256 compactedIndex = 0;
        for (uint256 i = 0; i < intentHashes.length; ++i) {
            if (verboseExpiredIntents[i] != bytes32(0)) {
                expiredIntents[compactedIndex++] = verboseExpiredIntents[i];
            }
        }
    }

    /**
     * @notice Free up deposit liquidity by reclaiming liquidity from expired intents. Only reclaims if remaining deposits amount
     * is less than the minimum required amount. Returns the expired intents that need to be pruned. Only does local state updates, 
     * does not call any external contracts. Whenever this function is called, the calling function should also call _tryOrchestratorPruneIntents
     * with the returned intents to expire the intents on the orchestrator contract.
     */
    function _reclaimLiquidityIfNecessary(
        Deposit storage _deposit, 
        uint256 _depositId, 
        uint256 _minRequiredAmount
    )
        internal
        returns (bytes32[] memory expiredIntents)
    {
        if (
            _deposit.remainingDeposits < _minRequiredAmount || 
            depositIntentHashes[_depositId].length == maxIntentsPerDeposit
        ) {
            // If the deposit has insufficient liquidity or is at max intents, reclaim liquidity from expired intents
            uint256 reclaimedAmount;
            
            (expiredIntents, reclaimedAmount) = _getExpiredIntents(_depositId);    
            _deposit.remainingDeposits += reclaimedAmount;
            _deposit.outstandingIntentAmount -= reclaimedAmount;

            // Prune intents locally and emit funds unlocked events
            for (uint256 i = 0; i < expiredIntents.length; i++) {
                Intent memory intent = depositIntents[_depositId][expiredIntents[i]];
                _pruneIntent(_depositId, intent.intentHash);
                
                emit FundsUnlocked(_depositId, intent.intentHash, intent.amount);
            }
        }
    }

    /**
     * @notice Prunes an intent from a deposit locally. Does not call orchestrator.
     */
    function _pruneIntent(uint256 _depositId, bytes32 _intentHash) internal {
        delete depositIntents[_depositId][_intentHash];
        depositIntentHashes[_depositId].removeStorage(_intentHash);
    }

    /**
      * @notice Calls the orchestrator to clean up intents. 
      * Note: If the orchestrator reverts, it is caught and ignored to allow the function to continue execution.
      */
    function _tryOrchestratorPruneIntents(bytes32[] memory _intents) internal {
        try IOrchestrator(orchestrator).pruneIntents(_intents) {} catch {}
    }

    /**
     * @notice Updates acceptingIntents based on remaining liquidity. One-way demotion only: if remainingDeposits 
     * falls below min and acceptingIntents is true, set it to false. If acceptingIntents is false, it will remain 
     * false even if remainingDeposits is increased above min. The depositor has to manually re-enable accepting 
     * intents by calling setDepositAcceptingIntents.
     */
    function _handleAcceptingIntentsState(uint256 _depositId) internal {
        Deposit storage deposit = deposits[_depositId];
        if (deposit.acceptingIntents && deposit.remainingDeposits < deposit.intentAmountRange.min) {
            deposit.acceptingIntents = false;
            emit DepositAcceptingIntentsUpdated(_depositId, false);
        }
    }

    /**
     * @notice Removes a deposit if no outstanding intents AND remaining funds is dust. Before deletion, transfers any remaining
     * dust to the protocol dust recipient.
     */
    function _closeDepositIfNecessary(uint256 _depositId, Deposit storage _deposit) internal {
        // Close if no outstanding intents and remaining deposits are at or below dust
        uint256 totalRemaining = _deposit.remainingDeposits;
        if (_deposit.outstandingIntentAmount == 0 && totalRemaining <= dustThreshold && !_deposit.retainOnEmpty) {
            // Close deposit (and sweep any dust) when retention is not enabled
            IERC20 token = _deposit.token;
            _closeDeposit(_depositId, _deposit);

            if (totalRemaining > 0) {
                token.safeTransfer(dustRecipient, totalRemaining);
                emit DustCollected(_depositId, totalRemaining, dustRecipient);
            }
        }
    }

    /**
     * @notice Closes a deposit. Deleting a deposit deletes it from the deposits mapping and removes tracking
     * it in the user's accountDeposits mapping. Also deletes the verification and currency data for the deposit.
     */
    function _closeDeposit(uint256 _depositId, Deposit storage _deposit) internal {
        address depositor = _deposit.depositor;
        accountDeposits[depositor].removeStorage(_depositId);
        
        _deleteDepositPaymentMethodAndCurrencyData(_depositId);
        
        delete deposits[_depositId];
        delete _deposit.acceptingIntents;  // Might have been set to false, but delete it to be safe
        
        emit DepositClosed(_depositId, depositor);
    }

    /**
     * @notice Iterates through all verifiers for a deposit and deletes the corresponding verifier data and currencies.
     */
    function _deleteDepositPaymentMethodAndCurrencyData(uint256 _depositId) internal {
        bytes32[] memory paymentMethods = depositPaymentMethods[_depositId];
        for (uint256 i = 0; i < paymentMethods.length; i++) {
            bytes32 paymentMethod = paymentMethods[i];
            delete depositPaymentMethodData[_depositId][paymentMethod];
            delete depositPaymentMethodActive[_depositId][paymentMethod];
            delete depositPaymentMethodListed[_depositId][paymentMethod];
            bytes32[] memory currencies = depositCurrencies[_depositId][paymentMethod];
            for (uint256 j = 0; j < currencies.length; j++) {
                bytes32 currencyCode = currencies[j];
                delete depositCurrencyMinRate[_depositId][paymentMethod][currencyCode];
                delete depositCurrencyListed[_depositId][paymentMethod][currencyCode];
            }
            delete depositCurrencies[_depositId][paymentMethod];
        }
        delete depositPaymentMethods[_depositId];
    }

    /**
     * @notice Adds list of payment methods and corresponding verification data and currencies to a deposit.
     */
    function _addPaymentMethodsToDeposit(
        uint256 _depositId,
        bytes32[] calldata _paymentMethods,
        DepositPaymentMethodData[] calldata _paymentMethodData,
        Currency[][] calldata _currencies
    ) internal {

        // Check that the length of the payment methods, depositPaymentMethodData, and currencies arrays are the same
        if (_paymentMethods.length != _paymentMethodData.length) revert ArrayLengthMismatch(_paymentMethods.length, _paymentMethodData.length);
        if (_paymentMethods.length != _currencies.length) revert ArrayLengthMismatch(_paymentMethods.length, _currencies.length);

        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            bytes32 paymentMethod = _paymentMethods[i];
            
            // Validate payment method
            if (paymentMethod == bytes32(0)) revert ZeroAddress();
            if (!paymentVerifierRegistry.isPaymentMethod(paymentMethod)) {
                revert PaymentMethodNotWhitelisted(paymentMethod);
            }
            if (_paymentMethodData[i].payeeDetails == bytes32(0)) revert EmptyPayeeDetails();
            // Prevent duplicates using O(1) listed flag; if already listed (active or inactive) revert
            if (depositPaymentMethodListed[_depositId][paymentMethod]) revert PaymentMethodAlreadyExists(_depositId, paymentMethod);

            // Add payment method
            depositPaymentMethodData[_depositId][paymentMethod] = _paymentMethodData[i];
            depositPaymentMethods[_depositId].push(paymentMethod);
            depositPaymentMethodListed[_depositId][paymentMethod] = true;
            depositPaymentMethodActive[_depositId][paymentMethod] = true;

            emit DepositPaymentMethodAdded(_depositId, paymentMethod, _paymentMethodData[i].payeeDetails, _paymentMethodData[i].intentGatingService);

            for (uint256 j = 0; j < _currencies[i].length; j++) {
                Currency memory currency = _currencies[i][j];

                _addCurrencyToDeposit(
                    _depositId, 
                    paymentMethod, 
                    currency.code, 
                    currency.minConversionRate
                );
            }
        }
    }

    /**
     * @notice Adds a currency to a deposit.
     */
    function _addCurrencyToDeposit(
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        uint256 _minConversionRate
    ) internal {
        // Validate currency
        if (!paymentVerifierRegistry.isCurrency(_paymentMethod, _currencyCode)) {
            revert CurrencyNotSupported(_paymentMethod, _currencyCode);
        }
        if (_minConversionRate == 0) revert ZeroConversionRate();
        if (depositCurrencyListed[_depositId][_paymentMethod][_currencyCode]) {
            revert CurrencyAlreadyExists(_paymentMethod, _currencyCode);
        }

        // Add currency
        depositCurrencyMinRate[_depositId][_paymentMethod][_currencyCode] = _minConversionRate;
        depositCurrencies[_depositId][_paymentMethod].push(_currencyCode);
        depositCurrencyListed[_depositId][_paymentMethod][_currencyCode] = true;

        emit DepositCurrencyAdded(_depositId, _paymentMethod, _currencyCode, _minConversionRate);
    }
}
