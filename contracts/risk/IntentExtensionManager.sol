// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title IntentExtensionManager
 * @notice Stateful policy module for purchasing and resolving paid intent extensions.
 *
 * @dev This module deliberately owns only extension-specific configuration and position state. The concrete
 *      RiskManager remains responsible for common intent facts, lifecycle transitions, pause state, external access
 *      control, and reentrancy protection.
 *
 *      An extension purchase locks the maximum cumulative fee under a namespaced StakeVault lock:
 *
 *        extensionLock = ceil(intentAmount * hourlySlope * purchasedTime / (10_000 * 1 hour))
 *
 *      When the intent settles or cancels, only purchased time used after the original expiry is charged. The charged
 *      amount becomes an immediately claimable allocation for the depositor, while unused principal returns to the
 *      extension stake owner's free stake. Extension exposure never survives into the chargeback window.
 */
abstract contract IntentExtensionManager is IRiskManager {
    /* ============ Constants ============ */

    /// @notice Basis-point denominator used by intent-extension pricing.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Seconds per hour used to apply the configured hourly extension slope.
    uint256 public constant SECONDS_PER_HOUR = 1 hours;

    /// @notice Combined denominator for the time-linear extension formula.
    uint256 public constant EXTENSION_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;

    /// @notice Maximum time from original intent creation through final extended expiry.
    uint64 public constant MAX_TOTAL_INTENT_LIFETIME = 5 days;

    /// @notice Namespace separating extension locks from raw intent-hash chargeback locks.
    bytes32 public constant EXTENSION_LOCK_NAMESPACE = keccak256("ZKP2P_INTENT_EXTENSION");

    /// @dev Extension locks never mature autonomously; a terminal intent transition must resolve them.
    uint64 internal constant EXTENSION_LOCK_MATURITY = type(uint64).max;

    /* ============ Structs ============ */

    /**
     * @dev Mutable extension policy for future positions. A zero slope disables extension purchases without affecting
     *      chargeback admission.
     */
    struct IntentExtensionConfig {
        uint32 extensionPenaltyBpsPerHour;
    }

    /**
     * @dev Extension-specific state snapshotted or accumulated for one admitted intent.
     *      `extensionAmount` mirrors the active namespaced Vault lock amount whenever it is non-zero.
     */
    struct IntentExtensionPosition {
        address extensionStakeOwner;
        uint32 extensionPenaltyBpsPerHour;
        uint64 baseIntentExpiry;
        uint64 totalExtensionTime;
        uint256 extensionAmount;
    }

    /* ============ Extension State ============ */

    /// @dev Payment-method extension policy applied only to subsequently admitted intents.
    mapping(bytes32 => IntentExtensionConfig) internal intentExtensionConfigs;

    /// @dev Per-intent extension policy snapshot and active extension exposure.
    mapping(bytes32 => IntentExtensionPosition) internal intentExtensionPositions;

    /* ============ Internal Admission and Configuration ============ */

    /**
     * @dev Stores the hourly extension slope for future intents after enforcing the maximum-lifetime collateral bound.
     *      A zero slope is valid and disables extension purchases for positions admitted under this configuration.
     * @param _paymentMethod Payment method whose future extension policy is being configured.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     */
    function _setIntentExtensionConfig(bytes32 _paymentMethod, uint32 _extensionPenaltyBpsPerHour) internal {
        uint256 maximumRateNumerator = uint256(_extensionPenaltyBpsPerHour) * MAX_TOTAL_INTENT_LIFETIME;
        if (maximumRateNumerator > EXTENSION_DENOMINATOR) {
            revert ExtensionPenaltyExceedsIntentAmount(_paymentMethod);
        }

        intentExtensionConfigs[_paymentMethod].extensionPenaltyBpsPerHour = _extensionPenaltyBpsPerHour;
    }

    /**
     * @dev Snapshots extension policy and the original Escrow expiry during fail-closed admission. The concrete
     *      coordinator supplies canonical intent facts already read from Orchestrator and performs the common admission
     *      transition before invoking this function. No Vault lock is created until a caller purchases time.
     * @param _intentHash Intent receiving the extension-policy snapshot.
     * @param _paymentMethod Canonical payment method used to select the configured slope.
     * @param _createdAt Canonical intent creation timestamp.
     * @param _escrow Escrow holding the admitted intent.
     * @return baseIntentExpiry Original expiry before any paid extension.
     * @return extensionPenaltyBpsPerHour Snapshotted hourly extension slope.
     */
    function _initializeIntentExtension(
        bytes32 _intentHash,
        bytes32 _paymentMethod,
        uint64 _createdAt,
        IEscrowV2 _escrow
    ) internal returns (uint64 baseIntentExpiry, uint32 extensionPenaltyBpsPerHour) {
        baseIntentExpiry = _toExtensionTimestamp(uint256(_createdAt) + _escrow.intentExpirationPeriod());
        extensionPenaltyBpsPerHour = intentExtensionConfigs[_paymentMethod].extensionPenaltyBpsPerHour;

        IntentExtensionPosition storage position = intentExtensionPositions[_intentHash];
        position.extensionPenaltyBpsPerHour = extensionPenaltyBpsPerHour;
        position.baseIntentExpiry = baseIntentExpiry;
    }

    /* ============ Internal Extension Purchase ============ */

    /**
     * @dev Purchases additional time for a pending intent. The concrete coordinator must reject purchases while paused,
     *      require the common position to be PENDING, and apply non-reentrancy before invoking this function.
     *
     *      The first purchase snapshots the taker's currently selected stake owner. The taker may purchase subsequent
     *      time only while that selection remains current; the snapshotted owner may always add exposure backed by its
     *      own stake. Live records are read only to locate the active extension target and reject expired intents.
     *
     *      Cumulative pricing locks only the incremental amount. The Vault update, Escrow expiry extension, and local
     *      accounting occur atomically, so a downstream failure rolls back the entire purchase.
     * @param _intentHash Pending intent whose expiry is being extended.
     * @param _additionalTime Number of seconds to add to the current Escrow expiry.
     * @param _taker Taker snapshotted by the coordinator at admission.
     * @param _paymentMethod Payment method snapshotted by the coordinator at admission.
     * @param _createdAt Creation timestamp snapshotted by the coordinator at admission.
     * @param _intentAmount Intent amount snapshotted by the coordinator at admission.
     */
    function _extendIntent(
        bytes32 _intentHash,
        uint64 _additionalTime,
        address _taker,
        bytes32 _paymentMethod,
        uint64 _createdAt,
        uint256 _intentAmount
    ) internal {
        if (_additionalTime == 0) revert ZeroAmount();

        IntentExtensionPosition storage position = intentExtensionPositions[_intentHash];
        if (position.extensionPenaltyBpsPerHour == 0) revert ExtensionsDisabled(_paymentMethod);

        IStakeVault vault = _stakeVault();
        address currentStakeOwner = vault.stakeOwnerOf(_taker);
        address extensionStakeOwner = _authorizeIntentExtension(position, _taker, currentStakeOwner);

        (IEscrowV2 escrow, uint256 depositId, uint64 currentExpiry) = _getLiveExtensionTarget(_intentHash);

        (uint64 newTotalExtensionTime, uint64 newExpiry) =
            _calculateUpdatedExpiry(position, _additionalTime, currentExpiry, _createdAt);
        uint256 totalAmount =
            _calculateIntentExtensionCost(_intentAmount, newTotalExtensionTime, position.extensionPenaltyBpsPerHour);
        uint256 additionalAmount = totalAmount - position.extensionAmount;

        _increaseExtensionLock(
            vault, _intentHash, extensionStakeOwner, position.extensionAmount, totalAmount, additionalAmount
        );
        escrow.extendIntentExpiry(depositId, _intentHash, _additionalTime);

        if (position.extensionStakeOwner == address(0)) {
            position.extensionStakeOwner = extensionStakeOwner;
        }
        position.totalExtensionTime = newTotalExtensionTime;
        position.extensionAmount = totalAmount;

        emit IntentExtended(
            _intentHash,
            _taker,
            extensionStakeOwner,
            msg.sender,
            _additionalTime,
            newExpiry,
            additionalAmount,
            totalAmount
        );
    }

    /**
     * @dev Resolves who may fund an extension and returns the owner whose stake backs it. The first extension snapshots
     *      the taker's current selection. Once snapshotted, revocation prevents the taker from adding that owner's
     *      exposure, but cannot prevent the owner from increasing its own existing lock.
     */
    function _authorizeIntentExtension(
        IntentExtensionPosition storage _position,
        address _taker,
        address _currentStakeOwner
    ) private view returns (address extensionStakeOwner) {
        extensionStakeOwner = _position.extensionStakeOwner;
        if (extensionStakeOwner == address(0)) extensionStakeOwner = _currentStakeOwner;

        if (msg.sender == extensionStakeOwner) return extensionStakeOwner;
        if (msg.sender != _taker || _currentStakeOwner != extensionStakeOwner) {
            revert UnauthorizedStakeExtension(msg.sender, _taker, extensionStakeOwner);
        }
    }

    /**
     * @dev Locates the immutable Escrow route for an active Orchestrator intent and reads its live expiry. Immutable
     *      intent fields are not revalidated. The route check covers the failed-open cancellation window after
     *      Orchestrator cleanup, while the expiry check prevents resurrection because Escrow permits extending an
     *      expired intent that has not yet been pruned. A missing Escrow intent has a zero expiry and fails the same
     *      expiry check.
     */
    function _getLiveExtensionTarget(bytes32 _intentHash)
        private
        view
        returns (IEscrowV2 escrow, uint256 depositId, uint64 currentExpiry)
    {
        IOrchestratorV3.IntentContext memory intent = _orchestrator().getIntentContext(_intentHash);
        if (intent.escrow == address(0)) {
            revert IntentStateMismatch(_intentHash);
        }

        escrow = IEscrowV2(intent.escrow);
        depositId = intent.depositId;
        IEscrowV2.Intent memory escrowIntent = escrow.getDepositIntent(depositId, _intentHash);

        currentExpiry = _toExtensionTimestamp(escrowIntent.expiryTime);
        uint64 currentTime = _currentExtensionTimestamp();
        if (currentTime >= currentExpiry) {
            revert IntentAlreadyExpired(_intentHash, currentExpiry, currentTime);
        }
    }

    /**
     * @dev Calculates the cumulative purchased time and resulting expiry, rejecting integer overflow and extensions
     *      beyond five days from the canonical creation timestamp.
     */
    function _calculateUpdatedExpiry(
        IntentExtensionPosition storage _position,
        uint64 _additionalTime,
        uint64 _currentExpiry,
        uint64 _createdAt
    ) private view returns (uint64 newTotalExtensionTime, uint64 newExpiry) {
        uint256 updatedExtensionTime = uint256(_position.totalExtensionTime) + _additionalTime;
        if (updatedExtensionTime > type(uint64).max) {
            revert ExtensionTimeOverflow(updatedExtensionTime);
        }

        newTotalExtensionTime = uint64(updatedExtensionTime);
        newExpiry = _toExtensionTimestamp(uint256(_currentExpiry) + _additionalTime);
        uint64 maximumExpiry = _toExtensionTimestamp(uint256(_createdAt) + MAX_TOTAL_INTENT_LIFETIME);
        if (newExpiry > maximumExpiry) {
            revert ExtensionExceedsIntentLifetime(newExpiry, maximumExpiry);
        }
    }

    /**
     * @dev Creates or increases the isolated never-maturing extension lock. A zero incremental amount requires no Vault
     *      mutation, but the Escrow expiry and cumulative time still advance under the upward-rounded pricing curve.
     */
    function _increaseExtensionLock(
        IStakeVault _vault,
        bytes32 _intentHash,
        address _extensionStakeOwner,
        uint256 _previousAmount,
        uint256 _totalAmount,
        uint256 _additionalAmount
    ) private {
        bytes32 lockId = _extensionLockId(_intentHash);
        if (_previousAmount == 0) {
            _vault.lockStake(_extensionStakeOwner, lockId, _totalAmount, EXTENSION_LOCK_MATURITY);
        } else if (_additionalAmount != 0) {
            _vault.increaseLock(lockId, _additionalAmount);
        }
    }

    /* ============ Internal Terminal Resolution ============ */

    /**
     * @dev Resolves extension exposure before chargeback cancellation or settlement accounting. The concrete
     *      coordinator supplies the original terminal timestamp, depositor, and intent amount from common state.
     *      Reconciliation must pass Orchestrator's persisted cancellation timestamp so callback delay cannot increase
     *      the extension penalty.
     *
     *      A non-zero penalty becomes one immediately claimable depositor allocation. The uncharged remainder becomes
     *      free stake of the snapshotted extension owner. No extension lock or amount survives this call.
     * @param _intentHash Intent whose extension exposure is reaching a terminal path.
     * @param _terminalAt Settlement or original cancellation timestamp used for elapsed-time pricing.
     * @param _depositor Beneficiary of any elapsed-time penalty.
     * @param _intentAmount Intent amount snapshotted by the coordinator at admission.
     * @return penalty Amount converted into an immediate depositor claim.
     * @return releasedAmount Amount returned to the extension stake owner's free stake.
     */
    function _resolveIntentExtension(bytes32 _intentHash, uint64 _terminalAt, address _depositor, uint256 _intentAmount)
        internal
        returns (uint256 penalty, uint256 releasedAmount)
    {
        IntentExtensionPosition storage position = intentExtensionPositions[_intentHash];
        if (position.extensionAmount == 0) return (0, 0);

        uint64 chargeableTime;
        (penalty, chargeableTime) = _calculateIntentExtensionPenalty(
            _intentAmount,
            position.baseIntentExpiry,
            _terminalAt,
            position.totalExtensionTime,
            position.extensionPenaltyBpsPerHour
        );
        releasedAmount = position.extensionAmount - penalty;
        position.extensionAmount = 0;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](penalty == 0 ? 0 : 1);
        if (penalty != 0) {
            claims[0] = IStakeVault.Claim({beneficiary: _depositor, amount: penalty});
        }
        _stakeVault().resolveLock(_extensionLockId(_intentHash), claims);

        emit IntentExtensionResolved(
            _intentHash, position.extensionStakeOwner, _depositor, _terminalAt, chargeableTime, penalty, releasedAmount
        );
    }

    /* ============ Internal Views ============ */

    /**
     * @dev Returns extension policy configured for future intents under a payment method.
     */
    function _getIntentExtensionConfig(bytes32 _paymentMethod) internal view returns (IntentExtensionConfig memory) {
        return intentExtensionConfigs[_paymentMethod];
    }

    /**
     * @dev Returns extension-specific state for aggregate RiskManager views and lifecycle events.
     */
    function _getIntentExtensionPosition(bytes32 _intentHash) internal view returns (IntentExtensionPosition memory) {
        return intentExtensionPositions[_intentHash];
    }

    /* ============ Internal Formula Helpers ============ */

    /**
     * @dev Implements `ceil(A * slope * time / (10_000 * 1 hour))` with full-precision multiplication. Zero-valued
     *      formula inputs naturally produce zero and are useful to external quote helpers exposed by the coordinator.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _extensionTime Number of purchased extension seconds being priced.
     * @param _extensionPenaltyBpsPerHour Hourly extension slope in basis points.
     * @return Upward-rounded cumulative extension cost.
     */
    function _calculateIntentExtensionCost(
        uint256 _intentAmount,
        uint64 _extensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) internal pure returns (uint256) {
        if (_intentAmount == 0 || _extensionTime == 0 || _extensionPenaltyBpsPerHour == 0) {
            return 0;
        }

        uint256 rateNumerator = uint256(_extensionPenaltyBpsPerHour) * _extensionTime;
        return Math.mulDiv(_intentAmount, rateNumerator, EXTENSION_DENOMINATOR, Math.Rounding.Up);
    }

    /**
     * @dev Prices only time used after the original expiry, capped by the purchased duration. Because this uses the same
     *      upward-rounded formula as the cumulative lock, the resulting penalty cannot exceed extension collateral.
     * @param _intentAmount Full amount of liquidity locked by the intent.
     * @param _baseIntentExpiry Original expiry before paid extensions.
     * @param _terminalAt Timestamp at which the intent settled or cancelled.
     * @param _totalExtensionTime Total number of purchased extension seconds.
     * @param _extensionPenaltyBpsPerHour Snapshotted hourly slope in basis points.
     * @return penalty Amount owed to the depositor.
     * @return chargeableTime Purchased extension seconds elapsed at the terminal timestamp.
     */
    function _calculateIntentExtensionPenalty(
        uint256 _intentAmount,
        uint64 _baseIntentExpiry,
        uint64 _terminalAt,
        uint64 _totalExtensionTime,
        uint32 _extensionPenaltyBpsPerHour
    ) internal pure returns (uint256 penalty, uint64 chargeableTime) {
        if (_terminalAt <= _baseIntentExpiry || _totalExtensionTime == 0) {
            return (0, 0);
        }

        uint256 elapsedAfterBaseExpiry = uint256(_terminalAt - _baseIntentExpiry);
        chargeableTime = uint64(Math.min(elapsedAfterBaseExpiry, _totalExtensionTime));
        penalty = _calculateIntentExtensionCost(_intentAmount, chargeableTime, _extensionPenaltyBpsPerHour);
    }

    /**
     * @dev Derives a collision-resistant Vault key disjoint from the raw intent hash used for chargeback coverage.
     * @param _intentHash Intent identifier to namespace.
     * @return Extension lock identifier.
     */
    function _extensionLockId(bytes32 _intentHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXTENSION_LOCK_NAMESPACE, _intentHash));
    }

    /**
     * @dev Returns the current block timestamp after checked narrowing to extension storage width.
     */
    function _currentExtensionTimestamp() internal view returns (uint64) {
        return _toExtensionTimestamp(block.timestamp);
    }

    /**
     * @dev Narrows a timestamp after rejecting values that cannot be represented in extension or Vault storage.
     */
    function _toExtensionTimestamp(uint256 _timestamp) internal pure returns (uint64) {
        if (_timestamp > type(uint64).max) revert TimestampOverflow(_timestamp);
        return uint64(_timestamp);
    }

    /* ============ Coordinator Dependency Accessors ============ */

    /**
     * @dev Returns the immutable canonical Orchestrator owned by the concrete coordinator.
     */
    function _orchestrator() internal view virtual returns (IOrchestratorV3);

    /**
     * @dev Returns the immutable StakeVault controlled by the concrete coordinator.
     */
    function _stakeVault() internal view virtual returns (IStakeVault);
}
