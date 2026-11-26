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
    mapping(address => bool) public isAttestor;                                    // Signers whose statements register
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
     * @dev A newer statement replaces the wallet's registration on that method, including a move to another account.
     * Statements apply in the order the attestor issued them, so an older one cannot undo a newer registration or an
     * unregistration.
     */
    function register(TakerRegistration calldata _registration, bytes calldata _signature) external override {
        if (_registration.validUntil <= block.timestamp) {
            revert RegistrationExpired(_registration.validUntil, block.timestamp);
        }
        if (isRevoked[_registration.identityId]) revert IdentityIsRevoked(_registration.identityId);

        Registration storage registration = registrations[_registration.wallet][_registration.method];
        if (_registration.issuedAt <= registration.issuedAt) {
            revert StaleRegistration(_registration.issuedAt, registration.issuedAt);
        }

        address signer = ECDSA.recover(_hashTypedDataV4(_registrationStructHash(_registration)), _signature);
        if (!isAttestor[signer]) revert InvalidAttestor(signer);

        registration.identityId = _registration.identityId;
        registration.issuedAt = _registration.issuedAt;
        registration.validUntil = _registration.validUntil;

        emit TakerRegistered(
            _registration.wallet, _registration.method, _registration.identityId, _registration.validUntil
        );
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
     * @notice GOVERNANCE ONLY: Accepts or stops accepting an attestor's registration statements. Registrations it
     * already signed stay recorded.
     * @param _attestor   Signer of registration statements
     * @param _accepted   Whether its statements register
     */
    function setAttestor(address _attestor, bool _accepted) external onlyOwner {
        if (_attestor == address(0)) revert ZeroAddress();

        isAttestor[_attestor] = _accepted;
        emit AttestorUpdated(_attestor, _accepted);
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
