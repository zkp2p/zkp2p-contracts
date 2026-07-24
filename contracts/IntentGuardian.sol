// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEscrowV2} from "./interfaces/IEscrowV2.sol";
import {IEscrowRegistry} from "./interfaces/IEscrowRegistry.sol";
import {IIntentGuardian} from "./interfaces/IIntentGuardian.sol";

/**
 * @title IntentGuardian
 * @notice Extends live Escrow intents in exchange for a prepaid, non-refundable fee.
 * @dev Extension fees are transferred immediately to the deposit's depositor.
 */
contract IntentGuardian is IIntentGuardian, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_HOUR = 1 hours;
    uint256 public constant EXTENSION_FEE_DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_HOUR;
    uint256 public constant MAX_TOTAL_INTENT_LIFETIME = 5 days;

    IEscrowRegistry public immutable override escrowRegistry;
    uint256 public override extensionFeeBpsPerHour;

    constructor(address _owner, IEscrowRegistry _escrowRegistry) {
        escrowRegistry = _escrowRegistry;
        _transferOwnership(_owner);
    }

    /**
     * @notice Sets the hourly fee applied to subsequent intent extensions.
     * @param _extensionFeeBpsPerHour Hourly extension fee in basis points, or zero to disable extensions.
     */
    function setExtensionFeeBpsPerHour(uint256 _extensionFeeBpsPerHour) external override onlyOwner {
        if (_extensionFeeBpsPerHour * MAX_TOTAL_INTENT_LIFETIME > EXTENSION_FEE_DENOMINATOR) {
            revert ExtensionFeeExceedsIntentAmount(_extensionFeeBpsPerHour);
        }

        extensionFeeBpsPerHour = _extensionFeeBpsPerHour;
        emit ExtensionFeeUpdated(_extensionFeeBpsPerHour);
    }

    /**
     * @notice Prepays the deposit's maker to extend a live intent.
     * @param _escrow Whitelisted escrow holding the deposit and intent.
     * @param _depositId Escrow deposit containing the intent.
     * @param _intentHash Identifier of the intent to extend.
     * @param _additionalTime Number of seconds to add to the current expiry.
     * @param _maxCost Maximum fee the payer agrees to transfer.
     */
    function extendIntent(
        IEscrowV2 _escrow,
        uint256 _depositId,
        bytes32 _intentHash,
        uint256 _additionalTime,
        uint256 _maxCost
    ) external override {
        uint256 feeBpsPerHour = extensionFeeBpsPerHour;
        if (feeBpsPerHour == 0) revert ExtensionsDisabled();

        if (!escrowRegistry.isAcceptingAllEscrows() && !escrowRegistry.isWhitelistedEscrow(address(_escrow))) {
            revert EscrowNotWhitelisted(address(_escrow));
        }

        IEscrowV2.Deposit memory deposit = _escrow.getDeposit(_depositId);
        IEscrowV2.Intent memory intent = _escrow.getDepositIntent(_depositId, _intentHash);

        if (block.timestamp >= intent.expiryTime) {
            revert IntentAlreadyExpired(_intentHash, intent.expiryTime, block.timestamp);
        }

        _escrow.extendIntentExpiry(_depositId, _intentHash, _additionalTime);

        uint256 cost = Math.mulDiv(
            intent.amount,
            feeBpsPerHour * _additionalTime,
            EXTENSION_FEE_DENOMINATOR,
            Math.Rounding.Up
        );
        if (cost > _maxCost) revert ExtensionCostExceedsMax(cost, _maxCost);

        deposit.token.safeTransferFrom(msg.sender, deposit.depositor, cost);

        emit IntentExtended(_depositId, _intentHash, msg.sender, _additionalTime, cost);
    }

    /**
     * @notice Quotes the prepaid fee for an intent extension using the current hourly rate.
     * @param _intentAmount Amount locked by the intent.
     * @param _additionalTime Number of extension seconds to price.
     * @return Upward-rounded extension fee.
     */
    function quoteExtensionCost(uint256 _intentAmount, uint256 _additionalTime)
        external
        view
        override
        returns (uint256)
    {
        return Math.mulDiv(
            _intentAmount,
            extensionFeeBpsPerHour * _additionalTime,
            EXTENSION_FEE_DENOMINATOR,
            Math.Rounding.Up
        );
    }
}
