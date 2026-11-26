// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title ITakerRegistry
 * @notice Registry of takers whose control of a payment account an attestor has verified.
 */
interface ITakerRegistry {
    /* ============ Structs ============ */

    /// @notice Attestor-signed statement that `wallet` controls one payment account on `method`.
    struct TakerRegistration {
        address wallet;        // Taker the statement registers
        bytes32 method;        // Payment method hash the account belongs to
        bytes32 identityId;    // Attestor's keyed hash of the account; stable per account, opaque to everyone else
        uint64 issuedAt;       // When the attestor verified the account, in seconds
        uint64 validUntil;     // When the registration lapses, in seconds
    }

    struct Registration {
        bytes32 identityId;    // Zero when the wallet never registered on the method
        uint64 issuedAt;       // Kept after unregistering so an older statement cannot be replayed
        uint64 validUntil;     // Zero after unregistering
    }

    /* ============ Events ============ */

    event TakerRegistered(address indexed wallet, bytes32 indexed method, bytes32 indexed identityId, uint64 validUntil);
    event TakerUnregistered(address indexed wallet, bytes32 indexed method);
    event IdentityRevoked(bytes32 indexed identityId);
    event IdentityReinstated(bytes32 indexed identityId);
    event AttestorUpdated(address indexed attestor, bool accepted);
    event RevokerUpdated(address indexed revoker);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCaller(address caller, address authorized);
    error InvalidAttestor(address signer);
    error RegistrationExpired(uint256 validUntil, uint256 currentTime);
    error StaleRegistration(uint256 issuedAt, uint256 latestIssuedAt);
    error IdentityIsRevoked(bytes32 identityId);
    error NotRegistered(address wallet, bytes32 method);
    error OwnershipRenunciationDisabled();

    /* ============ External Functions ============ */

    /// @notice Records an attestor-signed registration. Anyone may submit it; it binds only the wallet it names.
    function register(TakerRegistration calldata registration, bytes calldata signature) external;

    /// @notice Removes the caller's registration on a method.
    function unregister(bytes32 method) external;

    /// @notice Revokes identities: their registrations stop counting and they cannot register again.
    function revoke(bytes32[] calldata identityIds) external;

    /// @notice Lifts a revocation.
    function reinstate(bytes32 identityId) external;

    /* ============ View Functions ============ */

    /// @notice The wallet's latest registration on a method, whether or not it still counts.
    function getRegistration(address wallet, bytes32 method) external view returns (Registration memory);

    /// @notice Whether the identity is revoked.
    function isRevoked(bytes32 identityId) external view returns (bool);
}
