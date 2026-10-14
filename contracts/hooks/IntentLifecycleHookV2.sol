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
    error IntentNotFound(bytes32 intentHash);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error LifecycleHookNotAuthorized(address hook);
    error AdmissionsPaused();
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
        if (disputeProtectionPolicy.getRiskWindow(intent.paymentMethod) != 0) {
            address expectedToken = address(disputeProtectionPolicy.stakeVault().stakeToken());
            address actualToken = address(IEscrowV2(intent.escrow).getDeposit(intent.depositId).token);
            if (actualToken != expectedToken) revert IntentTokenMismatch(expectedToken, actualToken);
            if (!disputeProtectionPolicy.isLifecycleHookAuthorized(address(this))) {
                revert LifecycleHookNotAuthorized(address(this));
            }
            if (disputeProtectionPolicy.admissionsPaused()) revert AdmissionsPaused();
        }
        if (
            _conditionsHashOf(_data) != bytes32(0)
                && IEscrowV2(intent.escrow).getDepositGatingService(intent.depositId, intent.paymentMethod) == address(0)
        ) {
            revert ConditionsRequireGatingService();
        }
    }

    /// @notice Decodes the v1 conditions hash, returning zero for empty data and reverting on malformed data.
    /// @dev Off-chain convenience; not part of the lifecycle hook interface OrchestratorV4 checks.
    function conditionsHashOf(bytes calldata _data) external pure returns (bytes32) {
        return _conditionsHashOf(_data);
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
        bytes32 expected = _conditionsHashOf(_context.data);
        bool bypass;
        if (!_context.isManualRelease) {
            uint256 flag = _context.extensionData.length >= 32
                ? abi.decode(_context.extensionData[:32], (uint256)) : 0;
            if (flag > 1) revert InvalidBalanceFundedFlag(flag);
            bytes32 attested = _context.extensionData.length >= 64
                ? abi.decode(_context.extensionData[32:64], (bytes32)) : bytes32(0);
            if (attested != expected) revert ConditionsNotAttested(_context.intentHash);
            bypass = flag == 1
                || IOrchestratorV4(msg.sender).relayerRegistry().isWhitelistedRelayer(_context.taker);
        }
        bool deferred = disputeProtectionPolicy.onIntentSettled(IDisputeProtectionPolicyV2.SettleParams({
            intentHash: _context.intentHash,
            taker: _context.taker,
            recipient: _context.recipient,
            escrow: _context.escrow,
            depositId: _context.depositId,
            paymentMethod: _context.paymentMethod,
            releaseAmount: _context.releaseAmount,
            netAmount: _context.netAmount,
            bypass: bypass,
            isManualRelease: _context.isManualRelease
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

    function _conditionsHashOf(bytes calldata _data) internal pure returns (bytes32) {
        if (_data.length == 0) return bytes32(0);
        if (_data.length != 64) revert InvalidLifecycleHookData();
        // Decode the full version word so noncanonical uint8 encodings also use the custom error.
        (uint256 version, bytes32 conditionsHash) = abi.decode(_data, (uint256, bytes32));
        if (version != 1 || conditionsHash == bytes32(0)) revert InvalidLifecycleHookData();
        return conditionsHash;
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidDependency(_dependency);
    }
}
