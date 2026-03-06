// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IRateManager } from "./interfaces/IRateManager.sol";

/**
 * @title RateManagerV1
 * @notice Pure rate registry for delegated rate management. Floor enforcement is handled by Escrow.
 */
contract RateManagerV1 is Ownable, IRateManager {
    /* ============ Constants ============ */

    uint256 public constant GLOBAL_MAX_MANAGER_FEE = 5e16; // 5%
    uint256 internal constant BPS = 10_000;

    /* ============ Structs ============ */

    struct RateManagerConfig {
        address manager;
        address feeRecipient;
        uint256 maxFee;
        uint256 fee;
        uint256 minLiquidity;
        string name;
        string uri;
    }

    /* ============ Custom Errors ============ */

    error ZeroAddress();
    error ZeroValue();
    error UnauthorizedCaller(address caller, address authorized);
    error ArrayLengthMismatch(uint256 length1, uint256 length2);
    error RateManagerNotFound(bytes32 rateManagerId);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error BelowMinLiquidity(uint256 totalLiquidity, uint256 required);
    error UnauthorizedEscrow(address escrow);

    /* ============ Events ============ */

    event RateManagerCreated(
        bytes32 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        uint256 maxFee,
        uint256 fee,
        string name,
        string uri
    );

    event RateManagerConfigUpdated(
        bytes32 indexed rateManagerId,
        address indexed manager,
        address indexed feeRecipient,
        string name,
        string uri
    );

    event RateManagerFeeUpdated(bytes32 indexed rateManagerId, uint256 fee);
    event RateManagerRateUpdated(bytes32 indexed rateManagerId, bytes32 indexed paymentMethod, bytes32 indexed currencyCode, uint256 rate);
    event RateManagerRatesBatchUpdated(bytes32 indexed rateManagerId, uint256 totalUpdated);

    event MinLiquidityUpdated(bytes32 indexed rateManagerId, uint256 minLiquidity);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    /* ============ State Variables ============ */

    IEscrowRegistry public escrowRegistry;
    uint256 internal nextRateManagerId = 1;

    mapping(bytes32 => RateManagerConfig) internal rateManagers;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => uint256))) internal rates;

    /* ============ Constructor ============ */

    constructor(address _escrowRegistry) Ownable() {
        if (_escrowRegistry == address(0)) revert ZeroAddress();
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
    }

    /* ============ Modifiers ============ */

    modifier onlyManager(bytes32 _rateManagerId) {
        address manager = rateManagers[_rateManagerId].manager;
        if (manager == address(0)) revert RateManagerNotFound(_rateManagerId);
        if (msg.sender != manager) revert UnauthorizedCaller(msg.sender, manager);
        _;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Creates a new rate manager configuration.
     * @dev Manager ids are generated as `keccak256(abi.encodePacked(address(this), nextRateManagerId++))`.
     * @param _config Rate manager configuration.
     * @return rateManagerId Newly created manager id.
     */
    function createRateManager(RateManagerConfig calldata _config) external returns (bytes32 rateManagerId) {
        if (_config.manager == address(0)) revert ZeroAddress();
        if (_config.fee > 0 && _config.feeRecipient == address(0)) revert ZeroAddress();
        if (_config.maxFee > GLOBAL_MAX_MANAGER_FEE) {
            revert FeeExceedsMaximum(_config.maxFee, GLOBAL_MAX_MANAGER_FEE);
        }
        if (_config.fee > _config.maxFee) revert FeeExceedsMaximum(_config.fee, _config.maxFee);

        rateManagerId = keccak256(abi.encodePacked(address(this), nextRateManagerId++));
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

        if (_config.minLiquidity > 0) {
            emit MinLiquidityUpdated(rateManagerId, _config.minLiquidity);
        }
    }

    /**
     * @notice Updates mutable manager config fields.
     * @dev Only current manager can update. `maxFee` is immutable.
     * @param _rateManagerId Manager id.
     * @param _manager New manager address.
     * @param _feeRecipient New fee recipient.
     * @param _name New display name.
     * @param _uri New metadata URI.
     */
    function setRateManagerConfig(
        bytes32 _rateManagerId,
        address _manager,
        address _feeRecipient,
        string calldata _name,
        string calldata _uri
    )
        external
        onlyManager(_rateManagerId)
    {
        if (_manager == address(0)) revert ZeroAddress();

        RateManagerConfig storage config = rateManagers[_rateManagerId];
        if (config.fee > 0 && _feeRecipient == address(0)) revert ZeroAddress();

        config.manager = _manager;
        config.feeRecipient = _feeRecipient;
        config.name = _name;
        config.uri = _uri;

        emit RateManagerConfigUpdated(_rateManagerId, _manager, _feeRecipient, _name, _uri);
    }

    /**
     * @notice Updates manager fee for a manager id.
     * @dev Only manager can call. New fee must be <= maxFee.
     * @param _rateManagerId Manager id.
     * @param _fee New fee in precise units.
     */
    function setFee(bytes32 _rateManagerId, uint256 _fee) external onlyManager(_rateManagerId) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        if (_fee > config.maxFee) revert FeeExceedsMaximum(_fee, config.maxFee);
        if (_fee > 0 && config.feeRecipient == address(0)) revert ZeroAddress();

        config.fee = _fee;
        emit RateManagerFeeUpdated(_rateManagerId, _fee);
    }

    function setMinLiquidity(bytes32 _rateManagerId, uint256 _minLiquidity) external onlyManager(_rateManagerId) {
        rateManagers[_rateManagerId].minLiquidity = _minLiquidity;
        emit MinLiquidityUpdated(_rateManagerId, _minLiquidity);
    }

    /**
     * @notice Updates the escrow registry address.
     * @dev Only contract owner can call.
     * @param _escrowRegistry New escrow registry address.
     */
    function setEscrowRegistry(address _escrowRegistry) external onlyOwner {
        if (_escrowRegistry == address(0)) revert ZeroAddress();
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        emit EscrowRegistryUpdated(_escrowRegistry);
    }

    /**
     * @notice Sets manager-side rate for one payment/currency tuple.
     * @dev Only manager can call.
     * @param _rateManagerId Manager id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @param _rate New rate in precise units.
     */
    function setRate(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        uint256 _rate
    )
        external
        onlyManager(_rateManagerId)
    {
        if (_paymentMethod == bytes32(0) || _currencyCode == bytes32(0)) revert ZeroValue();

        rates[_rateManagerId][_paymentMethod][_currencyCode] = _rate;
        emit RateManagerRateUpdated(_rateManagerId, _paymentMethod, _currencyCode, _rate);
    }

    /**
     * @notice Batch sets manager-side rates.
     * @dev For each index i, `_currencyCodes[i].length` must equal `_rates[i].length`.
     * @param _rateManagerId Manager id.
     * @param _paymentMethods Payment method keys.
     * @param _currencyCodes Currency keys grouped by payment method index.
     * @param _rates Rates grouped by payment method index.
     */
    function setRateBatch(
        bytes32 _rateManagerId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencyCodes,
        uint256[][] calldata _rates
    )
        external
        onlyManager(_rateManagerId)
    {
        if (_paymentMethods.length != _currencyCodes.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _currencyCodes.length);
        }
        if (_paymentMethods.length != _rates.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _rates.length);
        }

        uint256 totalUpdated;
        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            if (_currencyCodes[i].length != _rates[i].length) {
                revert ArrayLengthMismatch(_currencyCodes[i].length, _rates[i].length);
            }
            bytes32 paymentMethod = _paymentMethods[i];
            if (paymentMethod == bytes32(0)) revert ZeroValue();

            for (uint256 j = 0; j < _currencyCodes[i].length; j++) {
                bytes32 currencyCode = _currencyCodes[i][j];
                if (currencyCode == bytes32(0)) revert ZeroValue();

                rates[_rateManagerId][paymentMethod][currencyCode] = _rates[i][j];
                emit RateManagerRateUpdated(_rateManagerId, paymentMethod, currencyCode, _rates[i][j]);
                totalUpdated++;
            }
        }

        emit RateManagerRatesBatchUpdated(_rateManagerId, totalUpdated);
    }

    /**
     * @notice Callback invoked by EscrowV2 when a deposit opts into this manager.
     * @dev NOTE: Only callable by whitelisted escrows. Deposit existence and depositor ownership
     * are validated by the calling escrow before this callback. This function reverts if the deposit
     * opt-in fails.
     * @param _depositId Deposit id.
     * @param _rateManagerId Manager id.
     */
    function onDepositOptIn(
        uint256 _depositId,
        bytes32 _rateManagerId
    )
        external
        view
        override
    {
        address callingEscrow = msg.sender;
        if (!escrowRegistry.isWhitelistedEscrow(callingEscrow) && !escrowRegistry.isAcceptingAllEscrows()) {
            revert UnauthorizedEscrow(callingEscrow);
        }

        if (!isRateManager(_rateManagerId)) revert RateManagerNotFound(_rateManagerId);

        uint256 required = rateManagers[_rateManagerId].minLiquidity;
        if (required > 0) {
            IEscrow.Deposit memory deposit = IEscrow(callingEscrow).getDeposit(_depositId);
            uint256 totalLiquidity = deposit.remainingDeposits + deposit.outstandingIntentAmount;
            if (totalLiquidity < required) {
                revert BelowMinLiquidity(totalLiquidity, required);
            }
        }
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Returns manager rate for a delegated deposit tuple.
     * @dev Floor enforcement is handled by Escrow. Unused params kept for interface compatibility.
     * @param _rateManagerId Manager id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @return rate Manager rate.
     */
    function getRate(
        bytes32 _rateManagerId,
        address,
        uint256,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        override
        returns (uint256 rate)
    {
        return rates[_rateManagerId][_paymentMethod][_currencyCode];
    }

    /**
     * @notice Returns fee recipient and fee for a manager id.
     * @param _rateManagerId Manager id.
     * @return recipient Fee recipient address.
     * @return fee Fee in precise units.
     */
    function getFee(bytes32 _rateManagerId) external view override returns (address recipient, uint256 fee) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        return (config.feeRecipient, config.fee);
    }

    /**
     * @notice Returns whether a manager id exists.
     * @param _rateManagerId Manager id.
     * @return exists True when manager exists.
     */
    function isRateManager(bytes32 _rateManagerId) public view override returns (bool exists) {
        return rateManagers[_rateManagerId].manager != address(0);
    }

    /**
     * @notice Returns manager config for a manager id.
     * @param _rateManagerId Manager id.
     * @return config Full manager config.
     */
    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory config) {
        return rateManagers[_rateManagerId];
    }

    /**
     * @notice Returns manager-set rate for one tuple.
     * @param _rateManagerId Manager id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @return rate Stored manager rate.
     */
    function getManagerRate(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (uint256 rate)
    {
        return rates[_rateManagerId][_paymentMethod][_currencyCode];
    }

}
