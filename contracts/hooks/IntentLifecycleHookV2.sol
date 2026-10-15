// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IIntentLifecycleHookV2} from "../interfaces/IIntentLifecycleHookV2.sol";
import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV4} from "../interfaces/IOrchestratorV4.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {IEscrowV2} from "../interfaces/IEscrowV2.sol";

/// @notice Routes whitelist admission and cascade settlement for compatible registered orchestrators.
/// @dev Governance must drain outstanding intents before deregistering an orchestrator.
/// V2-only selectors (onIntentSignaled(bytes32,bytes) and the V2 SettlementContext) make OrchestratorV3
/// revert at signal, so it can never snapshot this hook. The cancellation callback is an unrestricted
/// no-op retained for future hooks.
/// Registered orchestrators calling these callbacks must honour the deferral vault returned by settleIntent;
/// registering an orchestrator is a governance assertion of that obligation.
/// Stateless by design: per-intent hook data is stored by the orchestrator, never by this hook.
/// Hook data is the raw 32-byte conditions hash, or empty for no conditions. bytes32(data) reads the
/// first word, right-padding shorter data; empty and all-zero data are unconditioned. There is no
/// length or version decoding: the conditions version lives in the attestor-side hash preimage,
/// and each intent's data is interpreted only by its snapshotted hook.
/// Non-manual settlements require extension word 0: disputeWindow in seconds, bounded by 180 days.
/// After window and conditions validation, zero windows and whitelisted takers pay now without any
/// policy call, record or event. Nonzero windows otherwise select collateral.
/// Whitelist state is read live only for nonzero windows: disabling it or removing the taker restores
/// the cascade. Relayer registration alone does not bypass collateral.
/// Whitelisting the recipient does not qualify. Manual releases skip the policy and attestation checks.
/// At signal, only whitelist admission and the conditions gating-service requirement are checked.
contract IntentLifecycleHookV2 is ERC165, IIntentLifecycleHookV2 {
    /// @dev Matches DisputeProtectionPolicyV2.MAX_RISK_WINDOW; validation precedes uint64 narrowing.
    uint256 private constant MAX_RISK_WINDOW = 180 days;

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputeProtectionPolicyV2 public immutable disputeProtectionPolicy;

    /* ============ Errors ============ */

    error MissingDisputeWindow();
    error InvalidDisputeWindow(uint256 window);
    error ConditionsNotAttested(bytes32 intentHash);
    error ConditionsRequireGatingService();
    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error IntentNotFound(bytes32 intentHash);
    error TakerNotWhitelisted(address escrow, uint256 depositId, bytes32 paymentMethod, address taker);

    /* ============ Constructor ============ */

    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        IWhitelistPolicy _whitelistPolicy,
        IDisputeProtectionPolicyV2 _disputeProtectionPolicy
    ) {
        _validateDependency(address(_orchestratorRegistry));
        _validateDependency(address(_whitelistPolicy));
        _validateDependency(address(_disputeProtectionPolicy));

        orchestratorRegistry = _orchestratorRegistry;
        whitelistPolicy = _whitelistPolicy;
        disputeProtectionPolicy = _disputeProtectionPolicy;
    }

    /* ============ Lifecycle Callbacks ============ */

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _data) external view override onlyOrchestrator {
        IOrchestratorV4.Intent memory intent = IOrchestratorV4(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        if (
            whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod)
                && !whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner)
        ) {
            revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        }
        if (
            bytes32(_data) != bytes32(0)
                && IEscrowV2(intent.escrow).getDepositGatingService(intent.depositId, intent.paymentMethod) == address(0)
        ) {
            revert ConditionsRequireGatingService();
        }
    }

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function onIntentCancelled(bytes32) external pure override {}

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function settleIntent(SettlementContext calldata _context)
        external override onlyOrchestrator returns (address deferralVault)
    {
        if (_context.isManualRelease) return address(0);
        if (_context.extensionData.length < 32) revert MissingDisputeWindow();
        uint256 window = abi.decode(_context.extensionData[:32], (uint256));
        if (window > MAX_RISK_WINDOW) revert InvalidDisputeWindow(window);
        bytes32 expected = bytes32(_context.data);
        bytes32 attested = _context.extensionData.length >= 64
            ? abi.decode(_context.extensionData[32:64], (bytes32)) : bytes32(0);
        if (attested != expected) revert ConditionsNotAttested(_context.intentHash);
        if (window == 0) return address(0);
        if (
            whitelistPolicy.enabled(_context.escrow, _context.depositId, _context.paymentMethod)
                && whitelistPolicy.isTakerAllowed(
                    _context.escrow, _context.depositId, _context.paymentMethod, _context.taker
                )
        ) return address(0);
        bool deferred = disputeProtectionPolicy.onIntentSettled(IDisputeProtectionPolicyV2.SettleParams({
            intentHash: _context.intentHash,
            taker: _context.taker,
            recipient: _context.recipient,
            depositor: _context.depositor,
            token: _context.token,
            paymentMethod: _context.paymentMethod,
            releaseAmount: _context.releaseAmount,
            netAmount: _context.netAmount,
            riskWindow: uint64(window)
        }));
        return deferred ? address(disputeProtectionPolicy.stakeVault()) : address(0);
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function onDeferredPayoutFunded(bytes32 _intentHash) external override onlyOrchestrator {
        disputeProtectionPolicy.onDeferredPayoutFunded(_intentHash);
    }

    /// @notice Reports ERC-165 and IIntentLifecycleHookV2 support.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IIntentLifecycleHookV2).interfaceId || super.supportsInterface(interfaceId);
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
