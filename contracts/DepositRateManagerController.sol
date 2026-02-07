// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IDepositRateManagerRegistryV1 } from "./interfaces/IDepositRateManagerRegistryV1.sol";
import { IDepositRateManagerHook } from "./interfaces/IDepositRateManagerHook.sol";
import { IDepositRateManagerController } from "./interfaces/IDepositRateManagerController.sol";

/**
 * @dev Minimal interface for pause checks on Escrow.
 */
interface IPausable {
    function paused() external view returns (bool);
}

/**
 * @title DepositRateManagerController
 * @notice External controller that stores per-deposit rate manager config and computes effective min rates.
 */
contract DepositRateManagerController is IDepositRateManagerController {
    /* ============ Structs ============ */

    struct DepositManagerConfig {
        address registry;
        bytes32 rateManagerId;
    }

    /* ============ State Variables ============ */

    // escrow => depositId => config
    mapping(address => mapping(uint256 => DepositManagerConfig)) internal depositManagerConfig;

    /* ============ External Functions ============ */

    /**
     * @notice Opt a deposit into a rate manager configuration.
     * @dev Only the depositor can opt in. Reverts if escrow is paused, inputs are zero,
     *      or the rate manager id is not registered. If a manager hook is configured,
     *      it is called (view) and may revert to reject the opt-in.
     * @param _escrow         Escrow contract address.
     * @param _depositId      Deposit id on the escrow.
     * @param _registry       DepositRateManagerRegistryV1 address.
     * @param _rateManagerId  Manager id to opt into.
     */
    function setDepositRateManager(
        address _escrow,
        uint256 _depositId,
        address _registry,
        bytes32 _rateManagerId
    )
        external
    {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_rateManagerId == bytes32(0)) revert ZeroValue();
        if (_registry == address(0)) revert ZeroAddress();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        IDepositRateManagerRegistryV1 registry = IDepositRateManagerRegistryV1(_registry);
        if (!registry.isRateManager(_rateManagerId)) revert RateManagerNotFound(_rateManagerId);

        address hook = registry.getDepositHook(_rateManagerId);
        if (hook != address(0)) {
            IDepositRateManagerHook(hook).onDepositOptIn(msg.sender, _escrow, _depositId, _rateManagerId);
        }

        depositManagerConfig[_escrow][_depositId] = DepositManagerConfig({
            registry: _registry,
            rateManagerId: _rateManagerId
        });

        emit DepositRateManagerUpdated(_escrow, _depositId, _registry, _rateManagerId);
    }

    /**
     * @notice Clear the rate manager for a deposit.
     * @dev Only the depositor can clear. Reverts if escrow is paused.
     *      Emits DepositRateManagerUpdated with the previous registry and a zero id.
     * @param _escrow    Escrow contract address.
     * @param _depositId Deposit id on the escrow.
     */
    function clearDepositRateManager(address _escrow, uint256 _depositId) external {
        if (_escrow == address(0)) revert ZeroAddress();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        DepositManagerConfig memory prev = depositManagerConfig[_escrow][_depositId];
        delete depositManagerConfig[_escrow][_depositId];

        emit DepositRateManagerUpdated(_escrow, _depositId, prev.registry, bytes32(0));
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the effective minimum conversion rate for a deposit/currency pair.
     * @dev If no manager is set, returns the depositor floor. If manager disables the pair
     *      (min rate = 0) or payment method is inactive, returns 0. Reverts if a manager
     *      is set but the registry address is missing.
     * @param _escrow        Escrow contract address.
     * @param _depositId     Deposit id on the escrow.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode  Currency code key.
     * @return minRate       Effective minimum conversion rate in precise units.
     */
    function getEffectiveMinRate(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (uint256)
    {
        uint256 floorRate = IEscrow(_escrow).getDepositCurrencyMinRate(_depositId, _paymentMethod, _currencyCode);
        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];

        if (cfg.rateManagerId == bytes32(0)) {
            return floorRate;
        }

        // Payment method must be active at the deposit level.
        if (!IEscrow(_escrow).getDepositPaymentMethodActive(_depositId, _paymentMethod)) {
            return 0;
        }

        if (cfg.registry == address(0)) revert RateManagerRegistryNotSet();

        uint256 managerRate = IDepositRateManagerRegistryV1(cfg.registry).getMinRate(cfg.rateManagerId, _paymentMethod, _currencyCode);
        if (managerRate == 0) {
            return 0;
        }

        return managerRate > floorRate ? managerRate : floorRate;
    }

    /**
     * @notice Returns the manager fee recipient and fee for a deposit.
     * @dev Returns (address(0), 0) if no manager is set. Reverts if a manager
     *      is set but the registry address is missing.
     * @param _escrow    Escrow contract address.
     * @param _depositId Deposit id on the escrow.
     * @return recipient Fee recipient.
     * @return fee       Fee in precise units.
     */
    function getManagerFee(address _escrow, uint256 _depositId) external view returns (address recipient, uint256 fee) {
        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];
        if (cfg.rateManagerId == bytes32(0)) {
            return (address(0), 0);
        }

        if (cfg.registry == address(0)) revert RateManagerRegistryNotSet();

        (uint256 mgrFee, address mgrRecipient) = IDepositRateManagerRegistryV1(cfg.registry).getFeeAndRecipient(cfg.rateManagerId);
        return (mgrRecipient, mgrFee);
    }

    /**
     * @notice Returns the stored (registry, rateManagerId) for a deposit.
     * @dev Returns (address(0), 0) if the deposit has not opted into a manager.
     * @param _escrow    Escrow contract address.
     * @param _depositId Deposit id on the escrow.
     * @return registry      Registry address.
     * @return rateManagerId Manager id.
     */
    function getDepositRateManager(address _escrow, uint256 _depositId) external view returns (address registry, bytes32 rateManagerId) {
        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];
        return (cfg.registry, cfg.rateManagerId);
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Reverts if the escrow is paused.
     * @param _escrow Escrow contract address.
     */
    function _requireNotPaused(address _escrow) internal view {
        if (IPausable(_escrow).paused()) revert("Pausable: paused");
    }
}
