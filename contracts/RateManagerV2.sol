// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IEscrowRegistry } from "./interfaces/IEscrowRegistry.sol";
import { IRateManager } from "./interfaces/IRateManager.sol";
import { IRateManagerV1Migratable } from "./interfaces/IRateManagerV1Migratable.sol";

/**
 * @title RateManagerV2
 * @notice Delegated rate registry that keeps the V1 fixed-rate surface and adds liquidity tranches.
 * @dev Tranche rates are resolved against the delegated deposit's current total liquidity
 *      (`remainingDeposits + outstandingIntentAmount`). The first tranche whose `maxLiquidity`
 *      covers that liquidity is considered active. When tranches exist for a tuple, they replace
 *      the flat manager rate for that tuple.
 */
contract RateManagerV2 is Ownable, IRateManager {
    /* ============ Constants ============ */

    uint256 public constant GLOBAL_MAX_MANAGER_FEE = 5e16; // 5%

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

    struct TrancheRate {
        uint256 maxLiquidity;
        uint256 rate;
    }

    struct LegacySource {
        address rateManager;
        bytes32 rateManagerId;
    }

    /* ============ Custom Errors ============ */

    error ZeroAddress();
    error ZeroValue();
    error UnauthorizedCaller(address caller, address authorized);
    error ArrayLengthMismatch(uint256 length1, uint256 length2);
    error RateManagerNotFound(bytes32 rateManagerId);
    error RateManagerAlreadyExists(bytes32 rateManagerId);
    error FeeExceedsMaximum(uint256 fee, uint256 maximum);
    error BelowMinLiquidity(uint256 totalLiquidity, uint256 required);
    error UnauthorizedEscrow(address escrow);
    error InvalidLegacyRateManager(address legacyRateManager);
    error InvalidTrancheOrder(uint256 previousMaxLiquidity, uint256 nextMaxLiquidity);

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
    event RateManagerImported(
        bytes32 indexed rateManagerId,
        address indexed legacyRateManager,
        bytes32 indexed legacyRateManagerId,
        uint256 totalCopied
    );
    event RateManagerTrancheRateUpdated(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode,
        uint256 maxLiquidity,
        uint256 rate
    );
    event RateManagerTrancheRatesUpdated(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode,
        uint256 totalUpdated
    );
    event RateManagerTrancheRatesCleared(
        bytes32 indexed rateManagerId,
        bytes32 indexed paymentMethod,
        bytes32 indexed currencyCode
    );
    event MinLiquidityUpdated(bytes32 indexed rateManagerId, uint256 minLiquidity);
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    /* ============ State Variables ============ */

    IEscrowRegistry public escrowRegistry;
    uint256 internal nextRateManagerId = 1;

    mapping(bytes32 => RateManagerConfig) internal rateManagers;
    mapping(bytes32 => LegacySource) internal legacySources;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => uint256))) internal rates;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => bool))) internal hasRateOverride;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => TrancheRate[]))) internal trancheRates;

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
     * @notice Creates a new V2 manager while preserving the V1 config shape.
     * @param _config Mutable manager configuration.
     * @return rateManagerId Newly created manager id.
     */
    function createRateManager(RateManagerConfig calldata _config) external returns (bytes32 rateManagerId) {
        _validateConfig(_config);

        rateManagerId = keccak256(abi.encodePacked(address(this), nextRateManagerId++));
        rateManagers[rateManagerId] = _config;

        _emitRateManagerCreated(rateManagerId, _config);
    }

    /**
     * @notice Copies an existing V1 manager config into V2 and optionally copies flat tuple rates.
     * @dev The imported V2 manager intentionally reuses the legacy `rateManagerId` so downstream
     *      systems can keep referring to the same logical manager identity after the contract switch.
     * @param _legacyRateManager Source RateManagerV1 contract.
     * @param _legacyRateManagerId Source manager id on the legacy contract.
     * @param _paymentMethods Payment methods to copy from the legacy manager.
     * @param _currencyCodes Currency lists aligned with `_paymentMethods`.
     * @return rateManagerId Imported manager id. Equal to `_legacyRateManagerId`.
     */
    function importRateManager(
        address _legacyRateManager,
        bytes32 _legacyRateManagerId,
        bytes32[] calldata _paymentMethods,
        bytes32[][] calldata _currencyCodes
    )
        external
        returns (bytes32 rateManagerId)
    {
        if (_legacyRateManager == address(0)) revert ZeroAddress();
        if (_legacyRateManager.code.length == 0) revert InvalidLegacyRateManager(_legacyRateManager);
        if (_paymentMethods.length != _currencyCodes.length) {
            revert ArrayLengthMismatch(_paymentMethods.length, _currencyCodes.length);
        }

        IRateManagerV1Migratable legacyRateManager = IRateManagerV1Migratable(_legacyRateManager);
        if (!legacyRateManager.isRateManager(_legacyRateManagerId)) revert RateManagerNotFound(_legacyRateManagerId);

        rateManagerId = _legacyRateManagerId;
        if (isRateManager(rateManagerId)) revert RateManagerAlreadyExists(rateManagerId);

        IRateManagerV1Migratable.RateManagerConfig memory legacyConfig = legacyRateManager.getRateManager(_legacyRateManagerId);
        RateManagerConfig memory importedConfig = RateManagerConfig({
            manager: legacyConfig.manager,
            feeRecipient: legacyConfig.feeRecipient,
            maxFee: legacyConfig.maxFee,
            fee: legacyConfig.fee,
            minLiquidity: legacyConfig.minLiquidity,
            name: legacyConfig.name,
            uri: legacyConfig.uri
        });
        _validateConfig(importedConfig);

        rateManagers[rateManagerId] = importedConfig;
        legacySources[rateManagerId] = LegacySource({
            rateManager: _legacyRateManager,
            rateManagerId: _legacyRateManagerId
        });

        _emitRateManagerCreated(rateManagerId, importedConfig);

        uint256 totalCopied;
        for (uint256 i = 0; i < _paymentMethods.length; i++) {
            bytes32 paymentMethod = _paymentMethods[i];
            if (paymentMethod == bytes32(0)) revert ZeroValue();

            for (uint256 j = 0; j < _currencyCodes[i].length; j++) {
                bytes32 currencyCode = _currencyCodes[i][j];
                if (currencyCode == bytes32(0)) revert ZeroValue();

                uint256 rate = legacyRateManager.getManagerRate(_legacyRateManagerId, paymentMethod, currencyCode);
                _setFlatRate(rateManagerId, paymentMethod, currencyCode, rate);
                totalCopied++;
            }
        }

        emit RateManagerRatesBatchUpdated(rateManagerId, totalCopied);
        emit RateManagerImported(rateManagerId, _legacyRateManager, _legacyRateManagerId, totalCopied);
    }

    /**
     * @notice Updates mutable manager config fields.
     * @dev `maxFee` remains immutable once the manager id exists.
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
     * @notice Updates the delegated manager fee.
     */
    function setFee(bytes32 _rateManagerId, uint256 _fee) external onlyManager(_rateManagerId) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        if (_fee > config.maxFee) revert FeeExceedsMaximum(_fee, config.maxFee);
        if (_fee > 0 && config.feeRecipient == address(0)) revert ZeroAddress();

        config.fee = _fee;
        emit RateManagerFeeUpdated(_rateManagerId, _fee);
    }

    /**
     * @notice Updates the minimum liquidity requirement enforced when a deposit opts in.
     */
    function setMinLiquidity(bytes32 _rateManagerId, uint256 _minLiquidity) external onlyManager(_rateManagerId) {
        rateManagers[_rateManagerId].minLiquidity = _minLiquidity;
        emit MinLiquidityUpdated(_rateManagerId, _minLiquidity);
    }

    /**
     * @notice Updates the escrow registry used to authenticate `onDepositOptIn`.
     */
    function setEscrowRegistry(address _escrowRegistry) external onlyOwner {
        if (_escrowRegistry == address(0)) revert ZeroAddress();
        escrowRegistry = IEscrowRegistry(_escrowRegistry);
        emit EscrowRegistryUpdated(_escrowRegistry);
    }

    /**
     * @notice Sets a flat manager rate for a payment method / currency pair.
     * @dev Flat rates remain useful for backwards compatibility and for tuples that do not need tranches.
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
        _setFlatRate(_rateManagerId, _paymentMethod, _currencyCode, _rate);
    }

    /**
     * @notice Batch sets flat manager rates.
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

                _setFlatRate(_rateManagerId, paymentMethod, currencyCode, _rates[i][j]);
                totalUpdated++;
            }
        }

        emit RateManagerRatesBatchUpdated(_rateManagerId, totalUpdated);
    }

    /**
     * @notice Replaces the full tranche schedule for a manager tuple.
     * @dev Tranches are stored in ascending `maxLiquidity` order. The active tranche is the first
     *      entry whose `maxLiquidity` is greater than or equal to current liquidity.
     */
    function setTrancheRates(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        TrancheRate[] calldata _tranches
    )
        external
        onlyManager(_rateManagerId)
    {
        if (_paymentMethod == bytes32(0) || _currencyCode == bytes32(0)) revert ZeroValue();

        delete trancheRates[_rateManagerId][_paymentMethod][_currencyCode];

        if (_tranches.length == 0) {
            emit RateManagerTrancheRatesCleared(_rateManagerId, _paymentMethod, _currencyCode);
            return;
        }

        uint256 previousMaxLiquidity;
        TrancheRate[] storage storedTranches = trancheRates[_rateManagerId][_paymentMethod][_currencyCode];
        for (uint256 i = 0; i < _tranches.length; i++) {
            TrancheRate calldata tranche = _tranches[i];
            if (tranche.maxLiquidity == 0) revert ZeroValue();
            if (tranche.maxLiquidity <= previousMaxLiquidity) {
                revert InvalidTrancheOrder(previousMaxLiquidity, tranche.maxLiquidity);
            }

            storedTranches.push(TrancheRate({
                maxLiquidity: tranche.maxLiquidity,
                rate: tranche.rate
            }));
            emit RateManagerTrancheRateUpdated(
                _rateManagerId,
                _paymentMethod,
                _currencyCode,
                tranche.maxLiquidity,
                tranche.rate
            );

            previousMaxLiquidity = tranche.maxLiquidity;
        }

        emit RateManagerTrancheRatesUpdated(_rateManagerId, _paymentMethod, _currencyCode, _tranches.length);
    }

    /**
     * @notice Removes all tranche rates for a tuple and falls back to the flat rate, if any.
     */
    function clearTrancheRates(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        onlyManager(_rateManagerId)
    {
        if (_paymentMethod == bytes32(0) || _currencyCode == bytes32(0)) revert ZeroValue();

        delete trancheRates[_rateManagerId][_paymentMethod][_currencyCode];
        emit RateManagerTrancheRatesCleared(_rateManagerId, _paymentMethod, _currencyCode);
    }

    /**
     * @notice Callback invoked by EscrowV2 when a deposit opts into this manager.
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
     * @notice Returns the effective manager-side rate for a delegated deposit.
     * @dev Tranche schedules are resolved against the deposit's current total liquidity.
     *      If no tranches are configured for the tuple, the flat V1-compatible rate is returned.
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
        TrancheRate[] storage storedTranches = trancheRates[_rateManagerId][_paymentMethod][_currencyCode];
        if (storedTranches.length == 0) {
            if (!hasRateOverride[_rateManagerId][_paymentMethod][_currencyCode]) return 0;
            return rates[_rateManagerId][_paymentMethod][_currencyCode];
        }

        if (_escrow == address(0) || _escrow.code.length == 0) return 0;

        try IEscrow(_escrow).getDeposit(_depositId) returns (IEscrow.Deposit memory deposit) {
            uint256 totalLiquidity = deposit.remainingDeposits + deposit.outstandingIntentAmount;
            return getRateForLiquidity(_rateManagerId, _paymentMethod, _currencyCode, totalLiquidity);
        } catch {
            return 0;
        }
    }

    /**
     * @notice Returns the active tranche rate for an explicit liquidity amount.
     * @dev This is useful off-chain when previewing how a deposit will reprice as liquidity changes.
     */
    function getRateForLiquidity(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        uint256 _liquidity
    )
        public
        view
        returns (uint256 rate)
    {
        TrancheRate[] storage storedTranches = trancheRates[_rateManagerId][_paymentMethod][_currencyCode];
        for (uint256 i = 0; i < storedTranches.length; i++) {
            if (_liquidity <= storedTranches[i].maxLiquidity) {
                return storedTranches[i].rate;
            }
        }

        return 0;
    }

    /**
     * @notice Returns fee recipient and fee for a manager id.
     */
    function getFee(bytes32 _rateManagerId) external view override returns (address recipient, uint256 fee) {
        RateManagerConfig storage config = rateManagers[_rateManagerId];
        return (config.feeRecipient, config.fee);
    }

    /**
     * @notice Returns whether a manager id exists.
     */
    function isRateManager(bytes32 _rateManagerId) public view override returns (bool exists) {
        return rateManagers[_rateManagerId].manager != address(0);
    }

    /**
     * @notice Returns manager config for a manager id.
     */
    function getRateManager(bytes32 _rateManagerId) external view returns (RateManagerConfig memory config) {
        return rateManagers[_rateManagerId];
    }

    /**
     * @notice Returns the V1-compatible flat manager rate override for a tuple.
     * @dev This getter does not resolve tranches. Use `getRate` or `getRateForLiquidity` for active pricing.
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
     * @notice Returns the copied V1 source for an imported manager id, if any.
     */
    function getLegacySource(bytes32 _rateManagerId) external view returns (address legacyRateManager, bytes32 legacyRateManagerId) {
        LegacySource storage source = legacySources[_rateManagerId];
        return (source.rateManager, source.rateManagerId);
    }

    /**
     * @notice Returns the full ordered tranche schedule for a tuple.
     */
    function getTrancheRates(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    )
        external
        view
        returns (TrancheRate[] memory configuredTranches)
    {
        TrancheRate[] storage storedTranches = trancheRates[_rateManagerId][_paymentMethod][_currencyCode];
        configuredTranches = new TrancheRate[](storedTranches.length);
        for (uint256 i = 0; i < storedTranches.length; i++) {
            configuredTranches[i] = storedTranches[i];
        }
    }

    /* ============ Internal Helpers ============ */

    function _setFlatRate(
        bytes32 _rateManagerId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode,
        uint256 _rate
    ) internal {
        hasRateOverride[_rateManagerId][_paymentMethod][_currencyCode] = true;
        rates[_rateManagerId][_paymentMethod][_currencyCode] = _rate;

        emit RateManagerRateUpdated(_rateManagerId, _paymentMethod, _currencyCode, _rate);
    }

    function _validateConfig(RateManagerConfig memory _config) internal pure {
        if (_config.manager == address(0)) revert ZeroAddress();
        if (_config.fee > 0 && _config.feeRecipient == address(0)) revert ZeroAddress();
        if (_config.maxFee > GLOBAL_MAX_MANAGER_FEE) {
            revert FeeExceedsMaximum(_config.maxFee, GLOBAL_MAX_MANAGER_FEE);
        }
        if (_config.fee > _config.maxFee) revert FeeExceedsMaximum(_config.fee, _config.maxFee);
    }

    function _emitRateManagerCreated(bytes32 _rateManagerId, RateManagerConfig memory _config) internal {
        emit RateManagerCreated(
            _rateManagerId,
            _config.manager,
            _config.feeRecipient,
            _config.maxFee,
            _config.fee,
            _config.name,
            _config.uri
        );

        if (_config.minLiquidity > 0) {
            emit MinLiquidityUpdated(_rateManagerId, _config.minLiquidity);
        }
    }
}
