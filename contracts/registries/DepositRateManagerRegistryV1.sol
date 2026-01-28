//SPDX-License-Identifier: MIT

import { IDepositRateManagerRegistryV1 } from "../interfaces/IDepositRateManagerRegistryV1.sol";

pragma solidity ^0.8.18;

/**
 * @title DepositRateManagerRegistryV1
 * @notice Permissionless registry of “deposit rate managers”.
 * A rate manager defines:
 * - A per-fill manager fee (flat bps in preciseUnits)
 * - A minimum deposit size to opt in (anti-shrimp)
 * - A set of (paymentMethod, currency) -> minConversionRate values
 *
 * V1 policy: the manager fee is immutable per `rateManagerId`. To change fee, create a new id.
 */
contract DepositRateManagerRegistryV1 is IDepositRateManagerRegistryV1 {
    /* ============ Constants ============ */

    uint256 internal constant MAX_MANAGER_FEE = 5e16; // 5%

    /* ============ State Variables ============ */

    mapping(bytes32 => RateManagerConfig) internal rateManagers;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => uint256))) internal minRates;

    /* ============ Modifiers ============ */

    modifier onlyManager(bytes32 _rateManagerId) {
        address manager = rateManagers[_rateManagerId].manager;
        require(manager != address(0), "Rate manager does not exist");
        require(msg.sender == manager, "Caller is not manager");
        _;
    }

    /* ============ External Functions ============ */

    function createRateManager(bytes32 _rateManagerId, RateManagerConfig calldata _config) external {
        require(_rateManagerId != bytes32(0), "Invalid rateManagerId");
        require(rateManagers[_rateManagerId].manager == address(0), "Rate manager already exists");
        require(_config.manager != address(0), "Invalid manager");
        require(_config.fee <= MAX_MANAGER_FEE, "Fee exceeds maximum");
        if (_config.fee > 0) {
            require(_config.feeRecipient != address(0), "Invalid fee recipient");
        }

        rateManagers[_rateManagerId] = _config;

        emit RateManagerCreated(
            _rateManagerId,
            _config.manager,
            _config.feeRecipient,
            _config.fee,
            _config.minDelegationAmount,
            _config.name,
            _config.uri
        );
    }

    function setRateManagerConfig(
        bytes32 _rateManagerId,
        address _newManager,
        address _newFeeRecipient,
        uint256 _newMinDelegationAmount,
        string calldata _newName,
        string calldata _newUri
    ) external onlyManager(_rateManagerId) {
        require(_newManager != address(0), "Invalid manager");

        // Fee is immutable in V1; enforce that a feeRecipient exists if fee > 0.
        if (rateManagers[_rateManagerId].fee > 0) {
            require(_newFeeRecipient != address(0), "Invalid fee recipient");
        }

        RateManagerConfig storage config = rateManagers[_rateManagerId];
        config.manager = _newManager;
        config.feeRecipient = _newFeeRecipient;
        config.minDelegationAmount = _newMinDelegationAmount;
        config.name = _newName;
        config.uri = _newUri;

        emit RateManagerConfigUpdated(
            _rateManagerId,
            _newManager,
            _newFeeRecipient,
            _newMinDelegationAmount,
            _newName,
            _newUri
        );
    }

    function setMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate)
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethod != bytes32(0), "Invalid payment method");
        require(_currency != bytes32(0), "Invalid currency");

        minRates[_rateManagerId][_paymentMethod][_currency] = _minRate;

        emit RateManagerMinRateUpdated(_rateManagerId, _paymentMethod, _currency, _minRate);
    }

    function setMinRatesBatch(
        bytes32 _rateManagerId,
        bytes32[] calldata _paymentMethods,
        bytes32[] calldata _currencies,
        uint256[] calldata _minRates
    ) external onlyManager(_rateManagerId) {
        require(_paymentMethods.length == _currencies.length, "Array length mismatch");
        require(_paymentMethods.length == _minRates.length, "Array length mismatch");

        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            bytes32 paymentMethod = _paymentMethods[i];
            bytes32 currency = _currencies[i];

            require(paymentMethod != bytes32(0), "Invalid payment method");
            require(currency != bytes32(0), "Invalid currency");

            minRates[_rateManagerId][paymentMethod][currency] = _minRates[i];
            emit RateManagerMinRateUpdated(_rateManagerId, paymentMethod, currency, _minRates[i]);
        }

        emit RateManagerMinRatesBatchUpdated(_rateManagerId, _paymentMethods.length);
    }

    /* ============ External View Functions ============ */

    function isRateManager(bytes32 _rateManagerId) external view returns (bool) {
        return rateManagers[_rateManagerId].manager != address(0);
    }

    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory) {
        return rateManagers[_rateManagerId];
    }

    function getFee(bytes32 _rateManagerId) external view returns (address feeRecipient, uint256 fee) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        return (config.feeRecipient, config.fee);
    }

    function getMinDelegationAmount(bytes32 _rateManagerId) external view returns (uint256) {
        return rateManagers[_rateManagerId].minDelegationAmount;
    }

    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view returns (uint256) {
        return minRates[_rateManagerId][_paymentMethod][_currency];
    }
}

