// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IChargebackPolicy} from "../interfaces/IChargebackPolicy.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";
import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV2
 * @notice IntentLifecycleHookV1 routing plus an opt-in per-deposit mode that requires whitelist
 * membership AND stake-backed chargeback collateral together.
 * @dev Under V1 routing a whitelist-allowed taker bypasses staking entirely, so membership and
 * collateral are mutually exclusive on any one deposit. A deposit that opts into collateralized
 * membership here instead gates identity through WhitelistPolicy (curated lists or resolver-backed
 * groups such as stake-derived membership) while still routing admission through ChargebackPolicy,
 * so every take stays collateralized. Deposits that do not opt in keep V1 routing unchanged. All
 * callbacks remain fail-closed, and ChargebackPolicy's lifecycle-hook trust notes apply unchanged:
 * governance must authorize this hook there before configuring it on an orchestrator and must keep
 * predecessor hooks authorized until every intent snapshotted to them has resolved.
 */
contract IntentLifecycleHookV2 is IIntentLifecycleHook {

    /* ============ Events ============ */

    event CollateralizedMembershipSet(
        address indexed escrow, uint256 indexed depositId, bool required, address setter
    );

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, address taker);
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IChargebackPolicy public immutable chargebackPolicy;

    /// @dev escrow => depositId => whether whitelist membership and chargeback collateral are both required.
    mapping(address => mapping(uint256 => bool)) public isCollateralizedMembershipRequired;

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        IWhitelistPolicy _whitelistPolicy,
        IChargebackPolicy _chargebackPolicy
    ) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));
        _validateDependency(address(_chargebackPolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
        chargebackPolicy = _chargebackPolicy;
    }

    /* ============ Deposit Configuration ============ */

    /**
     * @notice Opts a deposit in or out of collateralized-membership routing.
     * @dev Callable by the deposit's depositor or delegate. The flag is keyed by (escrow, depositId)
     * and only consulted for intents an admitted orchestrator signals against that escrow, so a
     * hostile escrow contract can only influence routing for its own deposits.
     * @param _escrow Escrow holding the deposit.
     * @param _depositId Deposit whose routing mode is configured.
     * @param _required Whether whitelist membership and chargeback collateral are both required.
     */
    function setCollateralizedMembership(address _escrow, uint256 _depositId, bool _required) external {
        if (_escrow == address(0)) revert ZeroAddress();

        IEscrowV2.Deposit memory deposit = IEscrowV2(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }

        isCollateralizedMembershipRequired[_escrow][_depositId] = _required;
        emit CollateralizedMembershipSet(_escrow, _depositId, _required, msg.sender);
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId);
        bool isTakerAllowed =
            isWhitelistEnabled && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.owner);

        if (isCollateralizedMembershipRequired[intent.escrow][intent.depositId]) {
            // Whitelist gates identity and the chargeback lane locks collateral; neither bypasses the other.
            if (isWhitelistEnabled && !isTakerAllowed) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.owner);
            }
            if (chargebackPolicy.isChargebackEnabled(intent.escrow, intent.depositId)) {
                chargebackPolicy.onIntentSignaled(
                    _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
                );
            }
            return;
        }

        // V1 routing: whitelist-allowed takers bypass staking.
        if (isTakerAllowed) {
            return;
        }
        if (chargebackPolicy.isChargebackEnabled(intent.escrow, intent.depositId)) {
            chargebackPolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
            );
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        chargebackPolicy.onIntentCancelled(_intentHash);
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        chargebackPolicy.onIntentSettled(_context.intentHash, _context.releaseAmount, _context.isManualRelease);
    }

    /* ============ Modifiers ============ */

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    /* ============ Internal Functions ============ */

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
