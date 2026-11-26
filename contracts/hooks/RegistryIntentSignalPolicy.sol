// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IAddressGroupRegistry } from "../interfaces/IAddressGroupRegistry.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";
import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";
import { IIntentSignalPolicy } from "../interfaces/IIntentSignalPolicy.sol";
import { IOrchestratorV4 } from "../interfaces/IOrchestratorV4.sol";
import { IReferralFee } from "../interfaces/IReferralFee.sol";
import { ISanctionsList } from "../interfaces/ISanctionsList.sol";
import { ITakerRegistry } from "../interfaces/ITakerRegistry.sol";
import { IWhitelistPolicyV2 } from "../interfaces/IWhitelistPolicyV2.sol";

/// @dev OrchestratorV4's public intent counter; IOrchestratorV4 does not declare it.
interface IIntentCounter {
    function intentCounter() external view returns (uint256);
}

/**
 * @title RegistryIntentSignalPolicy
 * @notice OrchestratorV4 signal policy that admits takers from on-chain state. A taker signals with a registered
 * payment account, within that account's open-intent and daily limits, paying the service fee. No signature is
 * involved: `gatingServiceSignature` and `signatureExpiration` are ignored.
 * @dev Members of the integrator group signal for their own customers and skip the registration, the limits and the
 * fee. Membership is whatever the group registry reports, so the group's curator, who can also open the group or
 * give it a resolver, is trusted with that exemption. The deposit whitelist applies to every taker, as in
 * IntentSignalPolicy.
 * @dev The open-intent limit counts intents whose escrow lock has not expired: an expired lock is reclaimable by
 * the escrow, so it no longer holds the deposit's liquidity. The policy runs before the orchestrator assigns the
 * intent hash, so it derives the hash the orchestrator is about to assign from its public counter and records it.
 * Configuration is fixed at deployment; governance changes it by selecting a new policy on the orchestrator.
 * Registrations live in the registry and outlive the policy; the limits' counts do not.
 */
