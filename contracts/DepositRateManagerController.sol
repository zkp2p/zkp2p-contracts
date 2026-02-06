// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IDepositRateManagerRegistryV1 } from "./interfaces/IDepositRateManagerRegistryV1.sol";
import { IDepositRateManagerHook } from "./interfaces/IDepositRateManagerHook.sol";
import { IDepositRateManagerController } from "./interfaces/IDepositRateManagerController.sol";

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

    mapping(address => mapping(uint256 => DepositManagerConfig)) internal depositManagerConfig;

    /* ============ External Functions ============ */

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

    function getManagerFee(address _escrow, uint256 _depositId) external view returns (address recipient, uint256 fee) {
        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];
        if (cfg.rateManagerId == bytes32(0)) {
            return (address(0), 0);
        }

        if (cfg.registry == address(0)) revert RateManagerRegistryNotSet();

        (uint256 mgrFee, address mgrRecipient) = IDepositRateManagerRegistryV1(cfg.registry).getFeeAndRecipient(cfg.rateManagerId);
        return (mgrRecipient, mgrFee);
    }

    function getDepositRateManager(address _escrow, uint256 _depositId) external view returns (address registry, bytes32 rateManagerId) {
        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];
        return (cfg.registry, cfg.rateManagerId);
    }

    /* ============ Internal Functions ============ */

    function _requireNotPaused(address _escrow) internal view {
        if (IPausable(_escrow).paused()) revert("Pausable: paused");
    }
}
