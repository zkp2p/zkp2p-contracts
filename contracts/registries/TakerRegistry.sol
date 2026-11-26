// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import { ITakerRegistry } from "../interfaces/ITakerRegistry.sol";

/**
 * @title TakerRegistry
 * @notice Records which wallets an attestor has verified as controlling a payment account, so a signal policy can
 * admit takers from on-chain state instead of a per-intent signature.
 * @dev The registry stores only the attestor's identity id. The attestor derives it from the account with a secret
 * it alone holds, bound to this chain, this registry and the payment method, so nothing here or in the events lets
 * anyone recover the account or test a guess against it. Wallets registered to one account on one method share an
 * identity id; that is what lets a policy limit the account rather than the wallet.
 * @dev The attestor proves control of the account, not of the wallet a statement names. Only that wallet may submit
 * the statement, so nobody can bind another wallet to an account of their own.
 * @dev Swapping this registry rotates the EIP-712 domain (it binds this contract's address) and empties every
 * registration. Policies are replaced around the registry, not the other way round.
 */
contract TakerRegistry is ITakerRegistry, Ownable2Step, EIP712 {
    /* ============ Constants ============ */

    bytes32 public constant TAKER_REGISTRATION_TYPEHASH = keccak256(
        "TakerRegistration(address wallet,bytes32 method,bytes32 identityId,uint64 issuedAt,uint64 validUntil)"
    );

    /* ============ State Variables ============ */

    mapping(address => mapping(bytes32 => Registration)) internal registrations;   // wallet => method
    mapping(bytes32 => bool) public override isRevoked;                            // identityId
    mapping(address => AttestorStatus) public attestorStatus;                      // Signers of registration statements
    address public revoker;                                                        // May revoke identities

    /* ============ Constructor ============ */

    constructor(address _owner, address _revoker) EIP712("ZKP2P TakerRegistry", "1") {
        if (_owner == address(0)) revert ZeroAddress();
        revoker = _revoker;
        _transferOwnership(_owner);
    }

    /* ============ External Functions ============ */

    /**
     * @inheritdoc ITakerRegistry
     * @dev Replaces the wallet's registration on that method, including a move to another account.
     */
    function register(TakerRegistration calldata _registration, bytes calldata _signature) external override {
        if (msg.sender != _registration.wallet) revert UnauthorizedCaller(msg.sender, _registration.wallet);
        if (_registration.validUntil <= block.timestamp) {
            revert RegistrationExpired(_registration.validUntil, block.timestamp);
        }
        if (isRevoked[_registration.identityId]) revert IdentityIsRevoked(_registration.identityId);

        address attestor = ECDSA.recover(_hashTypedDataV4(_registrationStructHash(_registration)), _signature);
        if (attestorStatus[attestor] != AttestorStatus.Accepted) revert InvalidAttestor(attestor);

        registrations[msg.sender][_registration.method] = Registration({
            identityId: _registration.identityId, attestor: attestor, validUntil: _registration.validUntil
        });
        emit TakerRegistered(msg.sender, _registration.method, _registration.identityId, _registration.validUntil);
    }

    /// @inheritdoc ITakerRegistry
    function unregister(bytes32 _method) external override {
        Registration storage registration = registrations[msg.sender][_method];
        if (registration.validUntil == 0) revert NotRegistered(msg.sender, _method);

        registration.validUntil = 0;
        emit TakerUnregistered(msg.sender, _method);
    }

    /**
     * @inheritdoc ITakerRegistry
     * @dev REVOKER ONLY. An identity that never registered can be revoked ahead of time.
     */
    function revoke(bytes32[] calldata _identityIds) external override {
        if (msg.sender != revoker) revert UnauthorizedCaller(msg.sender, revoker);

        for (uint256 i = 0; i < _identityIds.length; i++) {
            isRevoked[_identityIds[i]] = true;
            emit IdentityRevoked(_identityIds[i]);
        }
    }

    /* ============ Governance Functions ============ */

    /**
     * @inheritdoc ITakerRegistry
     * @dev GOVERNANCE ONLY. Revoking is the revoker's; restoring an identity is not.
     */
    function reinstate(bytes32 _identityId) external override onlyOwner {
        isRevoked[_identityId] = false;
        emit IdentityReinstated(_identityId);
    }

    /**
     * @notice GOVERNANCE ONLY: Sets whether an attestor's statements register and whether the registrations it
     * signed still count. Retire a key that was rotated out; revoke one that can no longer be trusted.
     * @param _attestor   Signer of registration statements
     * @param _status     Its new status
     */
    function setAttestorStatus(address _attestor, AttestorStatus _status) external onlyOwner {
        if (_attestor == address(0)) revert ZeroAddress();

        attestorStatus[_attestor] = _status;
        emit AttestorStatusUpdated(_attestor, _status);
    }

    /**
     * @notice GOVERNANCE ONLY: Replaces the account that may revoke identities; zero leaves nobody able to.
     * @param _revoker   New revoker
     */
    function setRevoker(address _revoker) external onlyOwner {
        revoker = _revoker;
        emit RevokerUpdated(_revoker);
    }

    /**
     * @notice Disables ownership renunciation so attestors and revocations stay governable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /// @inheritdoc ITakerRegistry
    function requireRegistered(address _wallet, bytes32 _method) external view override returns (bytes32) {
        Registration memory registration = registrations[_wallet][_method];
        if (registration.validUntil == 0) revert NotRegistered(_wallet, _method);
        if (registration.validUntil <= block.timestamp) {
            revert RegistrationExpired(registration.validUntil, block.timestamp);
        }
        if (isRevoked[registration.identityId]) revert IdentityIsRevoked(registration.identityId);
        if (attestorStatus[registration.attestor] == AttestorStatus.Revoked) {
            revert AttestorIsRevoked(registration.attestor);
        }

        return registration.identityId;
    }

    /// @inheritdoc ITakerRegistry
    function getRegistration(address _wallet, bytes32 _method) external view override returns (Registration memory) {
        return registrations[_wallet][_method];
    }

    /* ============ Internal Functions ============ */

    function _registrationStructHash(TakerRegistration calldata _registration) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TAKER_REGISTRATION_TYPEHASH,
                _registration.wallet,
                _registration.method,
                _registration.identityId,
                _registration.issuedAt,
                _registration.validUntil
            )
        );
    }
}
