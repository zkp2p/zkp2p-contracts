// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "./IAddressGroupRegistry.sol";
import {IEscrowRegistry} from "./IEscrowRegistry.sol";
import {IOrchestratorRegistry} from "./IOrchestratorRegistry.sol";
import {IPreIntentHook} from "./IPreIntentHook.sol";

interface IWhitelistPolicy is IPreIntentHook {
    function groupRegistry() external view returns (IAddressGroupRegistry);
    function escrowRegistry() external view returns (IEscrowRegistry);
    function orchestratorRegistry() external view returns (IOrchestratorRegistry);
    function enabled(address escrow, uint256 depositId, bytes32 paymentMethod) external view returns (bool);
    function bootstrapped(address escrow, uint256 depositId, bytes32 paymentMethod) external view returns (bool);
    function isWhitelisted(address escrow, uint256 depositId, address taker) external view returns (bool);
    function getAllowedGroups(address escrow, uint256 depositId, bytes32 paymentMethod)
        external
        view
        returns (bytes32[] memory);
    function isGroupAllowed(address escrow, uint256 depositId, bytes32 paymentMethod, bytes32 groupId)
        external
        view
        returns (bool);
    function isTakerAllowed(address escrow, uint256 depositId, bytes32 paymentMethod, address taker)
        external
        view
        returns (bool);

    /**
     * @notice Bundles enabling/disabling a deposit payment method's gate with appending groups and takers.
     * @dev `enabled` REPLACES the payment method's current enforcement switch. `groupIds` are APPENDED to that
     * payment method's allowed-group list, while `takers` are APPENDED to the deposit-wide direct whitelist; this
     * call never removes or clears either list. Passing `enabled = false` disables enforcement for this payment
     * method even while appending new groups or takers. Use `setEnabled` alone to toggle the gate without touching
     * the lists.
     * @param escrow Whitelisted Escrow or EscrowV2 holding the deposit.
     * @param depositId Deposit to configure.
     * @param paymentMethod Payment method whose enforcement and group settings are configured.
     * @param enabled New value for the deposit payment method's enforcement switch; replaces the prior value.
     * @param groupIds Curated group ids to append to the deposit payment method's allowed groups.
     * @param takers Addresses to append to the deposit's direct whitelist.
     */
    function configureDeposit(
        address escrow,
        uint256 depositId,
        bytes32 paymentMethod,
        bool enabled,
        bytes32[] calldata groupIds,
        address[] calldata takers
    ) external;

    /**
     * @notice Updates the escrow registry used to authorize deposit configuration.
     * @dev Governance-only (owner). The new registry must be a non-zero address with deployed code, else this call
     * reverts. This value MUST be kept in sync with the orchestrator's escrow registry
     * (`OrchestratorV2.setEscrowRegistry`), because if they diverge, deposits on an escrow admitted by only one
     * registry can be neither gated nor revoked here while the orchestrator keeps admitting intents for them.
     * @param escrowRegistry New escrow registry used to authorize deposit configuration.
     */
    function setEscrowRegistry(IEscrowRegistry escrowRegistry) external;

    /**
     * @notice One-time governance bootstrap that enables one payment method on existing deposits for supplied groups.
     * @dev Reverts atomically unless every deposit exists on the whitelisted escrow and the selected payment method
     * is disabled and has never been bootstrapped. Both arrays must be non-empty. Depositors retain normal control
     * over the resulting policy, but disabling or removing groups does not clear the permanent bootstrap marker.
     * @param escrow Whitelisted Escrow or EscrowV2 holding the deposits.
     * @param depositIds Existing deposits to bootstrap.
     * @param paymentMethod Payment method to configure on every deposit.
     * @param groupIds Existing curated group ids to append to every deposit payment method.
     */
    function bootstrapDeposits(
        address escrow,
        uint256[] calldata depositIds,
        bytes32 paymentMethod,
        bytes32[] calldata groupIds
    ) external;

    function setEnabled(address escrow, uint256 depositId, bytes32 paymentMethod, bool enabled) external;
    function addWhitelistedAddresses(address escrow, uint256 depositId, address[] calldata takers) external;
    function removeWhitelistedAddresses(address escrow, uint256 depositId, address[] calldata takers) external;
    function addAllowedGroups(address escrow, uint256 depositId, bytes32 paymentMethod, bytes32[] calldata groupIds)
        external;
    function removeAllowedGroups(address escrow, uint256 depositId, bytes32 paymentMethod, bytes32[] calldata groupIds)
        external;
}
