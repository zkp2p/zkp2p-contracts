// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IOracleAdapter } from "./interfaces/IOracleAdapter.sol";
import { IRateManager } from "./interfaces/IRateManager.sol";

/**
 * @title RateManagerV1
 * @notice Canonical delegated rate manager with manager-owned rates and depositor-owned per-deposit floors.
 */
contract RateManagerV1 is Ownable, IRateManager {
    /* ============ Constants ============ */

    uint256 public constant GLOBAL_MAX_MANAGER_FEE = 5e16; // 5%
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_ADAPTER_CONFIG_BYTES = 256;

    /* ============ Structs ============ */

    struct RateManagerConfig {
        address manager;
        address feeRecipient;
        uint256 maxFee;
        uint256 fee;
        string name;
        string uri;
    }

    struct DepositorFloorConfig {
        uint256 floorFixed;
        uint16 floorSpreadBps;
        address oracleAdapter;
        bytes adapterConfig;
        uint32 maxStaleness;
    }

    /* ============ Custom Errors ============ */

    error ZeroAddress();
    error ZeroValue();
    error UnauthorizedCaller(address caller, address authorized);
    error ArrayLengthMismatch(uint256 length1, uint256 length2);
    error RateManagerNotFound(bytes32 rateManagerId);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error InvalidSpread(uint256 spreadBps);
    error InvalidOracleAdapter(address adapter);
    error AdapterConfigTooLong(uint256 length, uint256 maxLength);
    error DepositNotFound(uint256 depositId);
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

    event DepositorFloorSet(
        bytes32 indexed rateManagerId,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode,
        uint256 floorFixed,
        uint16 floorSpreadBps,
        address oracleAdapter,
        bytes adapterConfig,
        uint32 maxStaleness
    );

    event MinLiquidityUpdated(bytes32 indexed rateManagerId, uint256 minLiquidity);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    event DepositorCurrencyEnabledSet(
        bytes32 indexed rateManagerId,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        bytes32 currencyCode,
        bool enabled
    );

    /* ============ State Variables ============ */

    IEscrowRegistry public escrowRegistry;
    uint256 internal nextRateManagerId = 1;

    mapping(bytes32 => RateManagerConfig) internal rateManagers;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => uint256))) internal rates;

    mapping(bytes32 => mapping(address => mapping(uint256 => mapping(bytes32 => mapping(bytes32 => DepositorFloorConfig)))))
        internal depositorFloors;
    mapping(bytes32 => mapping(address => mapping(uint256 => mapping(bytes32 => mapping(bytes32 => bool)))))
        internal depositorCurrencyEnabled;
    mapping(bytes32 => uint256) public minLiquidity;

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
        minLiquidity[_rateManagerId] = _minLiquidity;
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
     * @notice Sets depositor floor config for one delegated tuple.
     * @dev Caller must be the deposit owner on `_escrow`.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @param _config Depositor floor configuration.
     */
    function setDepositorFloor(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        DepositorFloorConfig calldata _config
    )
        external
    {
        _assertDepositor(_escrow, _depositId);
        _setDepositorFloor(_rateManagerId, _escrow, _depositId, _paymentMethod, _currencyCode, _config);
    }

    /**
     * @notice Batch sets depositor floors for one deposit.
     * @dev For each index i, `_currencyCodes[i].length` must equal `_configs[i].length`.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethods Payment method keys.
     * @param _currencyCodes Currency keys grouped by payment method index.
     * @param _configs Floor configs grouped by payment method index.
     */
    function setDepositorFloorBatch(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencyCodes,
        DepositorFloorConfig[][] calldata _configs
    )
        external
    {
        _assertDepositor(_escrow, _depositId);

        if (_paymentMethods.length != _currencyCodes.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _currencyCodes.length);
        }
        if (_paymentMethods.length != _configs.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _configs.length);
        }

        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            if (_currencyCodes[i].length != _configs[i].length) {
                revert ArrayLengthMismatch(_currencyCodes[i].length, _configs[i].length);
            }
            for (uint256 j = 0; j < _currencyCodes[i].length; j++) {
                _setDepositorFloor(
                    _rateManagerId,
                    _escrow,
                    _depositId,
                    _paymentMethods[i],
                    _currencyCodes[i][j],
                    _configs[i][j]
                );
            }
        }
    }

    /**
     * @notice Sets depositor-side currency enabled state.
     * @dev Caller must be the deposit owner.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @param _enabled Whether the tuple is enabled.
     */
    function setDepositorCurrencyEnabled(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        bool _enabled
    )
        external
    {
        _assertDepositor(_escrow, _depositId);
        _setDepositorCurrencyEnabled(_rateManagerId, _escrow, _depositId, _paymentMethod, _currencyCode, _enabled);
    }

    /**
     * @notice Batch sets depositor-side currency enabled state.
     * @dev For each index i, `_currencyCodes[i].length` must equal `_enabled[i].length`.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethods Payment method keys.
     * @param _currencyCodes Currency keys grouped by payment method index.
     * @param _enabled Enabled flags grouped by payment method index.
     */
    function setDepositorCurrencyEnabledBatch(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencyCodes,
        bool[][] calldata _enabled
    )
        external
    {
        _assertDepositor(_escrow, _depositId);

        if (_paymentMethods.length != _currencyCodes.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _currencyCodes.length);
        }
        if (_paymentMethods.length != _enabled.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _enabled.length);
        }

        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            if (_currencyCodes[i].length != _enabled[i].length) {
                revert ArrayLengthMismatch(_currencyCodes[i].length, _enabled[i].length);
            }
            for (uint256 j = 0; j < _currencyCodes[i].length; j++) {
                _setDepositorCurrencyEnabled(
                    _rateManagerId,
                    _escrow,
                    _depositId,
                    _paymentMethods[i],
                    _currencyCodes[i][j],
                    _enabled[i][j]
                );
            }
        }
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

        uint256 required = minLiquidity[_rateManagerId];
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
     * @notice Returns manager-adjusted rate for a delegated deposit tuple.
     * @dev Returns 0 when tuple is disabled or manager-side rate is unset.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @return rate Effective delegated rate.
     */
    function getRate(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        override
        returns (uint256 rate)
    {
        if (!depositorCurrencyEnabled[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode]) {
            return 0;
        }

        uint256 managerRate = rates[_rateManagerId][_paymentMethod][_currencyCode];
        if (managerRate == 0) {
            return 0;
        }

        DepositorFloorConfig memory floorConfig = depositorFloors[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode];
        uint256 effectiveFloor = _computeEffectiveFloor(floorConfig);

        // If depositor configured oracle protection but it resolved to zero
        // (stale, invalid, or reverted) and no fixed floor backup exists,
        // disable the pair to prevent unprotected exposure to manager rate
        if (floorConfig.oracleAdapter != address(0) && effectiveFloor == 0) {
            return 0;
        }

        return managerRate > effectiveFloor ? managerRate : effectiveFloor;
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

    /**
     * @notice Returns depositor floor config for a delegated tuple.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @return config Stored floor config.
     */
    function getDepositorFloor(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (DepositorFloorConfig memory config)
    {
        return depositorFloors[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode];
    }

    /**
     * @notice Returns depositor currency enabled state for a delegated tuple.
     * @param _rateManagerId Manager id.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Currency key.
     * @return enabled True when tuple is enabled for the deposit.
     */
    function isDepositorCurrencyEnabled(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (bool enabled)
    {
        return depositorCurrencyEnabled[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode];
    }

    /* ============ Internal Functions ============ */

    function _setDepositorFloor(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        DepositorFloorConfig calldata _config
    ) internal {
        if (!isRateManager(_rateManagerId)) revert RateManagerNotFound(_rateManagerId);
        if (_paymentMethod == bytes32(0) || _currencyCode == bytes32(0)) revert ZeroValue();

        bytes memory normalizedAdapterConfig = _validateAndNormalizeOracleConfig(_config);

        depositorFloors[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode] = DepositorFloorConfig({
            floorFixed: _config.floorFixed,
            floorSpreadBps: _config.floorSpreadBps,
            oracleAdapter: _config.oracleAdapter,
            adapterConfig: normalizedAdapterConfig,
            maxStaleness: _config.maxStaleness
        });

        emit DepositorFloorSet(
            _rateManagerId,
            _escrow,
            _depositId,
            _paymentMethod,
            _currencyCode,
            _config.floorFixed,
            _config.floorSpreadBps,
            _config.oracleAdapter,
            normalizedAdapterConfig,
            _config.maxStaleness
        );
    }

    function _setDepositorCurrencyEnabled(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        bool _enabled
    ) internal {
        if (!isRateManager(_rateManagerId)) revert RateManagerNotFound(_rateManagerId);
        if (_paymentMethod == bytes32(0) || _currencyCode == bytes32(0)) revert ZeroValue();

        depositorCurrencyEnabled[_rateManagerId][_escrow][_depositId][_paymentMethod][_currencyCode] = _enabled;

        emit DepositorCurrencyEnabledSet(
            _rateManagerId,
            _escrow,
            _depositId,
            _paymentMethod,
            _currencyCode,
            _enabled
        );
    }

    function _assertDepositor(address _escrow, uint256 _depositId) internal view {
        if (_escrow == address(0)) revert ZeroAddress();

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        if (deposit.depositor == address(0)) revert DepositNotFound(_depositId);
        if (deposit.depositor != msg.sender) revert UnauthorizedCaller(msg.sender, deposit.depositor);
    }

    function _validateAndNormalizeOracleConfig(DepositorFloorConfig calldata _config)
        internal
        view
        returns (bytes memory normalizedAdapterConfig)
    {
        if (_config.floorSpreadBps > BPS) revert InvalidSpread(_config.floorSpreadBps);

        if (_config.oracleAdapter == address(0)) {
            if (_config.floorSpreadBps != 0 || _config.adapterConfig.length != 0 || _config.maxStaleness != 0) {
                revert InvalidOracleAdapter(_config.oracleAdapter);
            }
            return bytes("");
        }

        if (_config.oracleAdapter.code.length == 0) revert InvalidOracleAdapter(_config.oracleAdapter);
        if (_config.maxStaleness == 0) revert ZeroValue();

        bytes memory normalizedConfig = IOracleAdapter(_config.oracleAdapter).validateConfig(_config.adapterConfig);
        if (normalizedConfig.length > MAX_ADAPTER_CONFIG_BYTES) {
            revert AdapterConfigTooLong(normalizedConfig.length, MAX_ADAPTER_CONFIG_BYTES);
        }
        return normalizedConfig;
    }

    function _computeEffectiveFloor(DepositorFloorConfig memory _config) internal view returns (uint256) {
        uint256 spreadRate = _computeSpreadRate(_config);
        return _config.floorFixed > spreadRate ? _config.floorFixed : spreadRate;
    }

    function _computeSpreadRate(DepositorFloorConfig memory _config) internal view returns (uint256) {
        if (_config.oracleAdapter == address(0)) {
            return 0;
        }

        try IOracleAdapter(_config.oracleAdapter).getRate(_config.adapterConfig) returns (
            bool isValidQuote,
            uint256 marketRate,
            uint256 rateUpdatedAt
        ) {
            if (!isValidQuote || marketRate == 0) {
                return 0;
            }
            if (rateUpdatedAt == 0 || rateUpdatedAt > block.timestamp) {
                return 0;
            }
            if (block.timestamp - rateUpdatedAt > _config.maxStaleness) {
                return 0;
            }

            return Math.mulDiv(
                marketRate,
                BPS + uint256(_config.floorSpreadBps),
                BPS,
                Math.Rounding.Up
            );
        } catch {
            return 0;
        }
    }
}
