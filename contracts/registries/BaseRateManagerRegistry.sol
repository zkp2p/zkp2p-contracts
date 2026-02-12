// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";

/**
 * @title BaseRateManagerRegistry
 * @notice Shared implementation for deposit rate manager registries.
 * @dev Concrete implementations must implement `getMinRate`.
 */
abstract contract BaseRateManagerRegistry is IBaseRateManagerRegistry {
    /* ============ Constants ============ */

    uint256 internal constant GLOBAL_MAX_MANAGER_FEE = 5e16; // 5% (preciseUnits, 1e18 = 100%)

    /* ============ State Variables ============ */

    uint256 internal nextId = 1;
    mapping(bytes32 => RateManagerConfig) internal rateManagers;

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
     *      If an existing fee is non-zero, a non-zero feeRecipient must be supplied.
     */
    function setRateManagerConfig(
        bytes32 _rateManagerId,
        address _newManager,
        address _newFeeRecipient,
        address _newHook,
        string calldata _newName,
        string calldata _newUri
    )
        external
        onlyManager(_rateManagerId)
    {
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

    /* ============ External View Functions ============ */

    /**
     * @notice Returns true if the manager id exists.
     */
    function isRateManager(bytes32 _rateManagerId) external view returns (bool) {
        return rateManagers[_rateManagerId].manager != address(0);
    }

    /**
     * @notice Returns the full manager configuration for an id.
     */
    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory) {
        return rateManagers[_rateManagerId];
    }

    /**
     * @notice Returns the manager fee and recipient for an id.
     */
    function getFeeAndRecipient(bytes32 _rateManagerId) external view returns (uint256 fee, address feeRecipient) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        return (config.fee, config.feeRecipient);
    }

    /**
     * @notice Returns the deposit hook address configured for a manager id (or address(0) if none).
     */
    function getDepositHook(bytes32 _rateManagerId) external view returns (address) {
        return rateManagers[_rateManagerId].depositHook;
    }

    /**
     * @notice Returns the manager-level minimum rate for a (paymentMethod, currency) pair.
     * @dev Implementations may return 0 to disable a pair.
     */
    function getMinRate(bytes32 _rateManagerId, bytes32 _paymentMethod, bytes32 _currency) external view virtual returns (uint256);
}

