// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IIdentityRegistry } from "../interfaces/IIdentityRegistry.sol";

/**
 * @title IdentityRegistry
 * @notice Registers unique platform identities from the existing Attestor identity EIP-712 payload.
 * @dev Identity bindings are intentionally non-transferable. Governance can deactivate a compromised
 *      binding, but its platform identifier remains burned so reputation cannot be reset onto a new wallet.
 */
contract IdentityRegistry is Ownable, IIdentityRegistry {
    using SignatureChecker for address;

    bytes32 public constant IDENTITY_TYPEHASH = keccak256(
        "IdentityAttestation(bytes32 method,bytes32 actionType,address callerAddress,bytes32 payeeIdHash,bytes32 dataHash,uint256 issuedAt,uint256 validUntil)"
    );
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version)");
    bytes32 public constant DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("ZKP2PIdentityVerifier"),
            keccak256("1")
        )
    );
    uint256 public constant MAX_FUTURE_ISSUANCE_MS = 5 minutes * 1_000;
    uint256 public constant MAX_IDENTITIES_PER_ACCOUNT = 16;

    mapping(address => bool) public trustedAttestors;
    mapping(bytes32 => bool) public acceptedActionTypes;
    mapping(bytes32 => address) private identityOwners;
    mapping(bytes32 => bool) public activeIdentities;
    mapping(address => uint256) public activeIdentityCount;
    mapping(address => bool) private quarantinedAccounts;
    mapping(address => bytes32) private accountNodes;
    mapping(address => bytes32[]) private accountIdentities;

    event TrustedAttestorUpdated(address indexed attestor, bool trusted);
    event AcceptedActionTypeUpdated(bytes32 indexed actionType, bool accepted);
    event IdentityRegistered(
        bytes32 indexed identityKey,
        address indexed account,
        bytes32 indexed method,
        bytes32 payeeIdHash,
        bytes32 actionType,
        bytes32 dataHash
    );
    event IdentityStatusUpdated(bytes32 indexed identityKey, address indexed account, bool active);
    event AccountQuarantineUpdated(address indexed account, bool quarantined);

    error ZeroAddress();
    error InvalidIdentity();
    error UntrustedAttestor(address attestor);
    error UnsupportedActionType(bytes32 actionType);
    error InvalidAttestationTime(uint256 issuedAtMs, uint256 validUntilMs, uint256 currentTimeMs);
    error InvalidAttestationSignature();
    error UnauthorizedAccount(address caller, address attestedAccount);
    error IdentityAlreadyBound(bytes32 identityKey, address account);
    error IdentityNotFound(bytes32 identityKey);
    error IdentityAlreadyInState(bytes32 identityKey, bool active);
    error TooManyAccountIdentities(address account);
    error AccountAlreadyInQuarantineState(address account, bool quarantined);

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        transferOwnership(owner_);
    }

    /** @notice Adds or removes an Attestor signing key. Use a multisig/timelock as owner in production. */
    function setTrustedAttestor(address attestor, bool trusted) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        trustedAttestors[attestor] = trusted;
        emit TrustedAttestorUpdated(attestor, trusted);
    }

    /** @notice Restricts portable Attestor payloads to explicit identity-registration actions. */
    function setAcceptedActionType(bytes32 actionType, bool accepted) external onlyOwner {
        if (actionType == bytes32(0)) revert InvalidIdentity();
        acceptedActionTypes[actionType] = accepted;
        emit AcceptedActionTypeUpdated(actionType, accepted);
    }

    /**
     * @notice Registers a unique platform identity from an Attestor-signed EIP-712 payload.
     * @dev The attested wallet must submit its own registration. This prevents infrastructure or
     *      a stale payload holder from publishing a permanent wallet-to-platform binding.
     */
    function registerIdentity(
        IdentityAttestation calldata attestation,
        address attestor,
        bytes calldata signature
    ) external override returns (bytes32 identityKey) {
        if (!trustedAttestors[attestor]) revert UntrustedAttestor(attestor);
        if (msg.sender != attestation.account) {
            revert UnauthorizedAccount(msg.sender, attestation.account);
        }
        if (
            attestation.account == address(0)
                || attestation.method == bytes32(0)
                || attestation.actionType == bytes32(0)
                || attestation.payeeIdHash == bytes32(0)
                || attestation.dataHash == bytes32(0)
        ) revert InvalidIdentity();
        if (!acceptedActionTypes[attestation.actionType]) {
            revert UnsupportedActionType(attestation.actionType);
        }

        uint256 currentTimeMs = block.timestamp * 1_000;
        if (
            attestation.issuedAtMs > currentTimeMs + MAX_FUTURE_ISSUANCE_MS
                || attestation.validUntilMs < currentTimeMs
                || attestation.validUntilMs < attestation.issuedAtMs
        ) {
            revert InvalidAttestationTime(attestation.issuedAtMs, attestation.validUntilMs, currentTimeMs);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                IDENTITY_TYPEHASH,
                attestation.method,
                attestation.actionType,
                attestation.account,
                attestation.payeeIdHash,
                attestation.dataHash,
                attestation.issuedAtMs,
                attestation.validUntilMs
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (!attestor.isValidSignatureNow(digest, signature)) revert InvalidAttestationSignature();

        identityKey = keccak256(abi.encode(attestation.method, attestation.payeeIdHash));
        address existingOwner = identityOwners[identityKey];
        if (existingOwner != address(0)) revert IdentityAlreadyBound(identityKey, existingOwner);

        identityOwners[identityKey] = attestation.account;
        activeIdentities[identityKey] = true;
        activeIdentityCount[attestation.account] += 1;
        if (accountIdentities[attestation.account].length >= MAX_IDENTITIES_PER_ACCOUNT) {
            revert TooManyAccountIdentities(attestation.account);
        }
        accountIdentities[attestation.account].push(identityKey);
        if (accountNodes[attestation.account] == bytes32(0)) {
            accountNodes[attestation.account] = identityKey;
        }

        emit IdentityRegistered(
            identityKey,
            attestation.account,
            attestation.method,
            attestation.payeeIdHash,
            attestation.actionType,
            attestation.dataHash
        );
    }

    /**
     * @notice Deactivates or reactivates a known identity without freeing its unique identifier.
     * @dev This is an emergency safety valve, not a reputation reset or transfer mechanism.
     */
    function setIdentityStatus(bytes32 identityKey, bool active) external onlyOwner {
        address account = identityOwners[identityKey];
        if (account == address(0)) revert IdentityNotFound(identityKey);
        if (activeIdentities[identityKey] == active) revert IdentityAlreadyInState(identityKey, active);

        activeIdentities[identityKey] = active;
        if (active) {
            activeIdentityCount[account] += 1;
            if (accountNodes[account] == bytes32(0)) accountNodes[account] = identityKey;
        } else {
            activeIdentityCount[account] -= 1;
            if (accountNodes[account] == identityKey) {
                accountNodes[account] = _findActiveAccountNode(account, identityKey);
            }
        }
        emit IdentityStatusUpdated(identityKey, account, active);
    }

    /**
     * @notice Quarantines a wallet without deleting its identity bindings or reputation history.
     * @dev Use this when a primary identity is proven fraudulent or compromised. Unquarantining
     *      is explicit so rotating to another already-bound identity cannot bypass the response.
     */
    function setAccountQuarantine(address account, bool quarantined) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (quarantinedAccounts[account] == quarantined) {
            revert AccountAlreadyInQuarantineState(account, quarantined);
        }
        quarantinedAccounts[account] = quarantined;
        emit AccountQuarantineUpdated(account, quarantined);
    }

    function isVerifiedAccount(address account) external view override returns (bool) {
        return activeIdentityCount[account] > 0 && !quarantinedAccounts[account];
    }

    function isQuarantined(address account) external view override returns (bool) {
        return quarantinedAccounts[account];
    }

    function getAccountNode(address account) external view override returns (bytes32) {
        bytes32 node = accountNodes[account];
        return activeIdentityCount[account] > 0 && activeIdentities[node] ? node : bytes32(0);
    }

    function getIdentityOwner(bytes32 method, bytes32 payeeIdHash) external view override returns (address) {
        bytes32 identityKey = keccak256(abi.encode(method, payeeIdHash));
        return activeIdentities[identityKey] ? identityOwners[identityKey] : address(0);
    }

    function getAccountIdentities(address account) external view returns (bytes32[] memory) {
        return accountIdentities[account];
    }

    function _findActiveAccountNode(address account, bytes32 excludedIdentity) internal view returns (bytes32) {
        bytes32[] storage identities = accountIdentities[account];
        for (uint256 i = 0; i < identities.length; ++i) {
            bytes32 candidate = identities[i];
            if (candidate != excludedIdentity && activeIdentities[candidate]) return candidate;
        }
        return bytes32(0);
    }
}
