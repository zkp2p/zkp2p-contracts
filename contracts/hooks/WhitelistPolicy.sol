// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IEscrow} from "../interfaces/IEscrow.sol";
import {IEscrowRegistry} from "../interfaces/IEscrowRegistry.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title WhitelistPolicy
 * @notice Persistent deposit-and-payment-method-scoped taker admission settings, independent from hook deployment.
 * Each deposit payment method carries its own enforcement switch and bounded list of curated groups, while direct
 * addresses remain trusted across every payment method on that deposit. The policy survives global hook replacement.
 * @dev Enabling a deposit payment method with no groups and no deposit-wide whitelisted addresses is allowed and
 * intentionally fails closed when evaluated. Writes are authorized against the escrow's recorded depositor, so the
 * deposit must already exist.
 * While EscrowRegistry is in accept-all mode the registry check passes for any address, so passing an EOA or a
 * contract without `getDeposit` reverts inside the escrow call with no reason data rather than a policy error.
 * That path is a caller mistake on a governance-gated mode, and is not worth a per-write code-length check.
 * `escrowRegistry` is governance-settable via `setEscrowRegistry` and MUST be kept in sync with the orchestrator's
 * escrow registry (`OrchestratorV2.setEscrowRegistry`), because if the two diverge, deposits on an escrow admitted
 * by only one of them can be neither gated nor revoked while the orchestrator keeps admitting intents for them.
 */