contract RegistryIntentSignalPolicy is IIntentSignalPolicy {

    /* ============ Structs ============ */

    struct ServiceFee {
        uint64 fee;                    // Fee rate in preciseUnits (1e16 = 1%)
        uint64 feeBelowThreshold;      // Fee rate on thresholdCurrency deposits priced below thresholdRate
        uint128 thresholdRate;         // Deposit conversion rate in thresholdCurrency
        bytes32 thresholdCurrency;     // Only currency the threshold applies to; zero = no threshold
    }

    struct MethodServiceFee {
        bytes32 paymentMethod;
        ServiceFee serviceFee;
    }

    struct Config {
        address orchestrator;                   // Only caller of validateSignalIntent
        ITakerRegistry registry;                // Registered takers
        IWhitelistPolicyV2 whitelistPolicy;     // Per-deposit taker whitelists and their groups
        ISanctionsList sanctionsList;           // Sanctioned addresses may neither signal nor receive
        bytes32 integratorGroupId;              // Group admitted without a registration; zero = none
        address guardian;                       // May stop new intents for a limited time
        address feeRecipient;                   // Receives the service fee
        uint256 maxReferralShare;               // Part of the service fee other referral recipients may take
        uint256 maxOpenIntents;                 // Open intents one identity may hold
        uint256 maxDailyIntents;                // Intents one identity may signal per UTC day
        ServiceFee defaultServiceFee;
        MethodServiceFee[] methodServiceFees;   // Payment methods with their own service fee
    }

    struct DailyCount {
        uint64 day;
        uint64 count;
    }

    struct Stop {
        uint64 since;
        uint64 until;
    }

    /* ============ Events ============ */

    event NewIntentsStopped(bytes32 indexed paymentMethod, uint256 until);
    event NewIntentsResumed(bytes32 indexed paymentMethod);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller, address authorized);
    error StopNotInFuture(uint256 until, uint256 currentTime);
    error StopExceedsMaximum(uint256 until, uint256 maximum);
    error StopCoolingDown(bytes32 paymentMethod, uint256 until);
    error NewIntentsNotStopped(bytes32 paymentMethod);
    error NewIntentsAreStopped(bytes32 paymentMethod, uint256 until);
    error PayerCommitmentNotSupported();
    error Sanctioned(address account);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);
    error OpenIntentLimitReached(bytes32 identityId, uint256 limit);
    error DailyIntentLimitReached(bytes32 identityId, uint256 limit);
    error ServiceFeeTooLow(uint256 paid, uint256 required);

    /* ============ Constants ============ */

    uint256 internal constant CIRCOM_PRIME_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_STOP_DURATION = 3 days;
    uint256 public constant STOP_COOLDOWN = 1 days;
    bytes32 public constant ALL_PAYMENT_METHODS = bytes32(0);

    /* ============ State Variables ============ */

    address public immutable orchestrator;
    ITakerRegistry public immutable registry;
    IWhitelistPolicyV2 public immutable whitelistPolicy;
    IAddressGroupRegistry public immutable groupRegistry;
    ISanctionsList public immutable sanctionsList;
    bytes32 public immutable integratorGroupId;
    address public immutable guardian;
    address public immutable feeRecipient;
    uint256 public immutable maxReferralShare;
    uint256 public immutable maxOpenIntents;
    uint256 public immutable maxDailyIntents;

    ServiceFee public defaultServiceFee;
    mapping(bytes32 => ServiceFee) public serviceFees;                 // paymentMethod; set once at deployment
    mapping(bytes32 => bool) public hasServiceFee;                     // paymentMethod; false takes defaultServiceFee

    mapping(bytes32 => Stop) public newIntentStops;                    // paymentMethod, or ALL_PAYMENT_METHODS
    mapping(bytes32 => bytes32[]) internal openIntents;                // identityId => intents not yet seen closed
    mapping(bytes32 => DailyCount) internal dailyCounts;               // identityId

    /* ============ Constructor ============ */

    constructor(Config memory _config) {
        if (
            _config.orchestrator == address(0) || address(_config.registry) == address(0)
                || address(_config.whitelistPolicy) == address(0) || address(_config.sanctionsList) == address(0)
                || _config.feeRecipient == address(0)
        ) revert ZeroAddress();

        orchestrator = _config.orchestrator;
        registry = _config.registry;
        whitelistPolicy = _config.whitelistPolicy;
        groupRegistry = _config.whitelistPolicy.groupRegistry();
        sanctionsList = _config.sanctionsList;
        integratorGroupId = _config.integratorGroupId;
        guardian = _config.guardian;
        feeRecipient = _config.feeRecipient;
        maxReferralShare = _config.maxReferralShare;
        maxOpenIntents = _config.maxOpenIntents;
        maxDailyIntents = _config.maxDailyIntents;

        defaultServiceFee = _config.defaultServiceFee;
        for (uint256 i = 0; i < _config.methodServiceFees.length; i++) {
            serviceFees[_config.methodServiceFees[i].paymentMethod] = _config.methodServiceFees[i].serviceFee;
            hasServiceFee[_config.methodServiceFees[i].paymentMethod] = true;
        }
    }

    /* ============ External Functions ============ */

    /**
     * @inheritdoc IIntentSignalPolicy
     * @dev ORCHESTRATOR ONLY: the call records the intent against the taker's identity.
     */
    function validateSignalIntent(address _taker, IOrchestratorV4.SignalIntentParams calldata _params)
        external
        override
        returns (bool takerWhitelisted, address arbitrator)
    {
        if (msg.sender != orchestrator) revert UnauthorizedCaller(msg.sender, orchestrator);

        _requireNotStopped(ALL_PAYMENT_METHODS);
        _requireNotStopped(_params.paymentMethod);

        // UPV trusts the payer commitment O4 stores, and this policy vouches for none.
        if (_params.payerCommitment.length != 0) revert PayerCommitmentNotSupported();
        if (sanctionsList.isSanctioned(_taker)) revert Sanctioned(_taker);
        if (sanctionsList.isSanctioned(_params.to)) revert Sanctioned(_params.to);

        // With the whitelist off, anyone may signal and groupId is ignored; a group taker gets its group's arbitrator.
        if (whitelistPolicy.enabled(_params.escrow, _params.depositId)) {
            takerWhitelisted = whitelistPolicy.isWhitelisted(_params.escrow, _params.depositId, _taker, _params.groupId);
            if (!takerWhitelisted) {
                revert TakerNotWhitelisted(_params.escrow, _params.depositId, _params.paymentMethod, _taker);
            }
            if (_params.groupId != bytes32(0)) arbitrator = groupRegistry.groupArbitrator(_params.groupId);
        }

        if (groupRegistry.isMember(integratorGroupId, _taker)) return (takerWhitelisted, arbitrator);

        bytes32 identityId = registry.requireRegistered(_taker, _params.paymentMethod);
        _requireServiceFee(_params);
        _recordIntent(identityId);
    }

    /* ============ Guardian Functions ============ */

    /**
     * @notice GUARDIAN ONLY: Stops new intents on one payment method, or on all with ALL_PAYMENT_METHODS, until a
     * time at most MAX_STOP_DURATION after the stop began. The stop lapses on its own, and the same scope cannot
     * be stopped again until STOP_COOLDOWN after it ended. Open intents are unaffected.
     * @param _paymentMethod   Payment method to stop, or ALL_PAYMENT_METHODS
     * @param _until           Time the stop ends
     */
    function stopNewIntents(bytes32 _paymentMethod, uint64 _until) external {
        if (msg.sender != guardian) revert UnauthorizedCaller(msg.sender, guardian);
        if (_until <= block.timestamp) revert StopNotInFuture(_until, block.timestamp);

        Stop memory stop = newIntentStops[_paymentMethod];
        if (block.timestamp >= stop.until) {
            if (stop.until != 0 && block.timestamp < stop.until + STOP_COOLDOWN) {
                revert StopCoolingDown(_paymentMethod, stop.until + STOP_COOLDOWN);
            }
            stop.since = uint64(block.timestamp);
        }
        if (_until > stop.since + MAX_STOP_DURATION) revert StopExceedsMaximum(_until, stop.since + MAX_STOP_DURATION);

        stop.until = _until;
        newIntentStops[_paymentMethod] = stop;
        emit NewIntentsStopped(_paymentMethod, _until);
    }

    /**
     * @notice GUARDIAN ONLY: Ends a running stop now.
     * @param _paymentMethod   Stopped payment method, or ALL_PAYMENT_METHODS
     */
    function resumeNewIntents(bytes32 _paymentMethod) external {
        if (msg.sender != guardian) revert UnauthorizedCaller(msg.sender, guardian);
        if (block.timestamp >= newIntentStops[_paymentMethod].until) revert NewIntentsNotStopped(_paymentMethod);

        newIntentStops[_paymentMethod].until = uint64(block.timestamp);
        emit NewIntentsResumed(_paymentMethod);
    }

    /* ============ View Functions ============ */

    /**
     * @notice Service fee rate an intent on the deposit must carry, before any referral share.
     * @dev A threshold reads the deposit's current rate, as the orchestrator does when it prices the intent.
     */
    function requiredServiceFee(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bytes32 _fiatCurrency)
        public
        view
        returns (uint256)
    {
        ServiceFee memory serviceFee = hasServiceFee[_paymentMethod] ? serviceFees[_paymentMethod] : defaultServiceFee;
        if (_fiatCurrency != serviceFee.thresholdCurrency) return serviceFee.fee;

        uint256 depositRate = IEscrowV2(_escrow).getEffectiveRate(_depositId, _paymentMethod, _fiatCurrency);
        return depositRate < serviceFee.thresholdRate ? serviceFee.feeBelowThreshold : serviceFee.fee;
    }

    /// @notice Intents recorded against an identity and not yet seen closed; closed ones leave at its next signal.
    function getOpenIntents(bytes32 _identityId) external view returns (bytes32[] memory) {
        return openIntents[_identityId];
    }

    /* ============ Internal Functions ============ */

    function _requireNotStopped(bytes32 _paymentMethod) internal view {
        uint256 until = newIntentStops[_paymentMethod].until;
        if (block.timestamp < until) revert NewIntentsAreStopped(_paymentMethod, until);
    }

    /**
     * @notice Drops the identity's intents that are gone or expired, then records the intent the orchestrator is
     * about to create, within the open and daily limits.
     */
    function _recordIntent(bytes32 _identityId) internal {
        bytes32[] storage intents = openIntents[_identityId];
        for (uint256 i = intents.length; i > 0; i--) {
            if (!_isOpen(intents[i - 1])) {
                intents[i - 1] = intents[intents.length - 1];
                intents.pop();
            }
        }
        if (intents.length >= maxOpenIntents) revert OpenIntentLimitReached(_identityId, maxOpenIntents);

        DailyCount memory daily = dailyCounts[_identityId];
        uint64 today = uint64(block.timestamp / 1 days);
        if (daily.day != today) daily = DailyCount({ day: today, count: 0 });
        if (daily.count >= maxDailyIntents) revert DailyIntentLimitReached(_identityId, maxDailyIntents);
        daily.count++;
        dailyCounts[_identityId] = daily;

        // Mirrors OrchestratorV4._calculateIntentHash, which runs after this policy in the same call.
        intents.push(
            bytes32(
                uint256(keccak256(abi.encodePacked(orchestrator, IIntentCounter(orchestrator).intentCounter())))
                    % CIRCOM_PRIME_FIELD
            )
        );
    }

    /// @notice Whether the orchestrator still holds the intent and its escrow lock has not expired.
    function _isOpen(bytes32 _intentHash) internal view returns (bool) {
        IOrchestratorV4.Intent memory intent = IOrchestratorV4(orchestrator).getIntent(_intentHash);
        if (intent.timestamp == 0) return false;

        return IEscrow(intent.escrow).getDepositIntent(intent.depositId, _intentHash).expiryTime >= block.timestamp;
    }

    /**
     * @notice Requires referral fees that cover the service fee, with at most maxReferralShare of it going to
     * recipients other than feeRecipient. The orchestrator has already rejected duplicate recipients.
     */
    function _requireServiceFee(IOrchestratorV4.SignalIntentParams calldata _params) internal view {
        uint256 required =
            requiredServiceFee(_params.escrow, _params.depositId, _params.paymentMethod, _params.fiatCurrency);

        uint256 total;
        uint256 toFeeRecipient;
        for (uint256 i = 0; i < _params.referralFees.length; i++) {
            IReferralFee.ReferralFee calldata referralFee = _params.referralFees[i];
            total += referralFee.fee;
            if (referralFee.recipient == feeRecipient) toFeeRecipient = referralFee.fee;
        }

        if (total < required) revert ServiceFeeTooLow(total, required);
        if (toFeeRecipient + maxReferralShare < required) revert ServiceFeeTooLow(toFeeRecipient, required - maxReferralShare);
    }
}
