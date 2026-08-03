// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IIntentLifecycleHook} from "../interfaces/IIntentLifecycleHook.sol";
import {IChargebackPolicy} from "../interfaces/IChargebackPolicy.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "../interfaces/IOrchestratorV3.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";

/**
 * @title IntentLifecycleHookV1
 * @notice Lifecycle hook combining deposit-scoped whitelist admission with optional stake-backed chargeback coverage.
 * Whitelisted takers bypass staking; non-whitelisted takers may be admitted through a chargeback-enabled deposit.
 * Non-chargebackable payment methods give every taker direct access without a chargeback intent or stake lock, regardless of
 * whitelist state. Open deposits remain unrestricted when neither policy is enabled.
 * @dev Reads canonical intent data from the calling orchestrator. WhitelistPolicy must be initialized before admission;
 * ChargebackPolicy is optional and may be initialized later to extend whitelist-only admission. Cancellation and
 * settlement accounting are forwarded only for intents admitted through ChargebackPolicy. All callbacks remain
 * fail-closed. This hook serves every registered orchestrator and forwards lifecycle callbacks without provenance
 * checks; the trust argument lives in ChargebackPolicy's header.
 * Deregistering an orchestrator with unresolved intents snapshotted to this hook permanently blocks their terminal
 * callbacks, so governance must drain its intents before removing it from OrchestratorRegistry.
 */
contract IntentLifecycleHookV1 is IIntentLifecycleHook, Ownable {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public whitelistPolicy;
    IChargebackPolicy public chargebackPolicy;

    /// @notice Whether an intent was successfully admitted through the configured chargeback policy.
    mapping(bytes32 => bool) public isChargebackIntent;

    /* ============ Events ============ */

    event WhitelistPolicyInitialized(address indexed whitelistPolicy);
    event ChargebackPolicyInitialized(address indexed chargebackPolicy);

    /* ============ Errors ============ */

    error ZeroAddress();
    error InvalidDependency(address dependency);
    error WhitelistPolicyNotInitialized();
    error WhitelistPolicyAlreadyInitialized(address whitelistPolicy);
    error ChargebackPolicyAlreadyInitialized(address chargebackPolicy);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, address taker);

    /* ============ Constructor ============ */

    /**
     * @notice Creates a lifecycle hook whose policies can be initialized after its address is known.
     * @dev Whitelist admission remains fail-closed until `initializeWhitelistPolicy` succeeds. Chargeback admission
     * remains disabled until `initializeChargebackPolicy` succeeds.
     * @param _orchestratorRegistry Registry authorizing lifecycle callback callers.
     */
    constructor(IOrchestratorRegistry _orchestratorRegistry) Ownable() {
        _validateDependency(address(_orchestratorRegistry));

        orchestratorRegistry = _orchestratorRegistry;
    }

    /* ============ Policy Initialization ============ */

    /**
     * @notice GOVERNANCE ONLY: Initializes the whitelist policy used for every future admission.
     * @dev May succeed exactly once. Admission remains fail-closed while the policy is uninitialized.
     * @param _whitelistPolicy Non-zero deployed whitelist policy contract.
     */
    function initializeWhitelistPolicy(IWhitelistPolicy _whitelistPolicy) external onlyOwner {
        _validateDependency(address(_whitelistPolicy));
        if (address(whitelistPolicy) != address(0)) {
            revert WhitelistPolicyAlreadyInitialized(address(whitelistPolicy));
        }

        whitelistPolicy = _whitelistPolicy;
        emit WhitelistPolicyInitialized(address(_whitelistPolicy));
    }

    /**
     * @notice GOVERNANCE ONLY: Initializes the optional chargeback policy used for future admission.
     * @dev May succeed exactly once. Until initialized, the hook enforces whitelist policy alone and never forwards
     * terminal callbacks to a chargeback policy.
     * @param _chargebackPolicy Non-zero deployed chargeback policy contract.
     */
    function initializeChargebackPolicy(IChargebackPolicy _chargebackPolicy) external onlyOwner {
        _validateDependency(address(_chargebackPolicy));
        if (address(chargebackPolicy) != address(0)) {
            revert ChargebackPolicyAlreadyInitialized(address(chargebackPolicy));
        }

        chargebackPolicy = _chargebackPolicy;
        emit ChargebackPolicyInitialized(address(_chargebackPolicy));
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentSignaled(bytes32 _intentHash) external override onlyOrchestrator {
        IOrchestratorV3.Intent memory intent = IOrchestratorV3(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        IWhitelistPolicy currentWhitelistPolicy = whitelistPolicy;
        if (address(currentWhitelistPolicy) == address(0)) revert WhitelistPolicyNotInitialized();

        bool isWhitelistEnabled = currentWhitelistPolicy.enabled(intent.escrow, intent.depositId);
        if (isWhitelistEnabled && currentWhitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.owner))
        {
            return;
        }

        IChargebackPolicy currentChargebackPolicy = chargebackPolicy;
        // Chargeback admission is stateful, so the configuration query only selects the route.
        // onIntentSignaled remains authoritative for token compatibility, collateral, and pause checks.
        if (
            address(currentChargebackPolicy) != address(0)
                && currentChargebackPolicy.isChargebackEnabled(intent.escrow, intent.depositId)
        ) {
            currentChargebackPolicy.onIntentSignaled(
                _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.amount
            );
            isChargebackIntent[_intentHash] = true;
        } else if (isWhitelistEnabled) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.owner);
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        if (!isChargebackIntent[_intentHash]) return;

        chargebackPolicy.onIntentCancelled(_intentHash);
        delete isChargebackIntent[_intentHash];
    }

    /**
     * @inheritdoc IIntentLifecycleHook
     */
    function settleIntent(SettlementContext calldata _context) external override onlyOrchestrator {
        if (!isChargebackIntent[_context.intentHash]) return;

        chargebackPolicy.onIntentSettled(_context.intentHash, _context.releaseAmount, _context.isManualRelease);
        delete isChargebackIntent[_context.intentHash];
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