contract WhitelistPolicy is Ownable, IWhitelistPolicy {
    /* ============ Constants ============ */

    uint256 public constant MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD = 10;

    /* ============ State Variables ============ */

    IAddressGroupRegistry public immutable override groupRegistry;
    IEscrowRegistry public override escrowRegistry;
    IOrchestratorRegistry public immutable override orchestratorRegistry;

    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) public override enabled;
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) public override bootstrapped;
    mapping(address => mapping(uint256 => mapping(address => bool))) public override isWhitelisted;
    mapping(address => mapping(uint256 => mapping(bytes32 => bytes32[]))) internal allowedGroups;

    /* ============ Events ============ */

    event EnabledUpdated(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bool enabled
    );
    event AddressWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event AddressRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event AllowedGroupAdded(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 groupId
    );
    event AllowedGroupRemoved(
        address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 groupId
    );
    event EscrowRegistryUpdated(address indexed escrowRegistry);

    /* ============ Errors ============ */

    error ZeroAddress();
    error EmptyArray();
    error InvalidDependency(address dependency);
    error GroupDoesNotExist(bytes32 groupId);
    error TooManyGroups(uint256 attempted, uint256 maximum);
    error EscrowNotWhitelisted(address escrow);
    error DepositNotFound(address escrow, uint256 depositId);
    error DepositPaymentMethodAlreadyBootstrapped(address escrow, uint256 depositId, bytes32 paymentMethod);
    error DepositPaymentMethodAlreadyEnabled(address escrow, uint256 depositId, bytes32 paymentMethod);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error UnauthorizedOrchestratorCaller(address caller);
    error TakerNotWhitelisted(address taker, address escrow, uint256 depositId, bytes32 paymentMethod);

    /* ============ Constructor ============ */

    constructor(
        IAddressGroupRegistry _groupRegistry,
        IEscrowRegistry _escrowRegistry,
        IOrchestratorRegistry _orchestratorRegistry
    ) Ownable() {
        _validateDependency(address(_groupRegistry));
        _validateDependency(address(_escrowRegistry));
        _validateDependency(address(_orchestratorRegistry));

        groupRegistry = _groupRegistry;
        escrowRegistry = _escrowRegistry;
        orchestratorRegistry = _orchestratorRegistry;
    }

    /* ============ Modifiers ============ */

    modifier onlyDepositor(address _escrow, uint256 _depositId) {
        address depositor = _validateDeposit(_escrow, _depositId);
        if (msg.sender != depositor) revert NotDepositor(_escrow, _depositId, msg.sender);
        _;
    }

    /* ============ Governance Functions ============ */

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function setEscrowRegistry(IEscrowRegistry _escrowRegistry) external override onlyOwner {
        _validateDependency(address(_escrowRegistry));

        escrowRegistry = _escrowRegistry;
        emit EscrowRegistryUpdated(address(_escrowRegistry));
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function bootstrapDeposits(
        address _escrow,
        uint256[] calldata _depositIds,
        bytes32 _paymentMethod,
        bytes32[] calldata _groupIds
    ) external override onlyOwner {
        if (_depositIds.length == 0 || _groupIds.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _depositIds.length; ++i) {
            uint256 depositId = _depositIds[i];
            _validateDeposit(_escrow, depositId);
            if (bootstrapped[_escrow][depositId][_paymentMethod]) {
                revert DepositPaymentMethodAlreadyBootstrapped(_escrow, depositId, _paymentMethod);
            }
            if (enabled[_escrow][depositId][_paymentMethod]) {
                revert DepositPaymentMethodAlreadyEnabled(_escrow, depositId, _paymentMethod);
            }

            bootstrapped[_escrow][depositId][_paymentMethod] = true;
            _setEnabled(_escrow, depositId, _paymentMethod, true);
            _addGroups(_escrow, depositId, _paymentMethod, _groupIds);
        }
    }

    /* ============ Depositor Functions ============ */

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function configureDeposit(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bool _enabled,
        bytes32[] calldata _groupIds,
        address[] calldata _takers
    ) external override onlyDepositor(_escrow, _depositId) {
        _setEnabled(_escrow, _depositId, _paymentMethod, _enabled);
        _addGroups(_escrow, _depositId, _paymentMethod, _groupIds);
        _addTakers(_escrow, _depositId, _takers);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function setEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled)
        external
        override
        onlyDepositor(_escrow, _depositId)
    {
        _setEnabled(_escrow, _depositId, _paymentMethod, _enabled);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function addWhitelistedAddresses(address _escrow, uint256 _depositId, address[] calldata _takers)
        external
        override
        onlyDepositor(_escrow, _depositId)
    {
        if (_takers.length == 0) revert EmptyArray();
        _addTakers(_escrow, _depositId, _takers);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function removeWhitelistedAddresses(address _escrow, uint256 _depositId, address[] calldata _takers)
        external
        override
        onlyDepositor(_escrow, _depositId)
    {
        if (_takers.length == 0) revert EmptyArray();

        for (uint256 i = 0; i < _takers.length; ++i) {
            address taker = _takers[i];
            if (!isWhitelisted[_escrow][_depositId][taker]) continue;

            isWhitelisted[_escrow][_depositId][taker] = false;
            emit AddressRemovedFromWhitelist(_escrow, _depositId, taker);
        }
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function addAllowedGroups(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bytes32[] calldata _groupIds)
        external
        override
        onlyDepositor(_escrow, _depositId)
    {
        if (_groupIds.length == 0) revert EmptyArray();
        _addGroups(_escrow, _depositId, _paymentMethod, _groupIds);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function removeAllowedGroups(
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32[] calldata _groupIds
    ) external override onlyDepositor(_escrow, _depositId) {
        if (_groupIds.length == 0) revert EmptyArray();

        bytes32[] storage depositPaymentMethodGroups = allowedGroups[_escrow][_depositId][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; ++i) {
            bytes32 groupId = _groupIds[i];
            uint256 groupIndex = _findGroupIndex(depositPaymentMethodGroups, groupId);
            if (groupIndex == depositPaymentMethodGroups.length) continue;

            depositPaymentMethodGroups[groupIndex] = depositPaymentMethodGroups[depositPaymentMethodGroups.length - 1];
            depositPaymentMethodGroups.pop();
            emit AllowedGroupRemoved(_escrow, _depositId, _paymentMethod, groupId);
        }
    }

    /* ============ View Functions ============ */

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function getAllowedGroups(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        external
        view
        override
        returns (bytes32[] memory)
    {
        return allowedGroups[_escrow][_depositId][_paymentMethod];
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function isGroupAllowed(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bytes32 _groupId)
        external
        view
        override
        returns (bool)
    {
        return _containsGroup(allowedGroups[_escrow][_depositId][_paymentMethod], _groupId);
    }

    /**
     * @inheritdoc IWhitelistPolicy
     */
    function isTakerAllowed(address _escrow, uint256 _depositId, bytes32 _paymentMethod, address _taker)
        external
        view
        override
        returns (bool)
    {
        return _isTakerAllowed(_escrow, _depositId, _paymentMethod, _taker);
    }

    /**
     * @notice Enforces this deposit's whitelist policy during intent signaling.
     * @dev Only registered orchestrators may invoke the hook.
     */
    function validateSignalIntent(PreIntentContext calldata _ctx) external view override {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestratorCaller(msg.sender);
        if (!_isTakerAllowed(_ctx.escrow, _ctx.depositId, _ctx.paymentMethod, _ctx.taker)) {
            revert TakerNotWhitelisted(_ctx.taker, _ctx.escrow, _ctx.depositId, _ctx.paymentMethod);
        }
    }

    /* ============ Internal Functions ============ */

    function _isTakerAllowed(address _escrow, uint256 _depositId, bytes32 _paymentMethod, address _taker)
        internal
        view
        returns (bool)
    {
        if (!enabled[_escrow][_depositId][_paymentMethod]) return true;
        if (isWhitelisted[_escrow][_depositId][_taker]) return true;

        bytes32[] storage depositPaymentMethodGroups = allowedGroups[_escrow][_depositId][_paymentMethod];
        for (uint256 i = 0; i < depositPaymentMethodGroups.length; ++i) {
            if (groupRegistry.isMember(depositPaymentMethodGroups[i], _taker)) return true;
        }
        return false;
    }

    function _setEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled) internal {
        enabled[_escrow][_depositId][_paymentMethod] = _enabled;
        emit EnabledUpdated(_escrow, _depositId, _paymentMethod, _enabled);
    }

    function _addTakers(address _escrow, uint256 _depositId, address[] calldata _takers) internal {
        for (uint256 i = 0; i < _takers.length; ++i) {
            address taker = _takers[i];
            if (taker == address(0)) revert ZeroAddress();
            if (isWhitelisted[_escrow][_depositId][taker]) continue;

            isWhitelisted[_escrow][_depositId][taker] = true;
            emit AddressWhitelisted(_escrow, _depositId, taker);
        }
    }

    function _addGroups(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bytes32[] calldata _groupIds)
        internal
    {
        bytes32[] storage depositPaymentMethodGroups = allowedGroups[_escrow][_depositId][_paymentMethod];
        for (uint256 i = 0; i < _groupIds.length; ++i) {
            bytes32 groupId = _groupIds[i];
            if (!groupRegistry.groupExists(groupId)) revert GroupDoesNotExist(groupId);
            if (_containsGroup(depositPaymentMethodGroups, groupId)) continue;
            if (depositPaymentMethodGroups.length == MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD) {
                revert TooManyGroups(depositPaymentMethodGroups.length + 1, MAX_GROUPS_PER_DEPOSIT_PAYMENT_METHOD);
            }

            depositPaymentMethodGroups.push(groupId);
            emit AllowedGroupAdded(_escrow, _depositId, _paymentMethod, groupId);
        }
    }

    function _containsGroup(bytes32[] storage _groups, bytes32 _groupId) internal view returns (bool) {
        return _findGroupIndex(_groups, _groupId) != _groups.length;
    }

    function _findGroupIndex(bytes32[] storage _groups, bytes32 _groupId) internal view returns (uint256) {
        for (uint256 i = 0; i < _groups.length; ++i) {
            if (_groups[i] == _groupId) return i;
        }
        return _groups.length;
    }

    function _validateDeposit(address _escrow, uint256 _depositId) internal view returns (address depositor) {
        if (!escrowRegistry.isWhitelistedEscrow(_escrow) && !escrowRegistry.isAcceptingAllEscrows()) {
            revert EscrowNotWhitelisted(_escrow);
        }

        depositor = IEscrow(_escrow).getDeposit(_depositId).depositor;
        if (depositor == address(0)) revert DepositNotFound(_escrow, _depositId);
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
