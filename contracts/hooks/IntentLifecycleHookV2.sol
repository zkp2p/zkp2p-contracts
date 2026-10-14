// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IIntentLifecycleHookV2} from "../interfaces/IIntentLifecycleHookV2.sol";
import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IOrchestratorRegistry} from "../interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV4} from "../interfaces/IOrchestratorV4.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {IEscrow} from "../interfaces/IEscrow.sol";

/// @notice Routes whitelist admission and cascade settlement for compatible registered orchestrators.
/// @dev Governance must drain outstanding intents before deregistering an orchestrator.
/// Stateless by design: per-intent hook data is stored by the orchestrator, never by this hook.
/// V1 hook data is abi.encode(uint8(1), bytes32 conditionsHash), exactly 64 bytes with a nonzero hash.
contract IntentLifecycleHookV2 is ERC165, IIntentLifecycleHookV2 {
    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IWhitelistPolicy public immutable whitelistPolicy;
    IDisputeProtectionPolicyV2 public immutable disputeProtectionPolicy;

    /* ============ Errors ============ */

    error InvalidBalanceFundedFlag(uint256 value);
    error ConditionsNotAttested(bytes32 intentHash);
    error InvalidLifecycleHookData();
    error ConditionsRequireGatingService();
    error ZeroAddress();
    error InvalidDependency(address dependency);
    error UnauthorizedOrchestrator(address caller);
    error UnsupportedOrchestrator(address caller);
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
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _lifecycleHookData) external override onlyOrchestrator {
        // O3 ignores the vault returned by settleIntent and pays intent.to directly.
        // Deferred settlement would stay AWAITING_FUNDING with no lock, silently removing seller dispute protection.
        // Only V4-compatible orchestrators may use this hook.
        if (!ERC165Checker.supportsInterface(msg.sender, type(IOrchestratorV4).interfaceId)) {
            revert UnsupportedOrchestrator(msg.sender);
        }
        IOrchestratorV4.Intent memory intent = IOrchestratorV4(msg.sender).getIntent(_intentHash);
        if (intent.owner == address(0)) revert IntentNotFound(_intentHash);

        bool isWhitelistEnabled = whitelistPolicy.enabled(intent.escrow, intent.depositId, intent.paymentMethod);
        bool isWhitelisted = isWhitelistEnabled
            && whitelistPolicy.isTakerAllowed(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
        if (!isWhitelisted) {
            if (disputeProtectionPolicy.isDisputeProtectionEnabled(intent.escrow, intent.depositId, intent.paymentMethod)) {
                disputeProtectionPolicy.onIntentSignaled(
                    _intentHash, intent.escrow, intent.depositId, intent.owner, intent.paymentMethod, intent.to
                );
            } else if (isWhitelistEnabled) {
                revert TakerNotWhitelisted(intent.escrow, intent.depositId, intent.paymentMethod, intent.owner);
            }
        }
        if (
            _conditionsHashOf(_lifecycleHookData) != bytes32(0)
                && IEscrow(intent.escrow).getDepositGatingService(intent.depositId, intent.paymentMethod) == address(0)
        ) {
            revert ConditionsRequireGatingService();
        }
    }

    /// @inheritdoc IIntentLifecycleHookV2
    function conditionsHashOf(bytes calldata _lifecycleHookData) external pure override returns (bytes32) {
        return _conditionsHashOf(_lifecycleHookData);
    }

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function onIntentCancelled(bytes32 _intentHash) external override onlyOrchestrator {
        disputeProtectionPolicy.onIntentCancelled(_intentHash);
    }

    /**
     * @inheritdoc IIntentLifecycleHookV2
     */
    function settleIntent(SettlementContext calldata _context)
        external override onlyOrchestrator returns (address deferralVault)
    {
        bytes32 expected = _conditionsHashOf(_context.lifecycleHookData);
        bool balanceFunded;
        if (!_context.isManualRelease) {
            uint256 flag = _context.extensionData.length >= 32
                ? abi.decode(_context.extensionData[:32], (uint256)) : 0;
            if (flag > 1) revert InvalidBalanceFundedFlag(flag);
            balanceFunded = flag == 1;
            bytes32 attested = _context.extensionData.length >= 64
                ? abi.decode(_context.extensionData[32:64], (bytes32)) : bytes32(0);
            if (attested != expected) revert ConditionsNotAttested(_context.intentHash);
        }
        bool deferred = disputeProtectionPolicy.onIntentSettled(
            _context.intentHash, _context.releaseAmount, _context.netAmount,
            balanceFunded, _context.isManualRelease
        );
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

    function _conditionsHashOf(bytes calldata _lifecycleHookData) internal pure returns (bytes32) {
        if (_lifecycleHookData.length == 0) return bytes32(0);
        if (_lifecycleHookData.length != 64) revert InvalidLifecycleHookData();
        // Decode the full version word so noncanonical uint8 encodings also use the custom error.
        (uint256 version, bytes32 conditionsHash) = abi.decode(_lifecycleHookData, (uint256, bytes32));
        if (version != 1 || conditionsHash == bytes32(0)) revert InvalidLifecycleHookData();
        return conditionsHash;
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
