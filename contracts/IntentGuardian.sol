// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEscrow} from "./interfaces/IEscrow.sol";
import {IEscrowRegistry} from "./interfaces/IEscrowRegistry.sol";
import {IIntentGuardian} from "./interfaces/IIntentGuardian.sol";

/**
 * @title IntentGuardian
 * @notice Extends live Escrow intents in exchange for a prepaid, non-refundable fee.
 * @dev Escrow and EscrowV2 expose the same Deposit and Intent ABI used here. Governance can update
 *      the extension fee for every deposit using this guardian address.
 */
contract IntentGuardian is IIntentGuardian, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_HOUR = 1 hours;
    uint256 public constant EXTENSION_FEE_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;
    uint256 public constant MAX_TOTAL_INTENT_LIFETIME = 5 days;
    uint256 public constant MAX_EXTENSION_FEE_BPS_PER_HOUR = EXTENSION_FEE_DENOMINATOR / MAX_TOTAL_INTENT_LIFETIME;

    IEscrowRegistry public immutable override escrowRegistry;
    uint256 public override extensionFeeBpsPerHour;

    constructor(address _owner, IEscrowRegistry _escrowRegistry, uint256 _extensionFeeBpsPerHour) {
        if (_owner == address(0)) revert ZeroAddress();
        if (address(_escrowRegistry) == address(0)) revert ZeroAddress();

        escrowRegistry = _escrowRegistry;
        _transferOwnership(_owner);
        _setExtensionFeeBpsPerHour(_extensionFeeBpsPerHour);
    }

    /// @inheritdoc IIntentGuardian
    function setExtensionFeeBpsPerHour(uint256 _extensionFeeBpsPerHour) external override onlyOwner {
        _setExtensionFeeBpsPerHour(_extensionFeeBpsPerHour);
    }

    /**
     * @inheritdoc IIntentGuardian
     * @dev The compatible Escrow enforces guardian authorization, non-zero time, and the cumulative
     *      five-day lifetime cap. All state and token movements revert atomically on payment failure.
     */
    function extendIntent(
        address _escrow,
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _additionalTime,
        uint256 _maxCost
    ) external override nonReentrant {
        uint256 feeBpsPerHour = extensionFeeBpsPerHour;
        if (feeBpsPerHour == 0) revert ExtensionsDisabled();

        if (!escrowRegistry.isAcceptingAllEscrows() && !escrowRegistry.isWhitelistedEscrow(_escrow)) {
            revert EscrowNotWhitelisted(_escrow);
        }

        IEscrow escrow = IEscrow(_escrow);
        IEscrow.Deposit memory deposit = escrow.getDeposit(_depositId);
        IEscrow.Intent memory intent = escrow.getDepositIntent(_depositId, _intentHash);

        if (block.timestamp >= intent.expiryTime) {
            revert IntentAlreadyExpired(_intentHash, intent.expiryTime, block.timestamp);
        }

        escrow.extendIntentExpiry(_depositId, _intentHash, _additionalTime);

        uint256 cost = _quoteExtensionCost(intent.amount, _additionalTime, feeBpsPerHour);
        if (cost > _maxCost) revert ExtensionCostExceedsMax(cost, _maxCost);

        deposit.token.safeTransferFrom(msg.sender, deposit.depositor, cost);

        emit IntentExtended(_escrow, _depositId, _intentHash, msg.sender, _additionalTime, cost);
    }

    /// @inheritdoc IIntentGuardian
    function quoteExtensionCost(uint256 _intentAmount, uint256 _additionalTime)
        external
        view
        override
        returns (uint256)
    {
        return _quoteExtensionCost(_intentAmount, _additionalTime, extensionFeeBpsPerHour);
    }

    function _quoteExtensionCost(uint256 _intentAmount, uint256 _additionalTime, uint256 _feeBpsPerHour)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(_intentAmount, _feeBpsPerHour * _additionalTime, EXTENSION_FEE_DENOMINATOR, Math.Rounding.Up);
    }

    function _setExtensionFeeBpsPerHour(uint256 _extensionFeeBpsPerHour) internal {
        if (_extensionFeeBpsPerHour > MAX_EXTENSION_FEE_BPS_PER_HOUR) {
            revert ExtensionFeeExceedsIntentAmount(_extensionFeeBpsPerHour);
        }

        uint256 previousFeeBpsPerHour = extensionFeeBpsPerHour;
        extensionFeeBpsPerHour = _extensionFeeBpsPerHour;
        emit ExtensionFeeBpsPerHourUpdated(previousFeeBpsPerHour, _extensionFeeBpsPerHour);
    }
}
