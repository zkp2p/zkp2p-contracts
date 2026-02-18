// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IBaseRateManagerRegistry } from "./interfaces/IBaseRateManagerRegistry.sol";
import { IOracleAdapter } from "./interfaces/IOracleAdapter.sol";
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
    using Math for uint256;

    /* ============ Constants ============ */

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_ADAPTER_CONFIG_BYTES = 256;

    /* ============ Structs ============ */

    struct DepositManagerConfig {
        address registry;
        bytes32 rateManagerId;
    }

    struct DepositOracleFloorConfig {
        address adapter;
        bytes adapterConfig;
        uint16 spreadBps;
        uint32 maxStaleness;
        bool isConfigured;
    }

    /* ============ State Variables ============ */

    // escrow => depositId => config
    mapping(address => mapping(uint256 => DepositManagerConfig)) internal depositManagerConfig;
    // escrow => depositId => paymentMethod => currencyCode => oracle floor config
    mapping(address => mapping(uint256 => mapping(bytes32 => mapping(bytes32 => DepositOracleFloorConfig)))) internal depositOracleFloorConfig;

    /* ============ External Functions ============ */

    /**
     * @notice Opt a deposit into a rate manager configuration.
     * @dev Only the depositor can opt in. Reverts if escrow is paused, inputs are zero,
     *      a manager is already set, or the rate manager id is not registered. If a manager
     *      hook is configured, it is called (view) and may revert to reject the opt-in.
     * @param _escrow         Escrow contract address.
     * @param _depositId      Deposit id on the escrow.
     * @param _registry       Rate manager registry address.
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

        DepositManagerConfig memory existing = depositManagerConfig[_escrow][_depositId];
        if (existing.rateManagerId != bytes32(0)) revert RateManagerAlreadySet(existing.rateManagerId);

        IBaseRateManagerRegistry registry = IBaseRateManagerRegistry(_registry);
        if (!registry.isRateManager(_rateManagerId)) revert RateManagerNotFound(_rateManagerId);

        address hook = registry.getDepositHook(_rateManagerId);
        if (hook != address(0)) {
            IDepositRateManagerHook(hook).onDepositOptIn(msg.sender, _escrow, _depositId, _registry, _rateManagerId);
        }

        depositManagerConfig[_escrow][_depositId] = DepositManagerConfig({
            registry: _registry,
            rateManagerId: _rateManagerId
        });

        emit DepositRateManagerSet(_escrow, _depositId, _registry, _rateManagerId);
    }

    /**
     * @notice Clear the rate manager for a deposit.
     * @dev Only the depositor can clear. Reverts if escrow is paused.
     *      Emits DepositRateManagerCleared with the previous registry and manager id.
     * @param _escrow    Escrow contract address.
     * @param _depositId Deposit id on the escrow.
     */
    function clearDepositRateManager(address _escrow, uint256 _depositId) external {
        if (_escrow == address(0)) revert ZeroAddress();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);

        DepositManagerConfig memory prev = depositManagerConfig[_escrow][_depositId];
        if (prev.rateManagerId == bytes32(0)) revert RateManagerNotFound(bytes32(0));
        delete depositManagerConfig[_escrow][_depositId];

        emit DepositRateManagerCleared(_escrow, _depositId, prev.registry, prev.rateManagerId);
    }

    /**
     * @notice Sets or updates oracle floor config for a specific payment method + currency on a deposit.
     * @dev Only callable by the depositor or delegate set on the deposit.
     */
    function setDepositOracleFloorConfig(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        address _adapter,
        bytes calldata _rawAdapterConfig,
        uint16 _spreadBps,
        uint32 _maxStaleness
    )
        external
    {
        if (_escrow == address(0)) revert ZeroAddress();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        _requireDepositorOrDelegate(deposit);

        _setDepositOracleFloorConfig(
            _escrow,
            _depositId,
            _paymentMethod,
            _currencyCode,
            _adapter,
            _rawAdapterConfig,
            _spreadBps,
            _maxStaleness
        );
    }

    /**
     * @notice Batch sets or updates oracle floor configs for a deposit.
     * @dev Only callable by the depositor or delegate set on the deposit.
     */
    function setDepositOracleFloorConfigs(
        address _escrow,
        uint256 _depositId,
        OracleFloorConfigInput[] calldata _oracleFloorConfigs
    )
        external
    {
        if (_escrow == address(0)) revert ZeroAddress();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        _requireDepositorOrDelegate(deposit);

        uint256 configCount = _oracleFloorConfigs.length;
        for (uint256 i = 0; i < configCount; i++) {
            OracleFloorConfigInput calldata floorConfig = _oracleFloorConfigs[i];
            _setDepositOracleFloorConfig(
                _escrow,
                _depositId,
                floorConfig.paymentMethod,
                floorConfig.currencyCode,
                floorConfig.adapter,
                floorConfig.rawAdapterConfig,
                floorConfig.spreadBps,
                floorConfig.maxStaleness
            );
        }
    }

    /**
     * @notice Clears oracle floor config for a specific payment method + currency on a deposit.
     * @dev Only callable by the depositor or delegate set on the deposit.
     */
    function clearDepositOracleFloorConfig(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
    {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_paymentMethod == bytes32(0)) revert InvalidPaymentMethod();
        if (_currencyCode == bytes32(0)) revert InvalidCurrency();

        _requireNotPaused(_escrow);

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        _requireDepositorOrDelegate(deposit);

        DepositOracleFloorConfig storage cfg = depositOracleFloorConfig[_escrow][_depositId][_paymentMethod][_currencyCode];
        if (!cfg.isConfigured) revert OracleFloorConfigNotSet();

        delete depositOracleFloorConfig[_escrow][_depositId][_paymentMethod][_currencyCode];
        emit DepositOracleFloorConfigCleared(_escrow, _depositId, _paymentMethod, _currencyCode);
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

        // Enforce escrow-level currency whitelist.
        if (floorRate == 0) {
            return 0;
        }

        DepositOracleFloorConfig storage floorCfg = depositOracleFloorConfig[_escrow][_depositId][_paymentMethod][_currencyCode];
        if (floorCfg.isConfigured) {
            floorRate = _getEffectiveOracleFloorRate(floorCfg, floorRate);
        }

        DepositManagerConfig memory cfg = depositManagerConfig[_escrow][_depositId];

        if (cfg.rateManagerId == bytes32(0)) {
            return floorRate;
        }

        // Payment method must be active at the deposit level.
        if (!IEscrow(_escrow).getDepositPaymentMethodActive(_depositId, _paymentMethod)) {
            return 0;
        }

        if (cfg.registry == address(0)) revert RateManagerRegistryNotSet();

        uint256 managerRate = IBaseRateManagerRegistry(cfg.registry).getMinRate(cfg.rateManagerId, _paymentMethod, _currencyCode);
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

        (uint256 mgrFee, address mgrRecipient) = IBaseRateManagerRegistry(cfg.registry).getFeeAndRecipient(cfg.rateManagerId);
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

    /**
     * @notice Returns the depositor oracle floor config for a specific tuple.
     */
    function getDepositOracleFloorConfig(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (
            bool isConfigured,
            address adapter,
            bytes memory adapterConfig,
            uint16 spreadBps,
            uint32 maxStaleness
        )
    {
        DepositOracleFloorConfig storage cfg = depositOracleFloorConfig[_escrow][_depositId][_paymentMethod][_currencyCode];
        return (cfg.isConfigured, cfg.adapter, cfg.adapterConfig, cfg.spreadBps, cfg.maxStaleness);
    }

    /* ============ Internal Functions ============ */

    function _setDepositOracleFloorConfig(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        address _adapter,
        bytes calldata _rawAdapterConfig,
        uint16 _spreadBps,
        uint32 _maxStaleness
    )
        internal
    {
        if (_paymentMethod == bytes32(0)) revert InvalidPaymentMethod();
        if (_currencyCode == bytes32(0)) revert InvalidCurrency();
        if (_adapter == address(0) || _adapter.code.length == 0) revert InvalidAdapter();
        if (_spreadBps > BPS) revert InvalidSpread();
        if (_maxStaleness == 0) revert InvalidStaleness();

        bytes memory normalizedAdapterConfig = IOracleAdapter(_adapter).validateConfig(_rawAdapterConfig);
        if (normalizedAdapterConfig.length > MAX_ADAPTER_CONFIG_BYTES) revert InvalidAdapterConfig();

        depositOracleFloorConfig[_escrow][_depositId][_paymentMethod][_currencyCode] = DepositOracleFloorConfig({
            adapter: _adapter,
            adapterConfig: normalizedAdapterConfig,
            spreadBps: _spreadBps,
            maxStaleness: _maxStaleness,
            isConfigured: true
        });

        emit DepositOracleFloorConfigUpdated(
            _escrow,
            _depositId,
            _paymentMethod,
            _currencyCode,
            _adapter,
            _spreadBps,
            _maxStaleness,
            normalizedAdapterConfig
        );
    }

    function _getEffectiveOracleFloorRate(
        DepositOracleFloorConfig storage _oracleFloorConfig,
        uint256 _fixedFloorRate
    )
        internal
        view
        returns (uint256)
    {
        (bool isValidQuote, uint256 marketRate, uint256 rateUpdatedAt) = _getOracleRate(_oracleFloorConfig);
        if (!isValidQuote || marketRate == 0) {
            return _fixedFloorRate;
        }
        if (rateUpdatedAt == 0 || rateUpdatedAt > block.timestamp) {
            return _fixedFloorRate;
        }
        if (block.timestamp - rateUpdatedAt > _oracleFloorConfig.maxStaleness) {
            return _fixedFloorRate;
        }

        uint256 dynamicFloorRate =
            Math.mulDiv(marketRate, BPS + uint256(_oracleFloorConfig.spreadBps), BPS, Math.Rounding.Up);
        return dynamicFloorRate > _fixedFloorRate ? dynamicFloorRate : _fixedFloorRate;
    }

    function _getOracleRate(DepositOracleFloorConfig storage _oracleFloorConfig)
        internal
        view
        returns (bool isValidQuote, uint256 marketRate, uint256 rateUpdatedAt)
    {
        try IOracleAdapter(_oracleFloorConfig.adapter).getRate(_oracleFloorConfig.adapterConfig) returns (
            bool valid_,
            uint256 rate_,
            uint256 updatedAt_
        ) {
            return (valid_, rate_, updatedAt_);
        } catch {
            return (false, 0, 0);
        }
    }

    function _requireDepositorOrDelegate(IEscrow.Deposit memory _deposit) internal view {
        if (msg.sender != _deposit.depositor && msg.sender != _deposit.delegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, _deposit.depositor, _deposit.delegate);
        }
    }

    /**
     * @dev Reverts if the escrow is paused.
     * @param _escrow Escrow contract address.
     */
    function _requireNotPaused(address _escrow) internal view {
        if (IPausable(_escrow).paused()) revert("Pausable: paused");
    }
}
