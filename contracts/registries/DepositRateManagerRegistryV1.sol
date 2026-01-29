//SPDX-License-Identifier: MIT

import { IDepositRateManagerRegistryV1 } from "../interfaces/IDepositRateManagerRegistryV1.sol";

pragma solidity ^0.8.18;

/**
 * @title DepositRateManagerRegistryV1
 * @notice Permissionless registry of “deposit rate managers”.
 * Stores manager fee config, optional deposit hook, and (paymentMethod,currency)->minRate entries.
 */
contract DepositRateManagerRegistryV1 is IDepositRateManagerRegistryV1 {
    /* ============ Constants ============ */

    uint256 internal constant GLOBAL_MAX_MANAGER_FEE = 5e16; // 5%

    /* ============ State Variables ============ */

    uint256 internal nextId = 1;
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

    function createRateManager(RateManagerConfig calldata _config) external returns (bytes32 rateManagerId) {
        require(_config.manager != address(0), "Invalid manager");
        require(_config.feeRecipient != address(0) || _config.fee == 0, "Invalid fee recipient");
        require(_config.maxFee <= GLOBAL_MAX_MANAGER_FEE, "Max fee exceeds global");
        require(_config.fee <= _config.maxFee, "Fee exceeds maxFee");
        // keccak(address(this), nextId)
        rateManagerId = keccak256(abi.encodePacked(address(this), nextId++));
        rateManagers[rateManagerId] = _config;

        emit RateManagerCreated(
            rateManagerId,
            _config.manager,
            _config.feeRecipient,
            _config.maxFee,
            _config.fee,
            _config.name,
            _config.uri
        );
    }

    function setRateManagerConfig(
        bytes32 _rateManagerId,
        address _newManager,
        address _newFeeRecipient,
        address _newHook,
        string calldata _newName,
        string calldata _newUri
    ) external onlyManager(_rateManagerId) {
        require(_newManager != address(0), "Invalid manager");
        if (rateManagers[_rateManagerId].fee > 0) {
            require(_newFeeRecipient != address(0), "Invalid fee recipient");
        }

        RateManagerConfig storage config = rateManagers[_rateManagerId];
        config.manager = _newManager;
        config.feeRecipient = _newFeeRecipient;
        config.depositHook = _newHook;
        config.name = _newName;
        config.uri = _newUri;

        emit RateManagerConfigUpdated(
            _rateManagerId,
            _newManager,
            _newFeeRecipient,
            _newHook,
            _newName,
            _newUri
        );
    }

    function setFee(bytes32 _rateManagerId, uint256 _newFee) external onlyManager(_rateManagerId) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        require(_newFee <= config.maxFee, "Fee exceeds maxFee");
        if (_newFee > 0) {
            require(config.feeRecipient != address(0), "Invalid fee recipient");
        }
        config.fee = _newFee;
        emit RateManagerFeeUpdated(_rateManagerId, _newFee);
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
        bytes32[][] calldata _currencies,
        uint256[][] calldata _minRatesArr
    ) external onlyManager(_rateManagerId) {
        require(_paymentMethods.length == _currencies.length, "Array length mismatch");
        require(_paymentMethods.length == _minRatesArr.length, "Array length mismatch");

        uint256 total;
        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            bytes32 pm = _paymentMethods[i];
            require(pm != bytes32(0), "Invalid payment method");
            bytes32[] calldata currList = _currencies[i];
            uint256[] calldata rateList = _minRatesArr[i];
            require(currList.length == rateList.length, "Array length mismatch");
            for (uint256 j = 0; j < currList.length; j++) {
                bytes32 cur = currList[j];
                require(cur != bytes32(0), "Invalid currency");
                minRates[_rateManagerId][pm][cur] = rateList[j];
                emit RateManagerMinRateUpdated(_rateManagerId, pm, cur, rateList[j]);
                total++;
            }
        }
        emit RateManagerMinRatesBatchUpdated(_rateManagerId, total);
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

    function getDepositHook(bytes32 _rateManagerId) external view returns (address) {
        return rateManagers[_rateManagerId].depositHook;
    }

    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view returns (uint256) {
        return minRates[_rateManagerId][_paymentMethod][_currency];
    }
}
