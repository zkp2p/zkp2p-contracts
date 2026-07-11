// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IIdentityRegistry
 * @notice Public registry of TEE-attested, platform-unique protocol identities.
 */
interface IIdentityRegistry {
    struct IdentityAttestation {
        bytes32 method;
        bytes32 actionType;
        address account;
        bytes32 payeeIdHash;
        bytes32 dataHash;
        uint256 issuedAtMs;
        uint256 validUntilMs;
    }

    function registerIdentity(
        IdentityAttestation calldata attestation,
        address attestor,
        bytes calldata signature
    ) external returns (bytes32 identityKey);

    function isVerifiedAccount(address account) external view returns (bool);
    function isQuarantined(address account) external view returns (bool);
    function getAccountNode(address account) external view returns (bytes32);
    function getIdentityOwner(bytes32 method, bytes32 payeeIdHash) external view returns (address);
}
