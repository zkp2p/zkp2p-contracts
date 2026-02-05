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

    /**
     * @notice Creates a new rate manager configuration.
     * @dev The identifier is derived as keccak256(abi.encodePacked(address(this), nextId)).
     *      This ties IDs to the registry deployment and avoids deliberate collisions.
     *      Reverts if inputs are invalid or fee exceeds caps.
     * @param _config Rate manager configuration {manager, feeRecipient, maxFee, fee, depositHook, name, uri}.
     * @return rateManagerId Newly minted manager id (bytes32).
     */
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
            _config.depositHook,
            _config.name,
            _config.uri
        );
    }

    /**
     * @notice Updates mutable fields on a rate manager config.
     * @dev Only callable by the current config.manager. Does not alter maxFee.
     *      If an existing fee is non‑zero, a non‑zero feeRecipient must be supplied.
     * @param _rateManagerId   Manager id.
     * @param _newManager      New manager address (cannot be zero).
     * @param _newFeeRecipient New fee recipient address (required when fee>0).
     * @param _newHook         Optional deposit hook contract (view callable on opt‑in), or address(0).
     * @param _newName         Human‑readable name metadata.
     * @param _newUri          URI metadata.
     */
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

    /**
     * @notice Updates the manager fee for a given id.
     * @dev Only callable by config.manager. New fee must be <= maxFee and if > 0 then feeRecipient must be set.
     * @param _rateManagerId Manager id.
     * @param _newFee        New fee in preciseUnits (1e18 = 100%).
     */
    function setFee(bytes32 _rateManagerId, uint256 _newFee) external onlyManager(_rateManagerId) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        require(_newFee <= config.maxFee, "Fee exceeds maxFee");
        if (_newFee > 0) {
            require(config.feeRecipient != address(0), "Invalid fee recipient");
        }
        config.fee = _newFee;
        emit RateManagerFeeUpdated(_rateManagerId, _newFee);
    }

    /**
     * @notice Sets the manager‑level minimum rate for a specific (paymentMethod, currency) pair.
     * @dev Does not validate whether the payment method or currency are registered; Escrow/Orchestrator enforce
     *      deposit support and payment method whitelisting. Setting to 0 disables the pair at the manager level.
     * @param _rateManagerId Manager id.
     * @param _paymentMethod Payment method key.
     * @param _currency      Fiat currency key.
     * @param _minRate       Minimum conversion rate in preciseUnits.
     */
    function setMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency, uint256 _minRate)
        external
        onlyManager(_rateManagerId)
    {
        require(_paymentMethod != bytes32(0), "Invalid payment method");
        require(_currency != bytes32(0), "Invalid currency");

        minRates[_rateManagerId][_paymentMethod][_currency] = _minRate;

        emit RateManagerMinRateUpdated(_rateManagerId, _paymentMethod, _currency, _minRate);
    }

    /**
     * @notice Batch update manager‑level minimum rates.
     * @dev For each i in paymentMethods, currencies[i] and _minRatesArr[i] must be same length.
     *      Reverts on any array length mismatch or zero keys. No validation of platform/currency registration.
     * @param _rateManagerId  Manager id.
     * @param _paymentMethods Array of payment methods.
     * @param _currencies     Array of currency arrays aligned with payment methods.
     * @param _minRatesArr    Array of rate arrays aligned with payment methods/currencies.
     */
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

    /**
     * @notice Returns true if the manager id exists.
     * @param _rateManagerId Manager id.
     */
    function isRateManager(bytes32 _rateManagerId) external view returns (bool) {
        return rateManagers[_rateManagerId].manager != address(0);
    }

    /**
     * @notice Returns the full manager configuration for an id.
     * @param _rateManagerId Manager id.
     */
    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory) {
        return rateManagers[_rateManagerId];
    }

    /**
     * @notice Returns the fee tuple (recipient, fee) for a manager id.
     * @param _rateManagerId Manager id.
     * @return feeRecipient Address that receives manager fees.
     * @return fee          Fee in preciseUnits (1e18 = 100%).
     */
    /**
     * @notice Returns the manager fee and recipient for an id.
     * @param _rateManagerId Manager id.
     * @return fee          Fee in preciseUnits (1e18 = 100%).
     * @return feeRecipient Address that receives manager fees.
     */
    function getFeeAndRecipient(bytes32 _rateManagerId) external view returns (uint256 fee, address feeRecipient) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        return (config.fee, config.feeRecipient);
    }

    /**
     * @notice Returns the deposit hook address configured for a manager id (or address(0) if none).
     * @param _rateManagerId Manager id.
     */
    function getDepositHook(bytes32 _rateManagerId) external view returns (address) {
        return rateManagers[_rateManagerId].depositHook;
    }

    /**
     * @notice Returns the manager‑level minimum rate for a (paymentMethod, currency) pair.
     * @param _rateManagerId Manager id.
     * @param _paymentMethod Payment method key.
     * @param _currency      Fiat currency key.
     * @return minRate       Minimum rate in preciseUnits (0 means disabled).
     */
    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view returns (uint256) {
        return minRates[_rateManagerId][_paymentMethod][_currency];
    }
}
